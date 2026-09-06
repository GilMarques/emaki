import { Injectable, inject, signal } from '@angular/core';

import { PageFlip, type FlipSetting } from '../../vendor/page-flip';

import type { Book, Page } from '../models/book.model';
import type { ZoomMode } from '../models/settings.model';
import { BookstoreService } from './bookstore.service';
import { FilePageService } from './file-page.service';
import { ScanEnhancementService } from './scan-enhancement.service';

type NaturalSize = { readonly width: number; readonly height: number };
type LoadedImage = {
  readonly natural: NaturalSize;
  readonly image: HTMLImageElement | null;
};
type RenderedPages = {
  readonly urls: readonly string[];
  readonly logicalIndexByRenderedIndex: readonly number[];
  readonly renderedIndexByLogicalIndex: readonly number[];
};

/** Page-flip state machine values delivered by the lib's `changeState` event. */
export type FlipGestureState = 'user_fold' | 'fold_corner' | 'flipping' | 'read';

/**
 * Wraps a `page-flip` (StPageFlip) instance — owns its lifecycle, exposes
 * a tiny signal-based surface for the rest of the app, and turns the lib's
 * DOM-event API into something reactive.
 *
 * v1 only supports image-mode books (one image per page). HTML-mode
 * (EPUB) lands later; the lib supports it via `loadFromHTML`.
 *
 * Input routing:
 *  - Mounted with `useMouseEvents: false` so the lib never registers its
 *    own mousedown/touch listeners on the canvas.
 *  - The viewer `.stage` owns pointer events and relays page turns via
 *    `relayPointerDown/Move/Up` and `relayTap` (see PageFlip.startUserTouch).
 *  - This keeps the magnifier hold gesture and page-curl from fighting over
 *    the same pointerdown.
 *
 * Remount note: PageFlip.destroy() removes the host element from the DOM.
 * unmount() only tears down the lib UI so Angular's host ref stays attached.
 */
@Injectable({ providedIn: 'root' })
export class BookFlipService {
  private readonly bookstore = inject(BookstoreService);
  private readonly enhancement = inject(ScanEnhancementService);
  private readonly filePages = inject(FilePageService);

  private instance: PageFlip | null = null;
  private host: HTMLElement | null = null;
  private mountGeneration = 0;
  /** Id of the book mounted last, so we only preserve the page across
   *  layout/zoom remounts — a different book starts at its own progress. */
  private mountedBookId: string | null = null;
  private renderedIndexByLogicalIndex: readonly number[] = [];
  private logicalIndexByRenderedIndex: readonly number[] = [];
  /** URLs last handed to page-flip, so we can skip redundant reloads. */
  private loadedUrls: string[] = [];

  /** Latest page-flip state from the lib's `changeState` event. */
  private readonly _flipState = signal<FlipGestureState | null>(null);
  public readonly flipState = this._flipState.asReadonly();

  /** Reactive current page index (0-based), mirrored from the lib. */
  private readonly _currentIndex = signal(0);
  public readonly currentIndex = this._currentIndex.asReadonly();

  /** True while a PageFlip instance is mounted and ready. */
  private readonly _mounted = signal(false);
  public readonly mounted = this._mounted.asReadonly();

  /** Book-wide single-page size the lib is mounted with. Stable per mount and
   *  independent of which page is currently shown, so fit modes apply to the
   *  whole book and page turns never resize the canvas. */
  private readonly _bookPageSize = signal<{ width: number; height: number } | null>(null);
  public readonly bookPageSize = this._bookPageSize.asReadonly();

  /**
   * Mount a PageFlip instance on `host` and load all pages from `book`.
   * Destroys any previous instance first. Preserves the current page index
   * across remounts (layout / zoom changes).
   */
  public mount(
    host: HTMLElement,
    book: Book,
    layout: 'single' | 'double',
    zoom: ZoomMode = 'fit-screen',
  ): void {
    const sameBook = this.mountedBookId === book.id;
    const state = this.bookstore.state();
    const baseIndex = sameBook ? this._currentIndex() : state.book === null ? 0 : state.currentIndex;
    const pageIndex = Math.max(0, Math.min(baseIndex, book.pages.length - 1));
    this.mountedBookId = book.id;
    // Resolve each page to a loadable URL (web URL, or blob/asset URL for a real
    // filesystem book) — `page.url` alone is a raw fs path the canvas can't load.
    // Warm the blobs BEFORE page-flip mounts so it never receives a raw on-disk
    // path: an unloadable src leaves the lib stuck before the 'read' state,
    // which also blocks refreshImages() from ever swapping in the real blob.
    const generation = ++this.mountGeneration;
    const pageUrls = book.pages.map((page) => this.enhancement.displayUrlFor(page));
    if (pageUrls.length === 0) return;

    void Promise.all(pageUrls.map((u) => this.filePages.ensure(u).catch(() => null)))
      .then(() => book.pages.map((page) => this.enhancement.displayUrlFor(page)))
      .then((warmedUrls) => {
        if (generation !== this.mountGeneration) return; // a newer mount started
        if (warmedUrls.length === 0) return;
        this.mountWithUrls(host, book, warmedUrls, layout, zoom, pageIndex);
      });
  }

