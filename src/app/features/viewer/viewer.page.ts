import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { IonContent, IonImg } from '@ionic/angular/standalone';

import { buildHxHChapterOneSample } from '../../core/debug/sample-books';
import type { Page } from '../../core/models/book.model';
import type { FilterSettings } from '../../core/models/settings.model';
import { BookFlipService } from '../../core/services/book-flip.service';
import { BookstoreService } from '../../core/services/bookstore.service';
import { FilePageService } from '../../core/services/file-page.service';
import { KeepAwakeService } from '../../core/services/keep-awake.service';
import { MagnifierStateService } from '../../core/services/magnifier-state.service';
import { ShelfService } from '../../core/services/shelf.service';
import { ScanEnhancementService } from '../../core/services/scan-enhancement.service';
import { SettingsService } from '../../core/services/settings.service';
import { BookSpreadComponent } from './book-spread.component';
import { MagnifierComponent } from './magnifier.component';

type GestureAxis = 'horizontal' | 'vertical';

interface PanExtents {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly overflowX: number;
  readonly overflowY: number;
}

/**
 * v1 Viewer: headerless, full-bleed book spread with a small, transparent,
 * centered-top floating button that opens a tabbed quick-actions modal.
 *
 * Pointer routing on `.stage`:
 *  - Vertical drag pans when the page is taller than the viewport.
 *  - Horizontal drag pans until the page edge, then relays to page-flip.
 *  - Quick tap still relays a corner flip when wheel zoom is at 1×.
 *  - Hold 300ms opens the magnifier loupe.
 */
@Component({
  selector: 'ov-viewer',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonContent, IonImg, BookSpreadComponent, MagnifierComponent],
  templateUrl: './viewer.page.html',
  styleUrls: ['./viewer.page.scss'],
  host: {
    '[attr.dir]': 'direction()',
  },
})
export class ViewerPage {
  private readonly bookstore = inject(BookstoreService);
  private readonly settings = inject(SettingsService);
  private readonly magnifierState = inject(MagnifierStateService);
    private readonly flip = inject(BookFlipService);
    private readonly shelf = inject(ShelfService);
    private readonly scan = inject(ScanEnhancementService);
    private readonly filePages = inject(FilePageService);
    private readonly keepAwake = inject(KeepAwakeService);

  /** Open book, or null. Bound to the spread component. */
  public readonly openBook = computed(() => this.bookstore.state().book);

  /** CSS `filter` string applied to the spread wrapper. */
  public readonly canvasFilter = computed(() => buildFilterString(this.settings.settings().filters));

  /** CSS `image-rendering` for the spread — driven by image-smooth setting. */
  public readonly imageRendering = computed(() => {
    const method = this.settings.settings().filters.imageSmooth.method;
    return method === 'nearest-neighbor' ? 'pixelated' : 'auto';
  });

  /** Reading direction bound to the host `[dir]` attribute. */
  public readonly direction = computed<'ltr' | 'rtl'>(() => this.settings.settings().display.readingDirection);

  /** Progress string for the future bottom-sheet. */
  public readonly progress = computed(() => {
    const s = this.bookstore.state();
    if (s.book === null) return '';
    return `${s.currentIndex + 1} / ${s.book.pages.length}`;
  });

  // ──────────── Pages menu (bottom tap → page grid) ────────────

  /** Whether the pages menu (title + page thumbnails) is open. */
  public readonly pagesOpen = signal(false);

  /** All pages of the open book, in order. */
  public readonly pages = computed<readonly Page[]>(() => this.openBook()?.pages ?? []);

  /** Index of the page currently on screen. */
  public readonly currentIndex = computed(() => {
    const s = this.bookstore.state();
    return s.book === null ? 0 : s.currentIndex;
  });

  /** Read progress as a 0–100 percentage for the menu's progress bar. */
  public readonly progressPercent = computed(() => {
    const total = this.pages().length;
    if (total === 0) return 0;
    return ((this.currentIndex() + 1) / total) * 100;
  });

  // ──────────── Magnifier state ────────────

  /** Reference to the stage element (.stage) for rect queries. */
  private readonly stageRef = viewChild<ElementRef<HTMLDivElement>>('stage');

  /** Live loupe-visible flag for the template. */
  public readonly magnifierActive = this.magnifierState.active;

  /** Pointer X/Y in viewport coords. */
  public readonly pointerX = signal(0);
  public readonly pointerY = signal(0);

  /** Snapshot of the stage's viewport-relative rect. Updated on activation. */
  private readonly _hostRect = signal<DOMRect | null>(null);
  public readonly hostRect = this._hostRect.asReadonly();

  /** Pan offset applied to `<ov-book-spread>` when the page exceeds the stage. */
  private readonly panOffsetX = signal(0);
  private readonly panOffsetY = signal(0);

  // ──────────── Book-boundary slide transition ────────────

  /** Horizontal offset (px) of the slide layer while crossing into the next/prev book. */
  private readonly _bookTransitionX = signal(0);
  public readonly bookTransitionX = this._bookTransitionX.asReadonly();

