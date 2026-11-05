import { Injectable, computed, inject, signal } from '@angular/core';

import { PageFlip, type FlipSetting } from '../../vendor/page-flip';

import type { Book, Page } from '../models/book.model';
import type { PageTransition, ZoomMode } from '../models/settings.model';
import { BookstoreService } from './bookstore.service';
import { FilePageService } from './file-page.service';
import { SURROUND_FALLBACK, blendEdgeColors, mixHex, sampleEdgeColor } from './page-edge-color';
import {
  SLIDE_PULLBACK_PX,
  clampSlideOffset,
  slideColorProgress,
  slideSettleOffset,
  slideShouldCommit,
  slideSign,
} from './page-slide';
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

/** Finger-followed page slide. Offsets are host layout px. */
type UserSlide = {
  readonly overlay: HTMLCanvasElement;
  readonly canvas: HTMLCanvasElement;
  readonly axis: 'horizontal' | 'vertical';
  readonly sign: 1 | -1;
  readonly distanceHost: number;
  readonly originIndex: number;
  readonly originRendered: number;
  readonly targetRendered: number;
  offset: number;
  peak: number;
  /** Offset captured when the finger lifts, so the settle can blend from there. */
  releaseOffset: number;
  /** Host-px offset the settle animation is heading for. */
  settleTo: number;
  settling: boolean;
  animations: Animation[];
};