  /** Mount page-flip once every page resolves to a loadable (blob) URL. */
  private mountWithUrls(
    host: HTMLElement,
    book: Book,
    pageUrls: readonly string[],
    layout: 'single' | 'double',
    zoom: ZoomMode,
    pageIndex: number,
  ): void {
    this.unmount();
    this.host = host;
    this.resetHost(host);

    const generation = ++this.mountGeneration;

    void Promise.all(pageUrls.map((pageUrl) => this.loadImageNaturalSize(pageUrl))).then((loadedImages) => {
      if (generation !== this.mountGeneration || this.host !== host) return;
      if (!host.isConnected) return;

      // The host may have no size yet when the viewer just opened inside a
      // modal (layout/enter animation not done). Wait for it instead of
      // bailing — otherwise the canvas never mounts and the stage stays grey.
      waitForSize(host).then((size) => {
        if (size === null) return;
        if (generation !== this.mountGeneration || this.host !== host) return;
        const containerW = size.w;
        const containerH = size.h;

      const natural = loadedImages[0]?.natural ?? { width: 800, height: 1200 };
      const pageSize = computePageDimensions(containerW, containerH, natural, zoom, layout);
      const rendered = buildRenderedPages(book.pages, pageUrls, loadedImages, layout, pageSize);
      this.logicalIndexByRenderedIndex = rendered.logicalIndexByRenderedIndex;
      this.renderedIndexByLogicalIndex = rendered.renderedIndexByLogicalIndex;
      this._bookPageSize.set(pageSize);

      const settings: Partial<FlipSetting> = {
        width: pageSize.width,
        height: pageSize.height,
        startPage: this.renderedIndexByLogicalIndex[pageIndex] ?? 0,
        // A book's first page is always a standalone cover in landscape mode.
        showCover: true,
        showPageCorners: true,
        disableFlipByClick: false,
        ...(layout === 'single'
          ? { usePortrait: true }
          : { usePortrait: false }),
        startZIndex: 0,
        autoSize: false,
        drawShadow: true,
        flippingTime: 600,
        maxShadowOpacity: 0.5,
        // Viewer `.stage` relays pointer events; lib must not register its own.
        useMouseEvents: false,
      };

      const pf = new PageFlip(host, settings);
      // `rendered.urls` already holds displayUrlFor() results (blobs for
      // enhanced/fs pages, direct web URLs otherwise). Do NOT swap in
      // enhancedUriFor() here — that returns the raw on-disk path the canvas
      // can't load.
      const urls = [...rendered.urls];
      this.loadedUrls = urls;
      pf.loadFromImages(urls);

      pf.on('flip', (e) => {
        if (typeof e.data === 'number') {
          this.syncPageIndex(e.data);
        }
      });

      // Mirror the lib's state machine (user_fold → fold_corner → flipping → read)
      // so the viewer can gate gesture handling on it.
      pf.on('changeState', (e) => {
        const s = e.data;
        if (s === 'user_fold' || s === 'fold_corner' || s === 'flipping' || s === 'read') {
          this._flipState.set(s);
        }
      });

      this.instance = pf;
      this.syncPageIndex(pf.getCurrentPageIndex());
      this._mounted.set(true);
      });
    });
  }

  /** Tear down the current instance if any. Idempotent. Keeps the host in the DOM. */
  public unmount(): void {
    this.mountGeneration++;
    this._flipState.set(null);
    this._bookPageSize.set(null);
    this.logicalIndexByRenderedIndex = [];
    this.renderedIndexByLogicalIndex = [];
    if (this.instance === null) return;
    try {
      // Do NOT call PageFlip.destroy() — it removes the host from the DOM.
      this.instance.getUI().destroy();
    } catch {
      // destroy() can throw if the host was already detached. Swallow.
    }
    if (this.host !== null) {
      this.resetHost(this.host);
    }
    this.instance = null;
    this.host = null;
    this._mounted.set(false);
  }

  /** Tell the lib its container size changed (e.g. orientation flip). */
  public update(): void {
    this.instance?.update();
  }