  /** True while the slide layer is animating (CSS transition on transform). */
  private readonly _slideAnimating = signal(false);
  public readonly slideAnimating = this._slideAnimating.asReadonly();

  /** Gates all stage input while a book transition is running. */
  private readonly _transitioning = signal(false);

  /** Active book-transition direction during a drag, or null. */
  private readonly _transitionDir = signal<'next' | 'prev' | null>(null);
  /** True while a boundary drag is being finger-followed. */
  private bookDragActive = false;

  /** Transform for the slide layer (translateX only — pan/zoom stays on the spread). */
  public readonly slideTransform = computed(() => `translateX(${this._bookTransitionX()}px)`);

  /**
   * Stage-relative rect (px) where the target book's page is rendered during
   * a boundary drag. Matches the current page's rect so the reveal lines up
   * exactly with where the mounted book will appear.
   */
  public readonly previewRect = computed(() => {
    const stage = this.hostRect();
    const img = this.pageImageRect();
    if (stage === null || img === null) return null;
    return {
      left: img.left - stage.left,
      top: img.top - stage.top,
      width: img.width,
      height: img.height,
    };
  });

  /** Transform for the preview layer: it slides in from the opposite edge,
   *  tracking the finger (translateX = slide - sign·width). */
  public readonly previewTransform = computed(() => {
    const dir = this._transitionDir();
    const slide = this._bookTransitionX();
    const width = this.hostRect()?.width ?? window.innerWidth;
    if (dir === null) return 'translateX(0px)';
    const sign = this.bookCommitSign(dir);
    return `translateX(${slide - sign * width}px)`;
  });

  /** URL of the target book's resume page, shown as the transition preview. */
  public readonly boundaryPreviewUrl = computed<string | null>(() => {
    const dir = this._transitionDir();
    const state = this.bookstore.state();
    if (dir === null || state.book === null) return null;
    const id =
      dir === 'next' ? this.shelf.nextBookId(state.book.id) : this.shelf.prevBookId(state.book.id);
    if (id === null) return null;
    const book = this.shelf.byId(id);
    if (book === undefined || book.pages.length === 0) return null;
    const idx = clamp(this.shelf.progressFor(id), 0, book.pages.length - 1);
    return book.pages[idx].url ?? book.pages[0].url;
  });

  public readonly panTransform = computed(() => {
    const s = this.bookstore.zoom();
    return `translate(${this.panOffsetX()}px, ${this.panOffsetY()}px) scale(${s})`;
  });

  /** Zoom percentage label, e.g. "100%". */
  public readonly zoomLabel = computed(() => `${Math.round(this.bookstore.zoom() * 100)}%`);

  /** Show the zoom label only when zoom deviates from the fit default. */
  public readonly showZoomLabel = computed(() => Math.abs(this.bookstore.zoom() - 1) >= 0.01);

  /** Book-wide rendered page size — read from the mounted page-flip instance
   *  (set at mount from the book's fit), NOT the current page, so pan and
   *  magnifier geometry stay stable across page turns. */
  private readonly renderedPageSize = computed(() => this.flip.bookPageSize());
  /** Rendered page size at the current wheel-zoom scale (bookstore.zoom). */
  private readonly effectivePageSize = computed<{ width: number; height: number } | null>(() => {
    const base = this.renderedPageSize();
    if (base === null) return null;
    const s = this.bookstore.zoom();
    return { width: base.width * s, height: base.height * s };
  });

  private readonly panExtents = computed<PanExtents>(() => {
    const stage = this.hostRect();
    if (stage === null) {
      return { minX: 0, maxX: 0, minY: 0, maxY: 0, overflowX: 0, overflowY: 0 };
    }

    const scale = this.bookstore.zoom();
    const rendered = this.renderedPageSize();
    if (rendered === null) {
      return { minX: 0, maxX: 0, minY: 0, maxY: 0, overflowX: 0, overflowY: 0 };
    }

    // Book size at the current zoom. (Do NOT fold the DOM canvas rect in here:
    // it is already scaled, so it would double-count the zoom and over-bloat
    // the pan range; it is also a side-effecting DOM read inside a computed.)
    const effW = rendered.width * scale;
    const effH = rendered.height * scale;

    // Oversized pages slide so they always cover the stage. Smaller pages
    // (zoomed out) can sit anywhere while fully visible — this keeps the
    // cursor-anchor working when zooming out instead of snapping to center.
    const minX = effW >= stage.width ? -(effW - stage.width) : 0;
    const maxX = effW >= stage.width ? 0 : stage.width - effW;
    const minY = effH >= stage.height ? -(effH - stage.height) : 0;
    const maxY = effH >= stage.height ? 0 : stage.height - effH;

    return {
      minX,
      maxX,
      minY,
      maxY,
      overflowX: Math.max(0, effW - stage.width),
      overflowY: Math.max(0, effH - stage.height),
    };
  });