/** Current page's draw box inside the spread, CSS px, before wheel zoom. */
export type PageFrame = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

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
  /** Display URL of each logical page. Edge colors are cached against these. */
  private logicalUrls: readonly string[] = [];
  /** Margin color per display URL. Null means the bitmap could not be read. */
  private readonly edgeColors = new Map<string, string | null>();

  /** Letterbox color, taken from the margin of the page on screen. */
  private readonly _surroundColor = signal(SURROUND_FALLBACK);
  public readonly surroundColor = this._surroundColor.asReadonly();

  /**
   * True while a vertical or horizontal slide is painting the letterbox from
   * its own progress. The curl uses flip state for the same lock.
   */
  private readonly _surroundLive = signal(false);
  public readonly surroundLive = this._surroundLive.asReadonly();

  /** Latest page-flip state from the lib's `changeState` event. */
  private readonly _flipState = signal<FlipGestureState | null>(null);
  public readonly flipState = this._flipState.asReadonly();

  /**
   * True from the moment a page curl or slide starts until it has settled.
   * The reader sheet uses this to ignore a pull-down for the whole turn.
   */
  public readonly pageTurning = computed(() => {
    const state = this._flipState();
    return (
      state === 'user_fold' ||
      state === 'fold_corner' ||
      state === 'flipping' ||
      this._surroundLive() ||
      this._turning()
    );
  });

  /** rAF while a leaf is moving, so the letterbox tracks the curl. */
  private trackFrame: number | null = null;

  /** rAF while a slide is moving, so the letterbox tracks that slide. */
  private slideColorFrame: number | null = null;
  /** Active slide blend. Progress is 0 on the page we left and 1 on the page we reveal. */
  private slideColor: {
    originRendered: number;
    targetRendered: number;
    progress: () => number;
  } | null = null;

  /** Reactive current page index (0-based), mirrored from the lib. */
  private readonly _currentIndex = signal(0);
  public readonly currentIndex = this._currentIndex.asReadonly();

  /** True while a PageFlip instance is mounted and ready. */
  private readonly _mounted = signal(false);
  public readonly mounted = this._mounted.asReadonly();

  /** True while a slide transition is animating (viewer gates input on it). */
  private readonly _turning = signal(false);
  public readonly turning = this._turning.asReadonly();

  /** Tears down the in-flight slide animation, if any. */
  private slideCleanup: (() => void) | null = null;

  /**
   * While a finger-followed slide has already turned the canvas to the incoming
   * page, keep that index off the bookshelf until the gesture commits.
   */
  private suppressSync = false;

  /** Finger-followed slide. The overlay is the page the drag started on. */
  private userSlide: UserSlide | null = null;

  /** Book-wide single-page size the lib is mounted with. Stable per mount and
   *  independent of which page is currently shown, so fit modes apply to the
   *  whole book and page turns never resize the canvas. */
  private readonly _bookPageSize = signal<{ width: number; height: number } | null>(null);
  public readonly bookPageSize = this._bookPageSize.asReadonly();

  /**
   * Where the current page is drawn inside the spread, in CSS px before the
   * wheel-zoom scale. Page-flip centers the leaf in the canvas, so this is
   * not the spread's top-left.
   */
  private readonly _pageFrame = signal<PageFrame | null>(null);
  public readonly pageFrame = this._pageFrame.asReadonly();

  /** Device pixel ratio the current mount was laid out at. Bounds are in those px. */
  private mountDpr = 1;

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
    transition: PageTransition = 'page-curl',
  ): void {
    const sameBook = this.mountedBookId === book.id;
    if (!sameBook) this.edgeColors.clear();
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
        // CSS box of the slot the book mounts into, read BEFORE the
        // device-pixel sizing in mountWithUrls so a remount can't compound it.
        const slot = host.parentElement ?? host;
        this.mountWithUrls(host, book, warmedUrls, layout, zoom, pageIndex, transition, {
          width: slot.clientWidth,
          height: slot.clientHeight,
        });
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
    transition: PageTransition,
    cssBox: { readonly width: number; readonly height: number },
  ): void {
    this.unmount();
    this.host = host;
    this.logicalUrls = pageUrls;
    const interactiveCurl = transition === 'page-curl';
    this.resetHost(host);

    // page-flip draws every page into ONE canvas whose backing store equals
    // its CSS box — 393x872 CSS px on a 1080x2400 @2.75 screen, so every page
    // was rasterized at ~1/3 resolution and stretched by the compositor (and
    // the 2x enhanced derivatives were thrown away). Mount the book at
    // device-pixel size and scale the host back down with CSS: the canvas
    // backing store then matches the screen 1:1.
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    this.mountDpr = dpr;
    const devW = Math.max(1, Math.round(cssBox.width * dpr));
    const devH = Math.max(1, Math.round(cssBox.height * dpr));
    host.style.width = `${devW}px`;
    host.style.height = `${devH}px`;
    host.style.transform = `scale(${1 / dpr})`;
    host.style.transformOrigin = '0 0';

    const generation = ++this.mountGeneration;

    void this.probeImages(pageUrls, layout).then((loadedImages) => {
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
      // Device-pixel page size: the lib lays out in host px, which are now
      // device px, so pages rasterize at the screen's real resolution.
      const pageSize = computePageDimensions(containerW, containerH, natural, zoom, layout);
      const rendered = buildRenderedPages(book.pages, pageUrls, loadedImages, layout, pageSize);
      this.logicalIndexByRenderedIndex = rendered.logicalIndexByRenderedIndex;
      this.renderedIndexByLogicalIndex = rendered.renderedIndexByLogicalIndex;
      // Viewer geometry (pan extents, magnifier, page rects) is CSS px.
      this._bookPageSize.set({ width: pageSize.width / dpr, height: pageSize.height / dpr });

      const settings: Partial<FlipSetting> = {
        width: pageSize.width,
        height: pageSize.height,
        startPage: this.renderedIndexByLogicalIndex[pageIndex] ?? 0,
        // A book's first page is always a standalone cover in landscape mode.
        showCover: true,
        showPageCorners: interactiveCurl,
        disableFlipByClick: !interactiveCurl,
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
        if (s !== 'user_fold' && s !== 'fold_corner' && s !== 'flipping' && s !== 'read') return;
        this._flipState.set(s);
        // A finger-followed slide turns the canvas early and keeps the old
        // page on an overlay. Leave the letterbox alone until that gesture ends.
        if (this.suppressSync) return;
        // The lib reports the new page index when the leaf lands. Follow the
        // curl while it is moving so the letterbox arrives with the page.
        if (s === 'read') this.settleSurround();
        else this.startFlipTrack();
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
    this.finishSlide();
    this.dropUserSlide();
    this.cancelFlipTrack();
    this._flipState.set(null);
    this._bookPageSize.set(null);
    this._pageFrame.set(null);
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
    // `null` is the state before the lib has reported one: the reader has not
    // been touched yet, so it is as idle as 'read'. Requiring 'read' meant a
    // freshly opened book never refreshed when an enhanced page landed or the
    // user flipped to the originals.
    const state = this._flipState();
    if (state !== null && state !== 'read') return;
    if (this._turning()) return;
    const book = this.bookstore.state().book;
    if (book === null) return;

    const urls = book.pages.map((p) => this.enhancement.displayUrlFor(p));
    const changed =
      this.loadedUrls.length !== urls.length ||
      urls.some((u, i) => u !== this.loadedUrls[i]);
    if (!changed) return;

    const index = this._currentIndex();
    this.loadedUrls = urls;
    this.logicalUrls = urls;
    // `loadFromImages` rebuilds the widget's UI: it inserts another wrapper +
    // canvas into the block, and the old canvas stays on top, so the swapped
    // pages render underneath the stale ones (the enhanced/original toggle
    // looked like it did nothing). `updateFromImages` replaces the page
    // collection in place and repaints the same canvas.
    this.instance.updateFromImages([...urls]);
    this.instance.turnToPage(index);
    this.ensureSurround(this.instance.getCurrentPageIndex());
  }


  /** Imperative nav — used by the bottom-sheet progress component. */
  public turnToPage(index: number): void {
    const renderedIndex = this.renderedIndexByLogicalIndex[index] ?? index;
    this.instance?.turnToPage(renderedIndex);
  }

  /**
   * Logical page index of the neighbouring spread, or null at the book's
   * first/last spread. Spread-aware: dual-page layout and the landscape
   * split pages advance a whole spread, not a single rendered leaf.
   */
  public neighborPage(direction: 'next' | 'prev'): number | null {
    const instance = this.instance;
    if (instance === null) return null;

    const collection = instance.getPageCollection();
    const rendered = instance.getCurrentPageIndex();
    const spreadIndex = collection.getSpreadIndexByPage(rendered);
    if (spreadIndex === null) return null;

    const spreads = collection.getSpread();
    const target = direction === 'next' ? spreadIndex + 1 : spreadIndex - 1;
    if (target < 0 || target >= spreads.length) return null;

    const renderedIndex = spreads[target][0];
    return this.logicalIndexByRenderedIndex[renderedIndex] ?? renderedIndex;
  }

  /**
   * Animate one page turn for the slide transitions.
   *
   * The lib has no slide animation, so the outgoing spread is snapshotted off
   * its canvas, the lib turns instantly underneath, and the snapshot is pushed
   * off the host while the live (already-updated) canvas slides in from the
   * opposite edge. Both layers share one easing so the hand-off is seamless.
   *
   * `rtl` mirrors the travel direction so a swap to the next page always comes
   * from the reading-forward edge.
   */
  public slideToPage(
    index: number,
    direction: 'next' | 'prev',
    axis: 'horizontal' | 'vertical',
    rtl: boolean,
  ): void {
    const instance = this.instance;
    const host = this.host;
    if (instance === null || host === null || this._turning()) return;

    const target = this.renderedIndexByLogicalIndex[index] ?? index;
    if (target === instance.getCurrentPageIndex()) return;

    const element = instance.getUI().getDistElement();
    if (!(element instanceof HTMLCanvasElement)) {
      this.turnToPage(index);
      return;
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.turnToPage(index);
      return;
    }

    // Snapshot before turning. A tainted canvas (shouldn't happen for blob: /
    // data: page URLs) falls back to an instant turn.
    let snapshot: string;
    try {
      snapshot = element.toDataURL('image/jpeg', 0.9);
    } catch {
      this.turnToPage(index);
      return;
    }

    const distance = axis === 'horizontal' ? host.clientWidth : host.clientHeight;
    if (distance <= 0) {
      this.turnToPage(index);
      return;
    }

    const overlay = document.createElement('img');
    overlay.src = snapshot;
    overlay.alt = '';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.className = 'stf__slide-snapshot';
    Object.assign(overlay.style, {
      position: 'absolute',
      inset: '0',
      width: '100%',
      height: '100%',
      objectFit: 'fill',
      pointerEvents: 'none',
      zIndex: '1000',
    });
    host.appendChild(overlay);

    const originRendered = instance.getCurrentPageIndex();
    // Hold the bookshelf on the outgoing page. The blend below paints the
    // letterbox; publishing the index now would snap the color to the destination.
    this.suppressSync = true;
    this.turnToPage(index);

    // Next page comes from the left (LTR) or from above. RTL mirrors horizontal only.
    const sign = slideSign(direction, axis, rtl);
    const shift = (value: number): string =>
      axis === 'horizontal'
        ? `translate3d(${value}px, 0, 0)`
        : `translate3d(0, ${value}px, 0)`;
    const options: KeyframeAnimationOptions = {
      duration: 300,
      easing: 'cubic-bezier(0.32, 0.72, 0, 1)',
    };

    const outAnimation = overlay.animate(
      [{ transform: shift(0) }, { transform: shift(sign * distance) }],
      options,
    );
    const inAnimation = element.animate(
      [{ transform: shift(-sign * distance) }, { transform: shift(0) }],
      options,
    );

    const finish = (): void => {
      overlay.remove();
      inAnimation.cancel();
      outAnimation.cancel();
      this.slideCleanup = null;
      this.suppressSync = false;
      this.stopSlideSurround(target);
      const rendered = this.instance?.getCurrentPageIndex();
      if (rendered !== undefined) this.syncPageIndex(rendered);
      this._turning.set(false);
    };
    this.slideCleanup = finish;
    this._turning.set(true);
    this.trackSlideSurround(originRendered, target, () => {
      const eased = outAnimation.effect?.getComputedTiming().progress;
      return typeof eased === 'number' ? eased : 0;
    });

    void Promise.all([outAnimation.finished, inAnimation.finished])
      .catch(() => undefined)
      .then(() => {
        if (this.slideCleanup === finish) finish();
      });
  }

  /**
   * Start a finger-followed slide. The current spread is copied onto an overlay
   * and the live canvas turns to the incoming page underneath, parked one
   * viewport away. Later moves track the finger; release commits or returns.
   */
  public beginUserSlide(
    direction: 'next' | 'prev',
    axis: 'horizontal' | 'vertical',
    rtl: boolean,
  ): boolean {
    const instance = this.instance;
    const host = this.host;
    if (instance === null || host === null || this._turning() || this.userSlide !== null) return false;

    const target = this.neighborPage(direction);
    if (target === null) return false;

    const element = instance.getUI().getDistElement();
    if (!(element instanceof HTMLCanvasElement) || element.width === 0 || element.height === 0) {
      return false;
    }

    const distanceHost = this.slideDistanceHost(axis);
    if (distanceHost <= 0) return false;

    const overlay = document.createElement('canvas');
    overlay.width = element.width;
    overlay.height = element.height;
    const ctx = overlay.getContext('2d');
    if (ctx === null) return false;
    try {
      ctx.drawImage(element, 0, 0);
    } catch {
      return false;
    }

    this.placeSlideOverlay(overlay, element, host);
    host.appendChild(overlay);

    const sign = slideSign(direction, axis, rtl);
    const originIndex = this._currentIndex();
    const originRendered = instance.getCurrentPageIndex();
    const targetRendered = this.renderedIndexByLogicalIndex[target] ?? target;
    this.suppressSync = true;
    this.turnToPage(target);
    const slide: UserSlide = {
      overlay,
      canvas: element,
      axis,
      sign,
      distanceHost,
      originIndex,
      originRendered,
      targetRendered,
      offset: 0,
      peak: 0,
      releaseOffset: 0,
      settleTo: 0,
      settling: false,
      animations: [],
    };
    this.userSlide = slide;
    this.applyUserSlide(slide);
    this.trackSlideSurround(originRendered, targetRendered, () => {
      const current = this.userSlide;
      return current === null ? 0 : this.slideTravel(current);
    });
    return true;
  }

  /** Move the slide with the finger. `screenDelta` is the axis delta in CSS px. */
  public moveUserSlide(screenDelta: number): void {
    const slide = this.userSlide;
    if (slide === null || slide.settling) return;
    const offset = clampSlideOffset(this.screenToHost(screenDelta), slide.sign, slide.distanceHost);
    slide.offset = offset;
    slide.peak = slide.sign < 0 ? Math.min(slide.peak, offset) : Math.max(slide.peak, offset);
    this.applyUserSlide(slide);
  }

  /**
   * Release. Commits unless the finger pulled back past the tolerance from
   * the furthest point, matching the page-curl release rule.
   */
  public endUserSlide(): void {
    const slide = this.userSlide;
    if (slide === null || slide.settling) return;
    const commit = slideShouldCommit(
      this.hostToScreen(slide.offset),
      this.hostToScreen(slide.peak),
      slide.sign,
      SLIDE_PULLBACK_PX,
    );
    this.settleUserSlide(commit);
  }

  /** Drop the gesture and return to the page it started on. */
  public cancelUserSlide(): void {
    const slide = this.userSlide;
    if (slide === null || slide.settling) return;
    this.settleUserSlide(false);
  }

  /** One viewport of travel, in the host's layout px (device px, before zoom). */
  private slideDistanceHost(axis: 'horizontal' | 'vertical'): number {
    const host = this.host;
    if (host === null) return 0;
    const zoom = this.bookstore.zoom() || 1;
    const layout = axis === 'horizontal' ? host.clientWidth : host.clientHeight;
    return layout / zoom;
  }

  /** Screen CSS px → host layout px. The host is scaled by 1/dpr and by the wheel zoom. */
  private screenToHost(screenPx: number): number {
    const zoom = this.bookstore.zoom() || 1;
    return (screenPx * this.mountDpr) / zoom;
  }

  private hostToScreen(hostPx: number): number {
    const zoom = this.bookstore.zoom() || 1;
    return (hostPx * zoom) / this.mountDpr;
  }

  /** 0 on the page the drag started on, 1 when the incoming page is fully in view. */
  private slideTravel(slide: UserSlide): number {
    let offset = slide.offset;
    if (slide.settling) {
      const eased = slide.animations[0]?.effect?.getComputedTiming().progress;
      if (typeof eased === 'number') {
        offset = slideSettleOffset(slide.releaseOffset, slide.settleTo, eased);
      }
    }
    return slideColorProgress(offset, slide.distanceHost);
  }

  private slideTransform(slide: UserSlide, hostPx: number): string {
    return slide.axis === 'horizontal'
      ? `translate3d(${hostPx}px, 0, 0)`
      : `translate3d(0, ${hostPx}px, 0)`;
  }

  /** Cover the live canvas with a copy of the page the drag started on. */
  private placeSlideOverlay(
    overlay: HTMLCanvasElement,
    canvas: HTMLCanvasElement,
    host: HTMLElement,
  ): void {
    let x = 0;
    let y = 0;
    let el: HTMLElement | null = canvas;
    let reachedHost = false;
    while (el !== null && el !== host) {
      x += el.offsetLeft;
      y += el.offsetTop;
      const next: Element | null = el.offsetParent;
      if (next === host) reachedHost = true;
      el = next instanceof HTMLElement ? next : null;
    }
    if (reachedHost) {
      overlay.style.left = `${x}px`;
      overlay.style.top = `${y}px`;
      overlay.style.width = `${canvas.offsetWidth}px`;
      overlay.style.height = `${canvas.offsetHeight}px`;
    } else {
      overlay.style.inset = '0';
      overlay.style.width = '100%';
      overlay.style.height = '100%';
    }
    overlay.style.position = 'absolute';
    overlay.style.pointerEvents = 'none';
    overlay.style.zIndex = '1000';
    overlay.setAttribute('aria-hidden', 'true');
  }

  private applyUserSlide(slide: UserSlide): void {
    const incoming = slide.offset - slide.sign * slide.distanceHost;
    slide.overlay.style.transform = this.slideTransform(slide, slide.offset);
    slide.canvas.style.transform = this.slideTransform(slide, incoming);
  }

  /** Glide the rest of the way, then publish the new page or restore the old one. */
  private settleUserSlide(commit: boolean): void {
    const slide = this.userSlide;
    if (slide === null) return;
    const to = commit ? slide.sign * slide.distanceHost : 0;
    slide.releaseOffset = slide.offset;
    slide.settleTo = to;
    slide.settling = true;
    this._turning.set(true);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const options: KeyframeAnimationOptions = {
      duration: reduce ? 0 : 240,
      easing: 'cubic-bezier(0.32, 0.72, 0, 1)',
      fill: 'forwards',
    };
    const overlayAnim = slide.overlay.animate(
      [
        { transform: this.slideTransform(slide, slide.offset) },
        { transform: this.slideTransform(slide, to) },
      ],
      options,
    );
    const canvasAnim = slide.canvas.animate(
      [
        { transform: this.slideTransform(slide, slide.offset - slide.sign * slide.distanceHost) },
        { transform: this.slideTransform(slide, to - slide.sign * slide.distanceHost) },
      ],
      options,
    );
    slide.animations = [overlayAnim, canvasAnim];

    void Promise.all([overlayAnim.finished, canvasAnim.finished])
      .catch(() => undefined)
      .then(() => {
        if (this.userSlide !== slide) return;
        this.finishUserSlide(commit);
      });
  }

  private finishUserSlide(commit: boolean): void {
    const slide = this.userSlide;
    if (slide === null) return;
    this.userSlide = null;
    for (const animation of slide.animations) animation.cancel();
    if (!commit) {
      this.suppressSync = true;
      this.turnToPage(slide.originIndex);
    }
    slide.overlay.remove();
    slide.canvas.style.transform = '';
    this.suppressSync = false;
    const settled = commit ? slide.targetRendered : slide.originRendered;
    if (commit) {
      const rendered = this.instance?.getCurrentPageIndex();
      if (rendered !== undefined) this.syncPageIndex(rendered);
    }
    this.stopSlideSurround(settled);
    this._turning.set(false);
  }

  /** Forget an in-flight slide without touching the bookshelf. The mount is going away. */
  private dropUserSlide(): void {
    const slide = this.userSlide;
    if (slide === null) return;
    this.userSlide = null;
    for (const animation of slide.animations) animation.cancel();
    slide.overlay.remove();
    slide.canvas.style.transform = '';
    this.suppressSync = false;
    this.stopSlideSurround(null);
    this._turning.set(false);
  }

  /** Abort an in-flight slide and restore the canvas transform. */
  private finishSlide(): void {
    const cleanup = this.slideCleanup;
    this.slideCleanup = null;
    cleanup?.();
    this._turning.set(false);
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
    // The host is CSS-transformed (translate + scale) at non-1× zoom and is
    // mounted at device-pixel size, while the library works in the canvas's
    // backing-store (device px) coordinates. Normalize by the visual zoom,
    // then convert CSS px → device px.
    const scale = this.bookstore.zoom();
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    return {
      x: ((clientX - rect.left) / scale) * dpr,
      y: ((clientY - rect.top) / scale) * dpr,
    };
  }

  /** Strip page-flip DOM/state from the host so a fresh instance can mount. */
  private resetHost(host: HTMLElement): void {
    host.replaceChildren();
    host.classList.remove('stf__parent');
    host.style.removeProperty('min-width');
    host.style.removeProperty('min-height');
    host.style.removeProperty('width');
    host.style.removeProperty('height');
    host.style.removeProperty('max-width');
    host.style.removeProperty('display');
    host.style.removeProperty('transform');
    host.style.removeProperty('transform-origin');
  }

  /**
   * Natural size of every page, probed one at a time.
   *
   * Loading all pages in parallel kept a whole chapter's bitmaps in memory at
   * once — with enhanced pages that is 4× the pixels and exhausted the Android
   * heap. Only landscape pages in the double layout need the decoded image
   * retained (they get split into halves); everything else keeps just the size.
   */
  private async probeImages(
    urls: readonly string[],
    layout: 'single' | 'double',
  ): Promise<LoadedImage[]> {
    const out: LoadedImage[] = [];
    for (const url of urls) {
      const loaded = await this.loadImageNaturalSize(url);
      this.rememberEdge(url, loaded);
      const keep =
        layout === 'double' &&
        loaded.image !== null &&
        loaded.natural.width > loaded.natural.height;
      out.push(keep ? loaded : { natural: loaded.natural, image: null });
    }
    return out;
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
    if (this.suppressSync) return;
    const logicalIndex = this.logicalIndexByRenderedIndex[index] ?? index;
    this._currentIndex.set(logicalIndex);
    this.bookstore.goTo(logicalIndex);
    this.ensureSurround(index);
    this.updatePageFrame(index);
  }

  /**
   * Record the current page's draw rect. Portrait (and a lone right-hand
   * leaf) is painted one page-width to the right of `bounds.left`; the left
   * leaf of a landscape spread is painted at `bounds.left`.
   */
  private updatePageFrame(renderedIndex: number): void {
    const instance = this.instance;
    if (instance === null) {
      this._pageFrame.set(null);
      return;
    }
    const rect = instance.getBoundsRect();
    const dpr = this.mountDpr;
    const onRight = this.drawnOnRight(renderedIndex);
    const x = (onRight ? rect.left + rect.pageWidth : rect.left) / dpr;
    this._pageFrame.set({
      x,
      y: rect.top / dpr,
      width: rect.pageWidth / dpr,
      height: rect.height / dpr,
    });
  }

  /** True when this rendered page is the one page-flip paints in the right slot. */
  private drawnOnRight(renderedIndex: number): boolean {
    const instance = this.instance;
    if (instance === null) return true;
    if (instance.getOrientation() === 'portrait') return true;
    const collection = instance.getPageCollection();
    const spreadIndex = collection.getSpreadIndexByPage(renderedIndex);
    const spread = spreadIndex === null ? undefined : collection.getSpread()[spreadIndex];
    if (spread !== undefined && spread.length >= 2) return spread[1] === renderedIndex;
    // A single landscape leaf is on the right, except the book's last page.
    return renderedIndex !== instance.getPageCount() - 1;
  }

  /** Logical pages of the spread that contains `renderedIndex`. */
  private spreadLogicalIndices(renderedIndex: number): readonly number[] {
    const collection = this.instance?.getPageCollection();
    const spreadIndex = collection?.getSpreadIndexByPage(renderedIndex) ?? null;
    const spread = spreadIndex === null ? undefined : collection?.getSpread()[spreadIndex];
    if (spread === undefined) {
      return [this.logicalIndexByRenderedIndex[renderedIndex] ?? renderedIndex];
    }
    return [...new Set(spread.map((index) => this.logicalIndexByRenderedIndex[index] ?? index))];
  }

  /**
   * Paint the letterbox from the margins of the pages on screen.
   * A page that is still loading keeps the previous color instead of flashing
   * the fallback grey.
   */
  private applySurround(renderedIndex: number): void {
    const color = this.colorForRendered(renderedIndex);
    if (color !== null) this._surroundColor.set(color);
  }

  /** Margin color of the spread containing `renderedIndex`, or null while it is still loading. */
  private colorForRendered(renderedIndex: number): string | null {
    let pending = false;
    const known: string[] = [];
    for (const index of this.spreadLogicalIndices(renderedIndex)) {
      const url = this.logicalUrls[index];
      if (url === undefined || !this.edgeColors.has(url)) {
        pending = true;
        continue;
      }
      const color = this.edgeColors.get(url);
      if (color !== undefined && color !== null) known.push(color);
    }
    if (known.length > 0) return blendEdgeColors(known);
    if (!pending) return SURROUND_FALLBACK;
    return null;
  }

  /**
   * Use cached margin colors, and sample any page on screen that is not
   * cached yet (an enhanced derivative that arrived after the first probe).
   */
  private ensureSurround(renderedIndex: number): void {
    this.applySurround(renderedIndex);
    this.warmSurround(renderedIndex);
  }

  /** Sample missing margin colors without painting them. A curl in progress paints its own blend. */
  private warmSurround(renderedIndex: number): void {
    const missing = this.spreadLogicalIndices(renderedIndex).flatMap((index) => {
      const url = this.logicalUrls[index];
      return url !== undefined && !this.edgeColors.has(url) ? [url] : [];
    });
    if (missing.length === 0) return;

    const generation = this.mountGeneration;
    void Promise.all(missing.map((url) => this.sampleUrl(url))).then(() => {
      if (generation !== this.mountGeneration || this.instance === null) return;
      // A curl or a slide is painting its own blend. The next frame picks up
      // the sample; painting the resting page here would snap the letterbox.
      if (this.trackFrame !== null || this.slideColor !== null) return;
      this.applySurround(this.instance.getCurrentPageIndex());
    });
  }

  /** Follow the curl: blend the resting margin into the page being revealed. */
  private startFlipTrack(): void {
    if (this.trackFrame !== null) return;
    this.prefetchFlipTarget();
    const tick = (): void => {
      const state = this._flipState();
      if (state !== 'user_fold' && state !== 'fold_corner' && state !== 'flipping') {
        this.trackFrame = null;
        return;
      }
      this.trackFlipColor();
      this.trackFrame = requestAnimationFrame(tick);
    };
    this.trackFrame = requestAnimationFrame(tick);
  }

  /** Sample the page under the fold so its color is ready before the leaf lands. */
  private prefetchFlipTarget(): void {
    const instance = this.instance;
    if (instance === null) return;
    const rendered = instance.getCurrentPageIndex();
    const calc = instance.getFlipController().getCalculation();
    if (calc === null) return;
    const direction = calc.getDirection() === 1 ? 'prev' : 'next';
    const target = this.neighborRendered(rendered, direction);
    if (target !== null) this.warmSurround(target);
  }

  private trackFlipColor(): void {
    const instance = this.instance;
    if (instance === null) return;
    const calc = instance.getFlipController().getCalculation();
    if (calc === null) return;

    const rendered = instance.getCurrentPageIndex();
    const from = this.colorForRendered(rendered);
    if (from === null) return;

    const raw = calc.getFlippingProgress();
    const progress = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw / 100)) : 0;
    const direction = calc.getDirection() === 1 ? 'prev' : 'next';
    const target = this.neighborRendered(rendered, direction);
    const to = target === null ? null : this.colorForRendered(target);
    this._surroundColor.set(to === null || progress <= 0 ? from : mixHex(from, to, progress));
  }

  /**
   * Blend the letterbox from the outgoing page toward the incoming one.
   * `progress` follows the slide (finger or the settle animation), 0 to 1.
   */
  private trackSlideSurround(
    originRendered: number,
    targetRendered: number,
    progress: () => number,
  ): void {
    this.slideColor = { originRendered, targetRendered, progress };
    this._surroundLive.set(true);
    this.paintSlideSurround(originRendered, targetRendered, progress());
    this.warmSurround(targetRendered);
    const tick = (): void => {
      const job = this.slideColor;
      if (job === null) {
        this.slideColorFrame = null;
        return;
      }
      this.paintSlideSurround(job.originRendered, job.targetRendered, job.progress());
      this.slideColorFrame = requestAnimationFrame(tick);
    };
    if (this.slideColorFrame === null) this.slideColorFrame = requestAnimationFrame(tick);
  }

  private paintSlideSurround(originRendered: number, targetRendered: number, progress: number): void {
    const from = this.colorForRendered(originRendered);
    if (from === null) return;
    const to = this.colorForRendered(targetRendered);
    const t = Math.min(1, Math.max(0, progress));
    this._surroundColor.set(to === null || t <= 0 ? from : mixHex(from, to, t));
  }

  /**
   * The slide has landed. Paint the resting page while the per-frame lock is
   * still on, then release it a frame later so the CSS fade does not replay
   * the last step.
   */
  private stopSlideSurround(settledRendered: number | null): void {
    this.slideColor = null;
    if (this.slideColorFrame !== null) {
      cancelAnimationFrame(this.slideColorFrame);
      this.slideColorFrame = null;
    }
    if (settledRendered !== null) this.applySurround(settledRendered);
    if (!this._surroundLive()) return;
    requestAnimationFrame(() => {
      if (this.slideColor === null) this._surroundLive.set(false);
    });
  }

  /** The leaf has landed or the fold was cancelled. Paint the page now on screen. */
  private settleSurround(): void {
    this.cancelFlipTrack();
    const index = this.instance?.getCurrentPageIndex();
    if (index !== undefined) this.applySurround(index);
  }

  private cancelFlipTrack(): void {
    if (this.trackFrame === null) return;
    cancelAnimationFrame(this.trackFrame);
    this.trackFrame = null;
  }

  /** Rendered index of the neighbouring spread, or null at either end of the book. */
  private neighborRendered(rendered: number, direction: 'next' | 'prev'): number | null {
    const collection = this.instance?.getPageCollection();
    if (collection === undefined) return null;
    const spreadIndex = collection.getSpreadIndexByPage(rendered);
    if (spreadIndex === null) return null;
    const spreads = collection.getSpread();
    const target = direction === 'next' ? spreadIndex + 1 : spreadIndex - 1;
    if (target < 0 || target >= spreads.length) return null;
    return spreads[target][0];
  }

  private rememberEdge(url: string, loaded: LoadedImage): void {
    if (this.edgeColors.has(url)) return;
    const color =
      loaded.image === null
        ? null
        : sampleEdgeColor(loaded.image, loaded.natural.width, loaded.natural.height);
    this.edgeColors.set(url, color);
  }

  private async sampleUrl(url: string): Promise<void> {
    if (this.edgeColors.has(url)) return;
    const loaded = await this.loadImageNaturalSize(url);
    this.rememberEdge(url, loaded);
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
    case 'fit-width':
      pageW = pageContainerW;
      pageH = pageContainerW / aspect;
      break;
    case 'fit-height':
      pageH = pageContainerH;
      pageW = pageContainerH * aspect;
      break;
    case 'fit-screen':
    default: {
      const scale = Math.min(pageContainerW / iw, pageContainerH / ih);
      pageW = iw * scale;
      pageH = ih * scale;
      break;
    }
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