  /**
   * Reload page images with the current display URLs (originals + any enhanced
   * derivatives that have completed). Only call when the reader is idle
   * (`flipState === 'read'`) — reloading mid-gesture would fight the user. The
   * current page index is preserved. No-op if nothing actually changed.
   *
   * This is the Phase-3 progressive-replacement path; the full per-page
   * replacement (vendored lib extension) lands later. Cost of a full reload is
   * why the viewer coalesces completions before calling this.
   */
  public refreshImages(): void {
    if (this.instance === null) return;
    if (this._flipState() !== 'read') return;
    const book = this.bookstore.state().book;
    if (book === null) return;

    const urls = book.pages.map((p) => this.enhancement.displayUrlFor(p));
    const changed =
      this.loadedUrls.length !== urls.length ||
      urls.some((u, i) => u !== this.loadedUrls[i]);
    if (!changed) return;

    const index = this._currentIndex();
    this.loadedUrls = urls;
    this.instance.loadFromImages(urls);
    this.instance.turnToPage(index);
  }


  /** Imperative nav — used by the bottom-sheet progress component. */
  public turnToPage(index: number): void {
    const renderedIndex = this.renderedIndexByLogicalIndex[index] ?? index;
    this.instance?.turnToPage(renderedIndex);
  }

  /** Imperative nav with the curl animation. */
  public flipNext(): void {
    this.instance?.flipNext();
  }

  public flipPrev(): void {
    this.instance?.flipPrev();
  }

  // ──────────── Pointer relay (viewer `.stage` → PageFlip API) ────────────

  /** Begin a user fold/drag at viewport coordinates. */
  public relayPointerDown(clientX: number, clientY: number): void {
    if (this.instance === null) return;
    this.instance.startUserTouch(this.toBookPoint(clientX, clientY));
  }

  /** Continue fold/drag or hover-corner preview. */
  public relayPointerMove(clientX: number, clientY: number): void {
    if (this.instance === null) return;
    this.instance.userMove(this.toBookPoint(clientX, clientY), false);
  }

  /** End fold/drag or complete a tap-to-flip. */
  public relayPointerUp(clientX: number, clientY: number): void {
    if (this.instance === null) return;
    this.instance.userStop(this.toBookPoint(clientX, clientY));
  }




  /**
   * Quick tap without a preceding relayPointerDown — page-flip never saw
   * pointerdown because `.stage` captured it for the magnifier hold timer.
   */
  public relayTap(clientX: number, clientY: number): void {
    if (this.instance === null) return;
    const pos = this.toBookPoint(clientX, clientY);
    this.instance.startUserTouch(pos);
    this.instance.userStop(pos);
  }

  /** Convert viewport coords to book-local coords (matches UI.getMousePos). */
  private toBookPoint(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.instance!.getUI().getDistElement().getBoundingClientRect();
    // The host is CSS-transformed (translate + scale) at non-1× zoom; the
    // library works in unscaled coordinates, so divide the viewport delta by
    // the current zoom to keep the fold / tap mapping exact.
    const scale = this.bookstore.zoom();
    return {
      x: (clientX - rect.left) / scale,
      y: (clientY - rect.top) / scale,
    };
  }

  /** Strip page-flip DOM/state from the host so a fresh instance can mount. */
  private resetHost(host: HTMLElement): void {
    host.replaceChildren();
    host.classList.remove('stf__parent');
    host.style.removeProperty('min-width');
    host.style.removeProperty('min-height');
    host.style.removeProperty('width');
    host.style.removeProperty('max-width');
    host.style.removeProperty('display');
  }

  private loadImageNaturalSize(url: string): Promise<LoadedImage> {
    return new Promise((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        resolve({
          natural: {
            width: Math.max(1, img.naturalWidth),
            height: Math.max(1, img.naturalHeight),
          },
          image: img,
        });
      };
      img.onerror = () => {
        resolve({ natural: { width: 800, height: 1200 }, image: null });
      };
      img.src = url;
    });
  }

  /** Keep BookstoreService in sync so magnifier / progress track the visible page. */
  private syncPageIndex(index: number): void {
    const logicalIndex = this.logicalIndexByRenderedIndex[index] ?? index;
    this._currentIndex.set(logicalIndex);
    this.bookstore.goTo(logicalIndex);
  }
}