  /**
   * Viewport rect where the current page image is drawn. In dual spread
   * each page occupies half the stage; mapping pointer → image must use
   * this rect, not the full stage.
   */
  public readonly pageImageRect = computed<DOMRect | null>(() => {
    const stage = this.hostRect();
    const eff = this.effectivePageSize();
    if (stage === null || eff === null) return null;

    const panX = this.panOffsetX();
    const panY = this.panOffsetY();

    const layout = this.settings.settings().display.pageLayout;
    if (layout !== 'auto-dual') {
      return new DOMRect(stage.left + panX, stage.top + panY, eff.width, eff.height);
    }

    const state = this.bookstore.state();
    if (state.book === null) {
      return new DOMRect(stage.left + panX, stage.top + panY, eff.width, eff.height);
    }

    const index = state.currentIndex;
    const rtl = this.settings.settings().display.readingDirection === 'rtl';
    const halfW = eff.width / 2;
    const onLeft = rtl ? index % 2 === 1 : index % 2 === 0;

    return onLeft
      ? new DOMRect(stage.left + panX, stage.top + panY, halfW, eff.height)
      : new DOMRect(stage.left + halfW + panX, stage.top + panY, halfW, eff.height);
  });

  /** Viewport size. */
  private readonly _viewportWidth = signal(0);
  private readonly _viewportHeight = signal(0);
  public readonly viewportWidth = this._viewportWidth.asReadonly();
  public readonly viewportHeight = this._viewportHeight.asReadonly();

  /** URL of the current page image (enhanced derivative when ready, else original). */
  public readonly currentPageUrl = computed<string | null>(() => {
    const page = this.bookstore.currentPage();
    return page === null ? null : this.scan.displayUrlFor(page);
  });

  /** Magnification factor (live from Preferences). */
  public readonly magnifierZoom = computed(() => this.settings.settings().display.magnifierZoom);

  /** Natural pixel size of the current page image. */
  public readonly naturalSize = signal<{ width: number; height: number } | null>(null);

  constructor() {
    if (this.bookstore.state().book === null) {
      const first = this.shelf.books()[0];
      if (first !== undefined) this.bookstore.openById(first.id);
      else this.bookstore.openBook(buildHxHChapterOneSample());
    }

    effect(() => {
      const url = this.currentPageUrl();
      if (url === null) {
        this.naturalSize.set(null);
        return;
      }
      const img = new Image();
      img.onload = () => {
        this.naturalSize.set({ width: img.naturalWidth, height: img.naturalHeight });
      };
      img.onerror = () => {
        this.naturalSize.set(null);
      };
      img.src = url;
    });
    // Recenter only when the display geometry changes. Page-flip owns page
    // turns; reacting to its current-index signal here causes a full Angular
    // update at the end of every animation.
    effect(() => {
      this.settings.settings().display.zoom;
      this.settings.settings().display.pageLayout;
      untracked(() => {
        if (this.panOffsetX() !== 0 || this.panOffsetY() !== 0) {
          this.resetPan();
        }
        this.stopMomentum();
      });
    });

    // When an enhanced derivative completes (or its blob URL becomes ready),
    // refresh the mounted page-flip at a safe (idle) moment so the improved page
    // shows without navigating. Also watch FilePageService.revision() so the
    // late-arriving blob URL for a freshly-enhanced page is picked up.
    effect(() => {
      this.scan.revision();
      this.filePages.revision();
      untracked(() => this.flip.refreshImages());
    });

    // Keep the screen on while reading when the setting is enabled.
    effect(() => {
      const keep = this.settings.settings().display.keepAwake && this.openBook() !== null;
      if (keep) this.keepAwake.enable();
      else this.keepAwake.disable();
    });
  }

  /** Dismiss the reader overlay, returning to the bookshelf underneath. */
  public closeViewer(): void {
    this.bookstore.closeBook();
  }

  /** Open the pages menu (title + thumbnails). */
  public openPagesMenu(): void {
    this.pagesOpen.set(true);
  }

  /** Close the pages menu. */
  public closePagesMenu(): void {
    this.pagesOpen.set(false);
  }

  /** Jump to a page from the pages menu. */
  public goToPage(index: number): void {
    this.pagesOpen.set(false);
    this.bookstore.goTo(index);
    this.flip.turnToPage(index);
  }

  // ──────────── Book-boundary slide transition ────────────

  /** Drag direction toward the next book, or null when not at a boundary. */
  private bookBoundaryDirection(dx: number): 'next' | 'prev' | null {
    const rtl = this.direction() === 'rtl';
    if (rtl ? dx > 0 : dx < 0) return this.bookstore.hasNext() ? null : 'next';
    if (rtl ? dx < 0 : dx > 0) return this.bookstore.hasPrev() ? null : 'prev';
    return null;
  }

  /** Tap zone under a quick tap: which book boundary it points at. */
  private bookTapZone(clientX: number): 'next' | 'prev' | null {
    const stage = this.hostRect();
    if (stage === null) return null;
    const x = clientX - stage.left;
    const third = stage.width / 3;
    const rtl = this.direction() === 'rtl';
    if (x < third) return rtl ? 'next' : 'prev';
    if (x > 2 * third) return rtl ? 'prev' : 'next';
    return null;
  }

