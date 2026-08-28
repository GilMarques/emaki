import { Injectable, computed, inject, signal } from '@angular/core';

import type { Book, OpenBookState, Page } from '../models/book.model';
import { ShelfService } from './shelf.service';

/**
 * Holds the currently-open book + current page index in memory as signals.
 *
 * This is the runtime store; persistence (favorites, last-opened page per
 * book, bookmarks) is the Bookshelf's concern and lives elsewhere. Don't
 * conflate them — this service is *only* what the Viewer needs right now.
 *
 * v1 navigation is sequential (prev / next / goTo). Swipe gestures will
 * call into these helpers once we add them to ov-page-canvas.
 */
@Injectable({ providedIn: 'root' })
export class BookstoreService {
  private readonly shelf = inject(ShelfService);
  private readonly _state = signal<OpenBookState>({ book: null });

  /** Reactive snapshot of the open-book state. */
  public readonly state = this._state.asReadonly();

  /** Current page, or `null` if no book is open or index is out of range. */
  public readonly currentPage = computed<Page | null>(() => {
    const s = this._state();
    if (s.book === null) return null;
    return s.book.pages[s.currentIndex] ?? null;
  });

  /** True when there is a next page. */
  public readonly hasNext = computed(() => {
    const s = this._state();
    return s.book !== null && s.currentIndex < s.book.pages.length - 1;
  });

  /** True when there is a previous page. */
  public readonly hasPrev = computed(() => {
    const s = this._state();
    return s.book !== null && s.currentIndex > 0;
  });

  /** Open a book. Resets the current index to 0 and the zoom to 1. */
  public openBook(book: Book): void {
    this._zoom.set(1);
    this.shelf.setProgress(book.id, 0);
    this._state.set({ book, currentIndex: 0 });
  }

  /** Open a registered book by id, resuming at its saved progress. */
  public openById(id: string): void {
    const book = this.shelf.byId(id);
    if (book === undefined) return;
    this._zoom.set(1);
    const start = Math.max(0, Math.min(this.shelf.progressFor(id), book.pages.length - 1));
    this._state.set({ book, currentIndex: start });
  }

  /** Close the current book. */
  public closeBook(): void {
    this._state.set({ book: null });
  }

  /** Advance to the next book in the shelf, if there is one. */
  public openNext(): void {
    const s = this._state();
    if (s.book === null) return;
    const nextId = this.shelf.nextBookId(s.book.id);
    if (nextId !== null) this.openById(nextId);
  }

  /** Go to the previous book in the shelf, if there is one. */
  public openPrev(): void {
    const s = this._state();
    if (s.book === null) return;
    const prevId = this.shelf.prevBookId(s.book.id);
    if (prevId !== null) this.openById(prevId);
  }

  /** Advance to the next page. No-op if there isn't one. */
  public next(): void {
    const s = this._state();
    if (s.book === null) return;
    if (s.currentIndex >= s.book.pages.length - 1) return;
    const idx = s.currentIndex + 1;
    this.shelf.setProgress(s.book.id, idx);
    this._state.set({ book: s.book, currentIndex: idx });
  }

  /** Go to the previous page. No-op if there isn't one. */
  public prev(): void {
    const s = this._state();
    if (s.book === null) return;
    if (s.currentIndex <= 0) return;
    const idx = s.currentIndex - 1;
    this.shelf.setProgress(s.book.id, idx);
    this._state.set({ book: s.book, currentIndex: idx });
  }

  /** Jump to an absolute page index. Out-of-range indices clamp. */
  public goTo(index: number): void {
    const s = this._state();
    if (s.book === null) return;
    const clamped = Math.max(0, Math.min(index, s.book.pages.length - 1));
    this.shelf.setProgress(s.book.id, clamped);
    this._state.set({ book: s.book, currentIndex: clamped });
  }

  /** Zoom factor applied to the rendered page quad. 1 = fit-screen.
   *  Reset on book open. v1 only: desktop scroll-wheel zoom (Ctrl/Cmd+wheel
   *  or trackpad pinch). */
  private readonly _zoom = signal(1);
  public readonly zoom = this._zoom.asReadonly();

  /** True when zoom is at (or very near) 1× — the only state where a page
   *  corner sits at a predictable spot for the flip lib's curl (its internal
   *  coords are unscaled). Wheel steps land near 1 but rarely on it, so a
   *  small tolerance keeps flips working instead of locking them out. */
  public readonly cornersVisible = computed(() => Math.abs(this._zoom() - 1) < 0.05);

  /** Apply a multiplicative zoom factor (e.g. wheel delta → 1.1 / 0.9).
   *  Clamped to [0.2, 4] — you can zoom out far past the page bounds
   *  (grey surround) and in up to 4×. No-op on books that aren't open. */
  public setZoom(factor: number): void {
    if (this._state().book === null) return;
    if (!Number.isFinite(factor) || factor <= 0) return;
    const next = Math.min(4, Math.max(0.2, this._zoom() * factor));
    this._zoom.set(next);
  }

  /** Reset zoom to 1 (used on book open + on closing the modal). */
  public resetZoom(): void {
    this._zoom.set(1);
  }
}