function buildRenderedPages(
  pages: readonly Page[],
  pageUrls: readonly string[],
  loadedImages: readonly LoadedImage[],
  layout: 'single' | 'double',
  pageSize: { readonly width: number; readonly height: number },
): RenderedPages {
  const urls: string[] = [];
  const logicalIndexByRenderedIndex: number[] = [];
  const renderedIndexByLogicalIndex: number[] = [];
  let pagesSinceCover = 0;

  for (const [logicalIndex, page] of pages.entries()) {
    const loaded = loadedImages[logicalIndex];
    const natural = loaded?.natural ?? { width: 800, height: 1200 };
    const spansTwoPages =
      layout === 'double' && logicalIndex > 0 && natural.width > natural.height && loaded?.image !== null;

    if (logicalIndex === 0) {
      renderedIndexByLogicalIndex.push(urls.length);
      urls.push(pageUrls[logicalIndex]);
      logicalIndexByRenderedIndex.push(logicalIndex);
      continue;
    }

    // Keep a landscape image at a spread boundary. The filler leaves the
    // preceding portrait page alone instead of pairing it with a half-page.
    if (spansTwoPages && pagesSinceCover % 2 === 1) {
      urls.push(createBlankPageUrl(pageSize));
      logicalIndexByRenderedIndex.push(logicalIndex - 1);
      pagesSinceCover++;
    }

    renderedIndexByLogicalIndex.push(urls.length);
    if (spansTwoPages) {
      urls.push(createLandscapeHalfUrl(loaded.image, natural, pageSize, 'left'));
      logicalIndexByRenderedIndex.push(logicalIndex);
      urls.push(createLandscapeHalfUrl(loaded.image, natural, pageSize, 'right'));
      logicalIndexByRenderedIndex.push(logicalIndex);
      pagesSinceCover += 2;
    } else {
      urls.push(pageUrls[logicalIndex]);
      logicalIndexByRenderedIndex.push(logicalIndex);
      pagesSinceCover++;
    }
  }

  return { urls, logicalIndexByRenderedIndex, renderedIndexByLogicalIndex };
}

function createBlankPageUrl(pageSize: { readonly width: number; readonly height: number }): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pageSize.width}" height="${pageSize.height}"><rect width="100%" height="100%" fill="white"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function createLandscapeHalfUrl(
  image: HTMLImageElement,
  natural: NaturalSize,
  pageSize: { readonly width: number; readonly height: number },
  side: 'left' | 'right',
): string {
  const pageWidth = Math.max(1, Math.round(pageSize.width));
  const pageHeight = Math.max(1, Math.round(pageSize.height));
  const totalWidth = pageWidth * 2;
  const scale = Math.min(totalWidth / natural.width, pageHeight / natural.height);
  const imageWidth = natural.width * scale;
  const imageHeight = natural.height * scale;
  const imageX = (totalWidth - imageWidth) / 2;
  const imageY = (pageHeight - imageHeight) / 2;
  const viewX = side === 'left' ? 0 : pageWidth;
  const canvas = document.createElement('canvas');
  canvas.width = pageWidth;
  canvas.height = pageHeight;
  const context = canvas.getContext('2d');
  if (context === null) return image.src;

  context.fillStyle = 'white';
  context.fillRect(0, 0, pageWidth, pageHeight);
  context.drawImage(image, imageX - viewX, imageY, imageWidth, imageHeight);
  return canvas.toDataURL('image/jpeg', 0.92);
}

/** Map Display > Zoom to page-flip page dimensions (per-page leaf size). */
export function computePageDimensions(
  containerW: number,
  containerH: number,
  image: NaturalSize,
  zoom: ZoomMode,
  layout: 'single' | 'double',
): { width: number; height: number } {
  const pageContainerW = layout === 'double' ? containerW / 2 : containerW;
  const pageContainerH = containerH;

  const iw = image.width;
  const ih = image.height;
  const aspect = iw / ih;

  let pageW = pageContainerW;
  let pageH = pageContainerH;

  switch (zoom) {
    case 'actual-size':
      pageW = iw;
      pageH = ih;
      break;
    case 'fit-width':
      pageW = pageContainerW;
      pageH = pageContainerW / aspect;
      break;
    case 'fit-height':
      pageH = pageContainerH;
      pageW = pageContainerH * aspect;
      break;
    case 'fit-screen': {
      const scale = Math.min(pageContainerW / iw, pageContainerH / ih);
      pageW = iw * scale;
      pageH = ih * scale;
      break;
    }
    case 'cover': {
      const scale = Math.max(pageContainerW / iw, pageContainerH / ih);
      pageW = iw * scale;
      pageH = ih * scale;
      break;
    }
    case 'fixed-size':
      // Numeric picker is out of v1 scope — treat as fit-screen.
    case 'stretch-to-fill':
    default:
      pageW = pageContainerW;
      pageH = pageContainerH;
      break;
  }

  return {
    width: Math.max(1, Math.round(pageW)),
    height: Math.max(1, Math.round(pageH)),
  };
}

/**
 * Resolve once `host` has a non-zero box, or null after a short timeout.
 * The page-flip canvas needs a concrete size to mount; inside a freshly
 * opened modal the host may not be laid out yet, so we poll a frame at a
 * time instead of mounting against a 0×0 box (which would render nothing).
 */
function waitForSize(host: HTMLElement, timeoutMs = 1500): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const start = performance.now();
    const tick = (): void => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w > 0 && h > 0) {
        resolve({ w, h });
        return;
      }
      if (performance.now() - start > timeoutMs) {
        resolve(null);
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
}