  /** Viewport-x sign the slide commits toward: -1 = left, +1 = right. */
  private bookCommitSign(dir: 'next' | 'prev'): 1 | -1 {
    const rtl = this.direction() === 'rtl';
    return dir === 'next' === !rtl ? -1 : 1;
  }

  /** Start a finger-followed boundary drag. */
  private beginBookTransition(dir: 'next' | 'prev'): void {
    this.clearHoldTimer();
    this.gestureAxis = null;
    this._transitionDir.set(dir);
    this.bookDragActive = true;
    this._transitioning.set(true);
    this._bookTransitionX.set(0);
  }

  /** Track the slide with the pointer during a boundary drag. The slide only
   *  moves toward the commit side (LTR next → left, prev → right), so the
   *  drag feels like pushing the current book off-screen. */
  private followBookDrag(event: PointerEvent): void {
    const dir = this._transitionDir();
    if (dir === null) return;
    const width = this.hostRect()?.width ?? window.innerWidth;
    const dx = event.clientX - this.holdStartX;
    const sign = this.bookCommitSign(dir);
    this._bookTransitionX.set(sign < 0 ? clamp(dx, -width, 0) : clamp(dx, 0, width));
    this.recordPanSample(event.clientX, event.clientY);
  }

  /** True when a boundary drag should commit to the transition. */
  private shouldCommitBookTransition(dir: 'next' | 'prev', slide: number, width: number): boolean {
    const sign = this.bookCommitSign(dir);
    const velocity = this.computePanVelocity('horizontal');
    const fling = Math.abs(velocity) > 1.5 && Math.sign(velocity) === sign;
    const dist = Math.abs(slide) > width * ViewerPage.BOOK_SWIPE_RATIO && Math.sign(slide) === sign;
    return dist || fling;
  }

  /** Run the full slide transition into the next/prev book. */
  private async commitBookTransition(dir: 'next' | 'prev'): Promise<void> {
    const state = this.bookstore.state();
    if (state.book === null) {
      this.cancelBookTransition();
      return;
    }
    const hasTarget =
      dir === 'next'
        ? this.shelf.nextBookId(state.book.id) !== null
        : this.shelf.prevBookId(state.book.id) !== null;
    if (!hasTarget) {
      this.cancelBookTransition();
      return;
    }

    this.bookDragActive = false;
    this._transitioning.set(true);
    const width = this.hostRect()?.width ?? window.innerWidth;
    const target = this.bookCommitSign(dir) * width;

    // Finish the push: the current book glides off-screen, fully revealing
    // the preview (target book's resume page) behind it.
    this._slideAnimating.set(true);
    this._bookTransitionX.set(target);
    await sleep(ViewerPage.BOOK_TRANSITION_MS);

    // Swap the book and wait for the flip instance to remount at the same
    // resume page the preview shows.
    if (dir === 'next') this.bookstore.openNext();
    else this.bookstore.openPrev();
    this.resetPan();
    await this.waitForFlipMount();

    // Snap back to rest with no transition: the mounted book renders exactly
    // where the preview did, so the hand-off is seamless. Clear the preview.
    this._slideAnimating.set(false);
    this._bookTransitionX.set(0);
    this._transitionDir.set(null);
    this._transitioning.set(false);
  }

  /** Snap the slide back to rest (no commit). */
  private cancelBookTransition(): void {
    this.bookDragActive = false;
    this._slideAnimating.set(true);
    this._bookTransitionX.set(0);
    setTimeout(() => {
      this._slideAnimating.set(false);
      this._transitioning.set(false);
      this._transitionDir.set(null);
    }, ViewerPage.BOOK_TRANSITION_MS);
  }

  /** Resolve once the flip instance is mounted (new book ready), or timeout. */
  private waitForFlipMount(timeoutMs = 3000): Promise<void> {
    return new Promise((resolve) => {
      const start = performance.now();
      const tick = (): void => {
        if (this.flip.mounted()) {
          resolve();
          return;
        }
        if (performance.now() - start > timeoutMs) {
          resolve();
          return;
        }
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  @HostListener('wheel', ['$event'])
  public onWheel(event: WheelEvent): void {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();

    const oldZoom = this.bookstore.zoom();
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1;
    this.bookstore.setZoom(factor);
    const newZoom = this.bookstore.zoom();
    if (newZoom === oldZoom) return; // already at a bound

    // Anchor the zoom on the point under the cursor: keep the same stage
    // position fixed while the page scales (origin 0 0, translate + scale).
    const stage = this.stageRef()?.nativeElement;
    if (stage === undefined) return;
    const rect = stage.getBoundingClientRect();
    const px = event.clientX - rect.left;
    const py = event.clientY - rect.top;
    const k = newZoom / oldZoom;
    const nx = px - (px - this.panOffsetX()) * k;
    const ny = py - (py - this.panOffsetY()) * k;
    const { minX, maxX, minY, maxY } = this.panExtents();
    this.panOffsetX.set(clamp(nx, minX, maxX));
    this.panOffsetY.set(clamp(ny, minY, maxY));
  }

  // ──────────── Magnifier + page-flip pointer relay ────────────

  private static readonly HOLD_MS = 300;
  /** Downward drag (px) that dismisses the reader when the page fits the height. */
  private static readonly CLOSE_THRESHOLD = 100;
  /** Height of the tap zone at the bottom of the screen that opens the pages menu. */
  private static readonly PAGES_MENU_ZONE = 72;
  /** Horizontal slide-out duration for the book-boundary transition (ms). */
  private static readonly BOOK_TRANSITION_MS = 300;
  /** Fraction of the viewport a boundary swipe must cover to commit. */
  private static readonly BOOK_SWIPE_RATIO = 0.25;
  /** Horizontal slop before a drag leaves the hold window (vertical uses axis lock only). */
  private static readonly HORIZONTAL_SLOP_PX = 8;
  /** Per-frame velocity decay while coasting after a pan release (~60fps frame). */
  private static readonly MOMENTUM_DECAY = 0.93;
  /** Coast stops below this px/ms velocity. */
  private static readonly MOMENTUM_STOP_VELOCITY = 0.03;
  /** Fling velocity cap at release (px/ms). */
  private static readonly MOMENTUM_MAX_VELOCITY = 3;

  private holdTimer: number | null = null;
  private holdStartX = 0;
  private holdStartY = 0;
  private panBaseX = 0;
  private panBaseY = 0;
  private gestureAxis: GestureAxis | null = null;
  /** True while a downward swipe is being treated as a dismiss gesture. */
  private closeDrag = false;
  /** Recent pointer samples during a pan — used to derive release velocity. */
  private panSamples: Array<{ x: number; y: number; t: number }> = [];
  private momentumAxis: GestureAxis | null = null;
  private momentumVelocity = 0;
  private momentumRaf: number | null = null;

  public onStagePointerDown(event: PointerEvent): void {
    if (event.button !== 0) return;
    const stage = this.stageRef()?.nativeElement;
    if (stage === undefined) return;
    // Ignore input while a turn animation is running.
    if (this.flip.flipState() === 'flipping') return;
    // Ignore input while a book-boundary slide is running.
    if (this._transitioning()) return;

    this.stopMomentum();
    this.magnifierState.setHolding(true);
    this.gestureAxis = null;

    const rect = stage.getBoundingClientRect();
    this._hostRect.set(rect);
    this._viewportWidth.set(window.innerWidth);
    this._viewportHeight.set(window.innerHeight);
    this.pointerX.set(event.clientX);
    this.pointerY.set(event.clientY);
    this.holdStartX = event.clientX;
    this.holdStartY = event.clientY;
    this.clearHoldTimer();
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      this.magnifierState.setActive(true);
    }, ViewerPage.HOLD_MS);

    try {
      stage.setPointerCapture(event.pointerId);
    } catch {
      // Best-effort — some browsers reject capture.
    }
  }

  public onStagePointerMove(event: PointerEvent): void {
    const dx = event.clientX - this.holdStartX;
    const dy = event.clientY - this.holdStartY;

    if (this.bookDragActive && this._transitionDir() !== null) {
      this.followBookDrag(event);
      return;
    }

    if (this.magnifierState.relayFlip()) {
      this.flip.relayPointerMove(this.clampToPageX(event.clientX), event.clientY);
      return;
    }

    if (this.magnifierState.relayPan()) {
      this.applyPanFromDrag(dx, dy);
      this.recordPanSample(event.clientX, event.clientY);
      if (this.gestureAxis === 'horizontal' && this.flipIntent(dx, event.clientX) === 'fold') {
        // Reached the page edge: at a book boundary this starts the book
        // slide; otherwise it hands off to the curl fold at the current
        // pointer (the original hold point may be far away after the pan).
        this.magnifierState.setRelayPan(false);
        const boundary = this.bookBoundaryDirection(dx);
        if (boundary !== null) {
          this.beginBookTransition(boundary);
          this.followBookDrag(event);
        } else {
          this.beginFlipRelay(event.clientX, event.clientY);
          this.flip.relayPointerMove(this.clampToPageX(event.clientX), event.clientY);
        }
      }
      return;
    }

    if (this.magnifierState.active()) {
      this.pointerX.set(event.clientX);
      this.pointerY.set(event.clientY);
      return;
    }

    if (this.holdTimer !== null) {
      this.tryBeginDragRelay(dx, dy, event);
    }
  }

  public onStagePointerUp(event: PointerEvent): void {
    const wasPan = this.magnifierState.relayPan();
    const axis = this.gestureAxis;

    if (this.bookDragActive && this._transitionDir() !== null) {
      const dir = this._transitionDir() as 'next' | 'prev';
      const width = this.hostRect()?.width ?? window.innerWidth;
      const slide = this._bookTransitionX();
      this.bookDragActive = false;
      if (this.shouldCommitBookTransition(dir, slide, width)) {
        void this.commitBookTransition(dir);
      } else {
        this.cancelBookTransition();
      }
      this.clearHoldTimer();
      this.gestureAxis = null;
      this.magnifierState.endGesture();
      return;
    }

    if (this.magnifierState.relayFlip()) {
      // Release: the patched lib completes the fold from its current position
      // (stopMove commits whenever state is USER_FOLD) at any zoom — relay
      // coordinates are unscaled by toBookPoint.
      this.flip.relayPointerUp(this.clampToPageX(event.clientX), event.clientY);
    } else if (!this.magnifierState.active() && !wasPan && this.isQuickTap(event)) {
      if (this.isBottomZoneTap(event.clientY)) {
        this.openPagesMenu();
      } else if (this.bookTapZone(event.clientX) === 'next' && !this.bookstore.hasNext()) {
        void this.commitBookTransition('next');
      } else if (this.bookTapZone(event.clientX) === 'prev' && !this.bookstore.hasPrev()) {
        void this.commitBookTransition('prev');
      } else if (this.bookstore.cornersVisible()) {
        this.flip.relayTap(event.clientX, event.clientY);
      } else {
        this.zoomTapFlip(event.clientX);
      }
    } else if (this.closeDrag) {
      const dy = event.clientY - this.holdStartY;
      const dx = event.clientX - this.holdStartX;
      this.closeDrag = false;
      if (dy > ViewerPage.CLOSE_THRESHOLD && Math.abs(dy) > Math.abs(dx)) {
        this.magnifierState.endGesture();
        this.closeViewer();
        return;
      }
    }

    this.clearHoldTimer();
    this.gestureAxis = null;
    this.magnifierState.endGesture();

    // Fling: keep gliding with the release velocity, decaying each frame.
    if (wasPan && axis !== null) {
      this.startMomentum(axis);
    }
  }

  /** True when pointer release is still within the hold slop (no pan / drag). */
  private isQuickTap(event: PointerEvent): boolean {
    const dx = event.clientX - this.holdStartX;
    const dy = event.clientY - this.holdStartY;
    return (
      dx * dx + dy * dy <=
      ViewerPage.HORIZONTAL_SLOP_PX * ViewerPage.HORIZONTAL_SLOP_PX
    );
  }

  /** True when a tap lands in the bottom strip that opens the pages menu. */
  private isBottomZoneTap(clientY: number): boolean {
    return clientY >= window.innerHeight - ViewerPage.PAGES_MENU_ZONE;
  }

  /**
   * Decide pan vs page-flip once the user moves past slop.
   * Vertical movement pans tall pages; horizontal movement pans until an edge,
   * then hands off to page-flip for the next/prev curl.
   */
  private tryBeginDragRelay(dx: number, dy: number, event: PointerEvent): void {
    const { overflowX, overflowY } = this.panExtents();

    if (
      Math.abs(dx) < ViewerPage.HORIZONTAL_SLOP_PX &&
      Math.abs(dy) < ViewerPage.HORIZONTAL_SLOP_PX
    ) {
      return;
    }

    if (Math.abs(dy) > Math.abs(dx)) {
      this.clearHoldTimer();
      if (overflowY > 0) {
        // At the top of a tall page a downward drag can't pan further, so it's
        // a close gesture (iOS-style top overscroll). Anywhere else it pans.
        if (this.panOffsetY() >= -1 && dy > 0) {
          this.gestureAxis = 'vertical';
          this.closeDrag = true;
          return;
        }
        this.beginPanRelay('vertical');
        this.applyPanFromDrag(dx, dy);
        return;
      }
      // overflowY <= 0 → page fits the height: a downward drag is a close gesture.
      this.gestureAxis = 'vertical';
      this.closeDrag = true;
      return;
    }

    if (Math.abs(dx) < ViewerPage.HORIZONTAL_SLOP_PX) {
      return;
    }

    // Book boundary: a fold gesture past the last/first page starts a book
    // slide instead (the lib has no page to flip there). Pan gestures still
    // pan — only intercept when the drag would otherwise be a page fold.
    const boundary = this.bookBoundaryDirection(dx);
    if (boundary !== null && this.flipIntent(dx, event.clientX) === 'fold') {
      this.beginBookTransition(boundary);
      this.followBookDrag(event);
      return;
    }

    if (this.flipIntent(dx, event.clientX) === 'fold') {
      this.beginFlipRelay();
      this.flip.relayPointerMove(this.clampToPageX(event.clientX), event.clientY);
      return;
    }

    if (overflowX > 0) {
      this.beginPanRelay('horizontal');
      this.applyPanFromDrag(dx, dy);
    }
  }

  private shouldBeginFlipRelay(dx: number): boolean {
    const { overflowX } = this.panExtents();
    if (overflowX <= 0) {
      return Math.abs(dx) >= ViewerPage.HORIZONTAL_SLOP_PX;
    }

    const rtl = this.direction() === 'rtl';
    if (rtl) {
      if (this.atLeftEdge() && dx < -ViewerPage.HORIZONTAL_SLOP_PX) return true;
      if (this.atRightEdge() && dx > ViewerPage.HORIZONTAL_SLOP_PX) return true;
    } else {
      if (this.atRightEdge() && dx < -ViewerPage.HORIZONTAL_SLOP_PX) return true;
      if (this.atLeftEdge() && dx > ViewerPage.HORIZONTAL_SLOP_PX) return true;
    }

    return false;
  }

  private atLeftEdge(): boolean {
    const { overflowX } = this.panExtents();
    if (overflowX <= 0) return true;
    return this.panOffsetX() >= -1;
  }

  private atRightEdge(): boolean {
    const { minX, overflowX } = this.panExtents();
    if (overflowX <= 0) return true;
    return this.panOffsetX() <= minX + 1;
  }

  private applyPanFromDrag(dx: number, dy: number): void {
    const { minX, maxX, minY, maxY } = this.panExtents();

    if (this.gestureAxis === 'vertical') {
      this.panOffsetY.set(clamp(this.panBaseY + dy, minY, maxY));
      return;
    }

    if (this.gestureAxis === 'horizontal') {
      this.panOffsetX.set(clamp(this.panBaseX + dx, minX, maxX));
    }
  }

  private beginPanRelay(axis: GestureAxis): void {
    this.clearHoldTimer();
    this.gestureAxis = axis;
    this.panBaseX = this.panOffsetX();
    this.panBaseY = this.panOffsetY();
    this.magnifierState.setRelayPan(true);
  }

  /** Keep a rolling window of pan positions so release velocity is smooth. */
  private recordPanSample(x: number, y: number): void {
    this.panSamples.push({ x, y, t: performance.now() });
    if (this.panSamples.length > 8) this.panSamples.shift();
  }

  /**
   * Release velocity along `axis`, px/ms. Uses the last sample against the
   * most recent one at least 40ms earlier for stability; tiny velocities
   * (<= 0.15 px/ms) count as a stop so micro-drift never glides.
   */
  private computePanVelocity(axis: GestureAxis): number {
    const samples = this.panSamples;
    if (samples.length < 2) return 0;
    const last = samples[samples.length - 1];
    let ref = samples[0];
    for (let i = samples.length - 2; i >= 0; i--) {
      ref = samples[i];
      if (last.t - samples[i].t >= 40) break;
    }
    const dt = last.t - ref.t;
    if (dt <= 0) return 0;

    const dv = axis === 'horizontal' ? last.x - ref.x : last.y - ref.y;
    let v = dv / dt;
    if (Math.abs(v) < 0.15) return 0;
    const max = ViewerPage.MOMENTUM_MAX_VELOCITY;
    return Math.max(-max, Math.min(max, v));
  }

  /** Glide the page after a pan release, decaying velocity to a stop. */
  private startMomentum(axis: GestureAxis): void {
    this.stopMomentum();
    const velocity = this.computePanVelocity(axis);
    if (velocity === 0) return;

    this.momentumAxis = axis;
    this.momentumVelocity = velocity;
    let last = performance.now();

    const step = (now: number): void => {
      const dt = Math.min(32, now - last);
      last = now;
      this.momentumVelocity *= Math.pow(ViewerPage.MOMENTUM_DECAY, dt / 16.667);

      const { minX, maxX, minY, maxY } = this.panExtents();
      if (this.momentumAxis === 'horizontal') {
        const next = clamp(this.panOffsetX() + this.momentumVelocity * dt, minX, maxX);
        if (next <= minX || next >= maxX) this.momentumVelocity = 0;
        this.panOffsetX.set(next);
      } else {
        const next = clamp(this.panOffsetY() + this.momentumVelocity * dt, minY, maxY);
        if (next <= minY || next >= maxY) this.momentumVelocity = 0;
        this.panOffsetY.set(next);
      }

      if (Math.abs(this.momentumVelocity) < ViewerPage.MOMENTUM_STOP_VELOCITY) {
        this.momentumRaf = null;
        this.momentumAxis = null;
        return;
      }
      this.momentumRaf = requestAnimationFrame(step);
    };

    this.momentumRaf = requestAnimationFrame(step);
  }

  /** Cancel a running coast and clear velocity history. */
  private stopMomentum(): void {
    if (this.momentumRaf !== null) {
      cancelAnimationFrame(this.momentumRaf);
      this.momentumRaf = null;
    }
    this.momentumAxis = null;
    this.momentumVelocity = 0;
    this.panSamples = [];
  }

  /**
   * Start the interactive curl: hand the pointer off to page-flip's fold
   * (USER_FOLD) so the page follows the finger. The turn commits on release.
   */
  private beginFlipRelay(x?: number, y?: number): void {
    this.clearHoldTimer();
    this.gestureAxis = null;
    this.magnifierState.setRelayFlip(true);
    const px = x ?? this.holdStartX;
    const py = y ?? this.holdStartY;
    if (this.bookstore.cornersVisible()) {
      this.flip.relayPointerDown(px, py);
      return;
    }
    // Zoomed: anchor the fold on the page edge nearest the pull so the curl
    // renders attached to the page even when the pointer starts on the grey.
    const e = this.pageEdges();
    if (e === null) {
      this.flip.relayPointerDown(px, py);
      return;
    }
    const rtl = this.direction() === 'rtl';
    const center = (e.left + e.right) / 2;
    const pullNext = rtl ? px < center : px >= center;
    this.flip.relayPointerDown(pullNext ? e.right : e.left, py);
  }

  /**
   * What a horizontal drag wants: always the interactive curl fold, when the
   * pull side is usable (near 1×: existing edge logic; zoomed: the page side
   * you pull from is on screen — grey surround included).
   */
  private flipIntent(dx: number, clientX: number): 'fold' | null {
    if (Math.abs(dx) < ViewerPage.HORIZONTAL_SLOP_PX) return null;
    if (this.bookstore.cornersVisible()) {
      return this.shouldBeginFlipRelay(dx) ? 'fold' : null;
    }
    return this.zoomedFoldAvailable(clientX) ? 'fold' : null;
  }

  /** Page's visible left/right edges in viewport coords. */
  private pageEdges(): { left: number; right: number } | null {
    const stage = this.hostRect();
    const eff = this.effectivePageSize();
    if (stage === null || eff === null) return null;
    const panX = this.panOffsetX();
    return { left: stage.left + panX, right: stage.left + panX + eff.width };
  }

  /** Clamp a viewport x into the page's visible bounds — drags that start or
   *  end on the grey grab the page's nearest edge instead of a point outside
   *  the book (page-flip's fold math throws for points too far outside). */
  private clampToPageX(clientX: number): number {
    const e = this.pageEdges();
    if (e === null) return clientX;
    return clamp(clientX, e.left, e.right);
  }

  /** Zoomed-out taps: the grey margins belong to the page — tapping the left
   *  or right third flips prev/next (mirrored for RTL) when that page edge is
   *  on screen. */
  private zoomTapFlip(clientX: number): void {
    const stage = this.hostRect();
    const eff = this.effectivePageSize();
    if (stage === null || eff === null) return;

    const panX = this.panOffsetX();
    const leftOn = panX >= -2 && panX <= stage.width;
    const rightOn = panX + eff.width >= 0 && panX + eff.width <= stage.width + 2;

    const x = clientX - stage.left;
    const third = stage.width / 3;
    const rtl = this.direction() === 'rtl';
    if (x < third && (rtl ? leftOn : rightOn)) {
      if (rtl) this.flip.flipNext();
      else this.flip.flipPrev();
    } else if (x > 2 * third && (rtl ? rightOn : leftOn)) {
      if (rtl) this.flip.flipPrev();
      else this.flip.flipNext();
    }
  }

  /**
   * At non-1× zoom the fold preview starts only when the side being pulled
   * is actually on screen (LTR: pull from the right half = next, needs the
   * right page edge visible; left half = prev, needs the left edge). Mirrored
   * for RTL. The grey surround counts as part of the pull zone.
   */
  private zoomedFoldAvailable(clientX: number): boolean {
    const stage = this.hostRect();
    const eff = this.effectivePageSize();
    if (stage === null || eff === null) return false;

    const panX = this.panOffsetX();
    const leftOnScreen = panX >= -2 && panX <= stage.width;
    const rightOnScreen = panX + eff.width >= 0 && panX + eff.width <= stage.width + 2;

    const rtl = this.direction() === 'rtl';
    const x = clientX - stage.left;
    const inNextHalf = rtl ? x < stage.width / 2 : x >= stage.width / 2;

    if (inNextHalf) return rtl ? leftOnScreen : rightOnScreen;
    return rtl ? rightOnScreen : leftOnScreen;
  }

  /** Reset panning; PageFlip centers the book inside its canvas at fit zoom. */
  private resetPan(): void {
    this.panOffsetX.set(0);
    this.panOffsetY.set(0);
  }

  private clearHoldTimer(): void {
    if (this.holdTimer !== null) {
      clearTimeout(this.holdTimer);
      this.holdTimer = null;
    }
  }

  @HostListener('window:blur')
  public onWindowBlur(): void {
    this.clearHoldTimer();
    this.stopMomentum();
    this.gestureAxis = null;
    this.bookDragActive = false;
    this.magnifierState.endGesture();
  }

  @HostListener('document:visibilitychange')
  public onVisibilityChange(): void {
    if (document.hidden) {
      this.clearHoldTimer();
      this.stopMomentum();
      this.gestureAxis = null;
      this.bookDragActive = false;
      this.magnifierState.endGesture();
    }
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildFilterString(filters: FilterSettings): string {
  const parts: string[] = [];
  if (filters.brightness.enabled) parts.push(`brightness(${filters.brightness.value}%)`);
  if (filters.contrast.enabled) parts.push(`contrast(${filters.contrast.value}%)`);
  if (filters.blueLight.enabled && filters.blueLight.value > 0) {
    const s = filters.blueLight.value / 80;
    parts.push(`sepia(${s.toFixed(2)}) hue-rotate(-10deg)`);
  }
  if (filters.grayscale.enabled) {
    parts.push('grayscale(100%)');
  }
  if (filters.sepia.enabled && filters.sepia.value > 0) {
    parts.push(`sepia(${filters.sepia.value}%)`);
  }
  if (filters.grain.enabled && filters.grain.value > 0) {
    const jitter = 100 - filters.grain.value / 2;
    parts.push(`brightness(${jitter.toFixed(0)}%)`);
  }
  return parts.length > 0 ? parts.join(' ') : 'none';
}
