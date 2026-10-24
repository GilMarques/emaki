import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import type { Book, Page } from '../models/book.model';
import { BookstoreService } from './bookstore.service';
import { FilePageService } from './file-page.service';
import { PageAssetService, cacheKeyString, sourceHashFor } from './page-asset.service';
import { SettingsService } from './settings.service';
import { RealEsrganPluginService } from '../native/real-esrgan.plugin';
import { TaskManagerService } from '../tasks/task-manager.service';
import type { TaskStatus } from '../tasks/task-manager.model';
import {
  DEFAULT_ENHANCEMENT_SETTINGS,
  isComplete,
  type EnhancementCacheKey,
  type EnhancementCapabilities,
  type EnhancementError,
  type EnhancementPageState,
  type EnhancementSettings,
  type EnhancementStatus,
} from '../models/scan-enhancement.model';

const STORAGE_PREFIX = 'openviewer:enhancement:';
/** Per-series window state (budget bookkeeping, frontier). */
const SERIES_PREFIX = 'openviewer:enhancement-series:';

/**
 * Fallback size of one enhanced page when nothing has been measured yet.
 * Measured on device: a 1800 px WebP derivative of a typical manga page is
 * ~450 KB.
 */
const DEFAULT_BYTES_PER_PAGE = 450 * 1024;

/**
 * A series being enhanced under a rolling disk budget.
 *
 * `bookIds` is the series in reading order. `frontier` is the next book to
 * enhance; `anchor` is the book the reader is on (or last was). The window
 * rolls forward as the reader moves: books ahead of the anchor are queued
 * until the budget is full, and the oldest enhanced books are dropped to
 * make room for the next ones.
 */
interface SeriesWindow {
  readonly seriesId: string;
  /** The series in reading order. Mutable: a book the user removed leaves
   *  the window so it is not quietly queued again. */
  bookIds: string[];
  frontier: number;
  anchor: number;
}

/** Public snapshot of a series' budget usage, for the UI. */
export interface SeriesEnhancementState {
  readonly seriesId: string;
  /** Budget in bytes (0 = unlimited). */
  readonly budgetBytes: number;
  /** Bytes the enhanced derivatives of this series currently occupy. */
  readonly usedBytes: number;
  /** How many of the series' books are enhanced right now. */
  readonly booksEnhanced: number;
  /** How many books the series has. */
  readonly booksTotal: number;
}
/**
 * Tile size handed to the native engine (0 = let it pick). `realsr.cpp` syncs
 * the GPU after every tile, so tiny tiles dominate the runtime: on a Dimensity
 * 900, 32 px took 40 s for a 1200×1800 page, 256 px takes 12.6 s. 256 is also
 * well under the VRAM that made 512 risky on this class of device.
 */
const TILE_SIZE = 256;

interface InternalJob {
  readonly bookId: string;
  /** Human title for the task list. */
  title: string;
  pages: readonly Page[];
  state: Map<number, EnhancementPageState>;
  enabled: boolean;
  /** Settings snapshot used for this job's cache keys. */
  settings: EnhancementSettings;
  /** Currently running native job for this book, or null when idle. */
  currentJob: { jobId: string; index: number; cacheKey: string } | null;
  jobCounter: number;
}

interface ActiveSlot {
  readonly bookId: string;
  readonly jobId: string;
}

/**
 * Drives local, on-device scan enhancement.
 *
 * Book-scoped: every book that is being or has been enhanced owns an
 * `InternalJob` (its own page state, settings snapshot, and in-flight job).
 * Only ONE native job runs at a time across all books (the engine is single
 * slot), so `pump()` serializes work and always prioritizes the book currently
 * open in the reader.
 *
 * The reader's display resolver (`displayUrlFor`) consults ONLY the open book's
 * job, so a background job for a different book can never leak its derivatives
 * into the reader. State is persisted per book so an interrupted book resumes.
 *
 * The service does NOT mutate the original page bytes — it only records a
 * separate enhanced URI per page.
 */
@Injectable({ providedIn: 'root' })
export class ScanEnhancementService {
  private readonly bookstore = inject(BookstoreService);
  private readonly plugin = inject(RealEsrganPluginService);
  private readonly assets = inject(PageAssetService);
  private readonly filePages = inject(FilePageService);
  private readonly tasks = inject(TaskManagerService);
  private readonly appSettings = inject(SettingsService);

  private readonly _capabilities = signal<EnhancementCapabilities>({
    available: false,
    backend: 'none',
    models: [],
    maxDimension: 0,
  });
  public readonly capabilities = this._capabilities.asReadonly();

  /** User-facing preferences (model/scale/denoise/quality) for the open book. */
  private readonly _settings = signal<EnhancementSettings>({
    ...DEFAULT_ENHANCEMENT_SETTINGS,
  });
  public readonly settings = this._settings.asReadonly();

  /** Id of the book open in the reader — the only job `displayUrlFor` reads. */
  private readonly _displayedBookId = signal<string | null>(null);
  public readonly displayedBookId = this._displayedBookId.asReadonly();

  /** All enhancement jobs, keyed by book id. */
  private readonly _jobs = signal<Map<string, InternalJob>>(new Map());

  /** Bumped whenever any page reaches `complete`, so the reader can refresh. */
  private readonly _revision = signal(0);
  public readonly revision = this._revision.asReadonly();

  private readonly _paused = signal(false);
  public readonly paused = this._paused.asReadonly();

  /** The single running native job across all books, or null when idle. */
  private _activeSlot: ActiveSlot | null = null;
  /** Counter for native job ids. Must be unique across books: the id is the
   *  token that tells a late completion from the current one, and a per-book
   *  counter let two books share 'job-1' — so a stale completion from the
   *  book you just left was accepted as the new book's work. */
  private jobCounter = 0;
  /** True while the Android foreground service is keeping the batch alive. */
  private _fgActive = false;
  private persistScheduled = false;

  /** Book ids whose derivatives are queued for garbage collection, keyed by
   *  book id → derivative URIs still on disk. Files are only deleted once the
   *  book is confirmed unused (not displayed, no active job, no live blob). */
  private readonly _gcQueue = new Map<string, readonly string[]>();

  /** Series being enhanced under a rolling budget, keyed by series id. */
  private readonly _series = new Map<string, SeriesWindow>();

  /** Budget snapshot per series, for the UI. */
  private readonly _seriesStates = signal<ReadonlyMap<string, SeriesEnhancementState>>(
    new Map(),
  );
  public readonly seriesStates = this._seriesStates.asReadonly();

  constructor() {
    // Track the open book so displayUrlFor always resolves against it.
    effect(() => {
      const book = this.bookstore.state().book;
      this._displayedBookId.set(book ? book.id : null);
      // Closing the reader is a safe point to dispose queued derivatives.
      this.gc();
      if (book !== null) {
        // The rolling window follows the reader: the book being read anchors
        // the series it belongs to.
        this.anchorSeries(book.id);
        untracked(() => void this.restoreForOpenBook(book));
      }
    });

    // Persist on any state change (settings or any job map), debounced.
    effect(() => {
      this._settings();
      this._jobs();
      this.schedulePersist();
    });
  }

  // ─────────────────────────────── Queries ───────────────────────────────

  public readonly isSupported = computed(() => this._capabilities().available);

  /** True when the open book is open, enabled, and a backend is available. */
  public readonly isActive = computed(() => {
    const id = this._displayedBookId();
    if (id === null) return false;
    const job = this._jobs().get(id);
    return !!job?.enabled && this._capabilities().available;
  });

  public readonly canEnable = computed(
    () => this.bookstore.state().book !== null && this._capabilities().available,
  );

  public statusFor(index: number): EnhancementStatus {
    const id = this._displayedBookId();
    if (id === null) return 'idle';
    return this._jobs().get(id)?.state.get(index)?.status ?? 'idle';
  }

  public enhancedUriFor(index: number): string | null {
    const id = this._displayedBookId();
    if (id === null) return null;
    const s = this._jobs().get(id)?.state.get(index);
    return isComplete(s) ? s!.enhancedUri : null;
  }

  /** Resolve the URL to render: enhanced derivative when ready, else original.
   *  Reads ONLY the open book's job, so background jobs never leak in. */
  public displayUrlFor(page: Page): string {
    const displayedId = this._displayedBookId();
    const book = this.bookstore.state().book;
    const fsFolder = book !== null && book.source?.type === 'folder';
    if (displayedId !== null && this._capabilities().available) {
      const job = this._jobs().get(displayedId);
      if (job?.enabled) {
        const s = job.state.get(page.index);
        if (isComplete(s)) {
          const uri = s!.enhancedUri!;
          // Real on-disk derivatives (Tauri) must be turned into a loadable blob
          // URL like originals; logical URIs (web / future native) pass through.
          const out =
            uri.startsWith('enhanced://') || uri.startsWith('data:')
              ? uri
              : this.filePages.displayUrl(uri);
          return out;
        }
      }
    }
    return fsFolder ? this.filePages.displayUrl(page.url) : page.url;
  }

  /** Progress for the open book (reader UI). */
  public readonly progress = computed(() => this.progressForBook(this._displayedBookId()));

  /** Progress for any book, or zeros when unknown. */
  public progressForBook(bookId: string | null): { done: number; total: number; processing: number } {
    if (bookId === null) return { done: 0, total: 0, processing: 0 };
    const job = this._jobs().get(bookId);
    if (job === undefined) return { done: 0, total: 0, processing: 0 };
    let done = 0;
    let total = 0;
    let processing = 0;
    for (const s of job.state.values()) {
      total++;
      if (s.status === 'complete') done++;
      else if (s.status === 'processing') processing++;
    }
    return { done, total, processing };
  }

  /** True when every page of a book has a completed enhanced derivative. Reads
   *  the persisted record so it works even if the job isn't loaded in memory.
   *  Reacts to `revision` so the shelf badge updates live as pages complete. */
  public hasEnhanced(bookId: string): boolean {
    this._revision();
    const job = this._jobs().get(bookId);
    if (job !== undefined) {
      if (job.pages.length === 0) return false;
      for (let i = 0; i < job.pages.length; i++) {
        if (!isComplete(job.state.get(i))) return false;
      }
      return true;
    }
    if (typeof localStorage === 'undefined') return false;
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + bookId);
      if (raw === null) return false;
      const parsed = JSON.parse(raw) as { pages?: EnhancementPageState[] };
      const pages = parsed.pages ?? [];
      return pages.length > 0 && pages.every((s) => isComplete(s));
    } catch {
      return false;
    }
  }

  /** True while a book currently has enhancement work left to do (job enabled,
   *  some pages pending/queued/processing). Reacts to `revision`. */
  public isEnhancing(bookId: string): boolean {
    this._revision();
    const job = this._jobs().get(bookId);
    if (job === undefined || !job.enabled) return false;
    const p = this.progressForBook(bookId);
    return p.total > 0 && p.done < p.total;
  }

  // ─────────────────────────────── Controls ───────────────────────────────

  /** Begin (or resume) enhancement for the open book. Idempotent. */
  public async enable(book: Book): Promise<void> {
    // Switching the open book must drop any in-flight job from another book.
    if (this._activeSlot && this._activeSlot.bookId !== book.id) {
      await this.cancelInFlight();
    }
    // Resolve capabilities first so the job captures a model the backend bundles.
    await this.refreshCapabilities();
    const job = this.getOrCreateJob(book);
    // Upgrade a legacy persisted 4× job to the 2× default when a 2× is bundled.
    this.applyDefaultModel(job);
    job.enabled = true;
    this._displayedBookId.set(book.id);
    job.state = this.loadPersisted(book.id, job.pages, job.settings) ?? this.seedPending(book.id, job.pages, job.settings);
    this._jobs.update((m) => new Map(m).set(book.id, job));
    this.syncTask(job);
    void this.pump();
  }

  /** Stop enhancement for the open book, fall back to originals, keep derivatives. */
  public async disable(): Promise<void> {
    const id = this._displayedBookId();
    if (id === null) return;
    const job = this._jobs().get(id);
    if (job) {
      job.enabled = false;
      if (this._activeSlot?.bookId === id) await this.cancelInFlight();
      this.demoteIncomplete(job);
      this._jobs.update((m) => new Map(m).set(id, { ...job }));
      this.syncTask(job);
    }
    this._paused.set(false);
    await this.syncForeground();
  }

  public async toggle(book: Book): Promise<void> {
    if (this.isActive() && this._displayedBookId() === book.id) {
      await this.disable();
    } else {
      await this.enable(book);
    }
  }

  /** Stop enhancement for a specific book (background or open) without opening it.
   *  Derivatives are kept; in-flight work is cancelled; the tray auto-hides. */
  public async stopBook(bookId: string): Promise<void> {
    const job = this._jobs().get(bookId);
    if (job === undefined) return;
    job.enabled = false;
    if (this._activeSlot?.bookId === bookId) await this.cancelInFlight();
    this.demoteIncomplete(job);
    this._jobs.update((m) => new Map(m).set(bookId, { ...job }));
    this.syncTask(job);
    void this.syncForeground();
  }

  /** Remove a book's enhanced derivatives.
   *
   *  The persisted record and in-memory job are cleared immediately (the badge
   *  flips, originals are served again), but the derivative FILES are only
   *  garbage-collected once they are confirmed unused — the book is no longer
   *  displayed and no derivative is loaded as a blob. Until then a re-enhance
   *  is free, because pump() skips pages whose destination already exists.
   */
  public removeEnhancement(bookId: string): void {
    // Take the book out of its series window: the user asked for it to stop
    // being enhanced, and the rolling window must not queue it again.
    for (const series of this._series.values()) {
      const index = series.bookIds.indexOf(bookId);
      if (index < 0) continue;
      series.bookIds = series.bookIds.filter((id) => id !== bookId);
      if (index < series.frontier) series.frontier--;
      if (index < series.anchor) series.anchor--;
      series.frontier = Math.max(0, Math.min(series.frontier, series.bookIds.length));
      series.anchor = Math.max(0, Math.min(series.anchor, Math.max(0, series.bookIds.length - 1)));
      this.persistSeries(series);
      this.publishSeriesState(series);
    }
    const job = this._jobs().get(bookId);
    const uris = this.collectDerivativeUris(bookId);
    // Stop any in-flight work for this book.
    if (this._activeSlot?.bookId === bookId) {
      void this.cancelInFlight();
      this._activeSlot = null;
    }
    if (job !== undefined) {
      job.enabled = false;
      this._jobs.update((m) => {
        const next = new Map(m);
        next.delete(bookId);
        return next;
      });
    }
    this.tasks.remove(bookId, 'upscale');
    // Drop the persisted record so the tile shows unenhanced right away.
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(STORAGE_PREFIX + bookId);
      } catch {
        // ignore
      }
    }
    if (uris.length > 0) {
      // Merge, don't replace: derivatives superseded by a re-enhancement are
      // queued too, and they are just as dead as the ones still in the job.
      const queued = this._gcQueue.get(bookId) ?? [];
      this._gcQueue.set(bookId, [...new Set([...queued, ...uris])]);
      this.gc();
    }
    this._revision.update((r) => r + 1);
  }

  /** Queue a single derivative for disposal. The file is deleted once the book
   *  is confirmed unused — see {@link gc}. */
  private queueForGc(bookId: string, uri: string): void {
    const queued = this._gcQueue.get(bookId) ?? [];
    if (queued.includes(uri)) return;
    this._gcQueue.set(bookId, [...queued, uri]);
    this.gc();
  }

  /** Collect every on-disk derivative URI for a book (in-memory or persisted). */
  private collectDerivativeUris(bookId: string): string[] {
    const out = new Set<string>();
    const job = this._jobs().get(bookId);
    if (job !== undefined) {
      for (const s of job.state.values()) {
        if (isComplete(s) && s.enhancedUri) out.add(s.enhancedUri);
      }
    }
    if (typeof localStorage !== 'undefined') {
      try {
        const raw = localStorage.getItem(STORAGE_PREFIX + bookId);
        if (raw !== null) {
          const parsed = JSON.parse(raw) as { pages?: EnhancementPageState[] };
          for (const s of parsed.pages ?? []) {
            if (isComplete(s) && s.enhancedUri) out.add(s.enhancedUri);
          }
        }
      } catch {
        // ignore
      }
    }
    return [...out];
  }

  /** Dispose queued derivatives once their books are confirmed unused. A book
   *  counts as in-use while it is the open reader book, while it has an active
   *  native job, or while any of its derivatives is cached as a live blob. */
  private gc(): void {
    for (const [bookId, uris] of [...this._gcQueue]) {
      if (bookId === this._displayedBookId()) continue;
      if (this._activeSlot?.bookId === bookId) continue;
      if (uris.some((u) => this.filePages.isLoaded(u))) continue;
      this._gcQueue.delete(bookId);
      void Promise.all(uris.map((u) => this.assets.delete(u))).then(() => {
        this._revision.update((r) => r + 1);
      });
    }
  }

  /** Enhance a book in the BACKGROUND (does not open it, does not affect the
   *  reader). Safe to call for a book that is not currently open.
   *
   *  A single book is just a series of one, so it goes through the same
   *  budget machinery: the book is enhanced even when it is bigger than the
   *  budget, but a second book would have to wait for the first to be
   *  dropped. */
  public async enhanceBook(book: Book): Promise<void> {
    await this.enhanceSeries(book.id, [book]);
  }

  /**
   * Enhance a series (a folder of books) in the background, under a rolling
   * disk budget.
   *
   * The window is anchored on the book the reader is on (or last was) and
   * rolls forward from there: books ahead of the anchor are queued until the
   * budget is full, and the oldest enhanced books are dropped as the window
   * moves on. The book being read, and the one just finished, are never the
   * first to go.
   */
  public async enhanceSeries(seriesId: string, books: readonly Book[]): Promise<void> {
    await this.refreshCapabilities();
    if (books.length === 0) return;
    const bookIds = books.map((b) => b.id);
    const restored = this._series.get(seriesId) ?? this.readSeries(seriesId);
    const series: SeriesWindow = {
      seriesId,
      bookIds,
      frontier: Math.min(restored?.frontier ?? 0, bookIds.length),
      anchor: Math.min(restored?.anchor ?? 0, Math.max(0, bookIds.length - 1)),
    };
    this._series.set(seriesId, series);

    // Anchor on the book being read, if it belongs to this series.
    const displayed = this._displayedBookId();
    const at = displayed === null ? -1 : bookIds.indexOf(displayed);
    if (at >= 0) {
      series.anchor = at;
      series.frontier = Math.max(series.frontier, at);
    }

    for (const book of books) {
      if (book.source.type === 'folder') {
        await this.filePages.preload(book);
      }
      const job = this.getOrCreateJob(book);
      this.applyDefaultModel(job);
      job.state =
        this.loadPersisted(book.id, job.pages, job.settings) ??
        this.seedPending(book.id, job.pages, job.settings);
      this._jobs.update((m) => new Map(m).set(book.id, job));
    }

    this.rebalance(series);
    void this.pump();
  }

  // ─────────────────────────── Rolling window ───────────────────────────

  /** Move the anchor of every series that contains `bookId` to it, and roll
   *  the window forward. Called when the reader opens a book. */
  private anchorSeries(bookId: string): void {
    for (const series of this._series.values()) {
      const index = series.bookIds.indexOf(bookId);
      if (index < 0 || series.anchor === index) continue;
      series.anchor = index;
      // Reading backwards re-opens the window over the books behind the new
      // position: they may have been dropped on the way forward. The same goes
      // for a chapter that was dropped from the far end of the run.
      if (index < series.frontier || this.bookBytes(bookId) === 0) {
        series.frontier = index;
      }
      this.rebalance(series);
      void this.pump();
    }
  }

  /**
   * The book the window hangs on: the one being read, or — when the reader is
   * elsewhere — the last one of this series they opened.
   *
   * Read straight from the bookstore rather than from a cached signal, so the
   * window is never a step behind the reader.
   */
  private anchorFor(series: SeriesWindow): number {
    const book = this.bookstore.state().book;
    if (book !== null) {
      const index = series.bookIds.indexOf(book.id);
      if (index >= 0) return index;
    }
    return series.anchor;
  }

  /** The series a book belongs to, if any. */
  private seriesFor(bookId: string): SeriesWindow | undefined {
    for (const series of this._series.values()) {
      if (series.bookIds.includes(bookId)) return series;
    }
    return undefined;
  }

  /**
   * Roll the window: drop the enhanced books that no longer fit the budget,
   * then queue the books ahead of the reader that do.
   *
   * The budget is measured against COMMITTED bytes — what is on disk plus
   * what the queued books are about to write — otherwise the queue would
   * happily book the whole series before a single page had landed.
   */
  private rebalance(series: SeriesWindow): void {
    const budget = this.budgetBytes();
    const anchor = this.anchorFor(series);
    if (anchor !== series.anchor) {
      series.anchor = anchor;
      // Reading backwards re-opens the window over the books behind the new
      // position: they may have been dropped on the way forward.
      if (anchor < series.frontier) series.frontier = anchor;
    }

    // 1. Give the space back: the books behind the reader are the ones that
    //    have served their purpose. The chapter just finished is protected.
    if (budget > 0) {
      let total = this.committedBytes(series);
      while (total > budget) {
        const victim = this.pickVictim(series);
        if (victim === null) break;
        total -= this.bookCommittedBytes(series, victim);
        this.evictBook(victim);
      }
    }

    // 2. Spend it again: queue the books ahead of the reader. Only the AHEAD
    //    of the window counts against the budget here — the books behind are
    //    on their way out, and the chapter being read is already paid for.
    const perPage = this.averageBytesPerPage(series);
    let ahead = this.aheadCommittedBytes(series);
    while (series.frontier < series.bookIds.length) {
      const bookId = series.bookIds[series.frontier];
      const pages = this._jobs().get(bookId)?.pages.length ?? 0;
      // A book that is already enhanced costs nothing more — it must not stop
      // the queue, or the window could never roll back over it.
      const already = this.bookBytes(bookId);
      const cost = already > 0 ? 0 : Math.round(pages * perPage);
      const single = series.bookIds.length === 1;
      if (!single && budget > 0 && ahead + cost > budget) break;
      this.enableBook(bookId);
      ahead += cost;
      series.frontier++;
    }

    this.persistSeries(series);
    this.publishSeriesState(series);
  }

  /**
   * Pick the book to drop when the series is over budget.
   *
   * Only the books BEHIND the reader are dropped, furthest behind first: the
   * chapters ahead are the ones the reader is about to open, and dropping one
   * would leave a hole in the enhanced run. The book being read and the one
   * just finished are never candidates — the reader keeps the chapter they
   * just closed — and neither is a book with work in flight.
   *
   * When every candidate is protected the series stays a little over budget
   * (by the one protected chapter) rather than punching a hole in the run.
   */
  private pickVictim(series: SeriesWindow): string | null {
    const anchor = series.anchor;
    const behind: string[] = [];
    series.bookIds.forEach((id, index) => {
      if (index >= anchor) return;
      if (index === anchor - 1) return;
      if (id === this._displayedBookId()) return;
      if (this._activeSlot?.bookId === id) return;
      if (this.bookBytes(id) === 0) return;
      behind.push(id);
    });
    return behind.length > 0 ? behind[0] : null;
  }

  /**
   * Drop a book's derivatives and stop enhancing it. The book stays part of
   * the series, so the window can pick it up again if it rolls back.
   */
  private evictBook(bookId: string): void {
    const uris = this.collectDerivativeUris(bookId);
    if (uris.length > 0) {
      const queued = this._gcQueue.get(bookId) ?? [];
      this._gcQueue.set(bookId, [...new Set([...queued, ...uris])]);
    }
    const job = this._jobs().get(bookId);
    if (job !== undefined) {
      job.enabled = false;
      job.state = new Map();
      this._jobs.update((m) => new Map(m).set(bookId, job));
    }
    this.tasks.remove(bookId, 'upscale');
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(STORAGE_PREFIX + bookId);
      } catch {
        // ignore
      }
    }
    this.gc();
    this._revision.update((r) => r + 1);
  }

  /** Queue a book for enhancement (the window decides which ones qualify). */
  private enableBook(bookId: string): void {
    const job = this._jobs().get(bookId);
    if (job === undefined) return;
    if (!job.enabled) {
      job.enabled = true;
      if (job.state.size === 0) {
        job.state =
          this.loadPersisted(bookId, job.pages, job.settings) ??
          this.seedPending(bookId, job.pages, job.settings);
      }
      this._jobs.update((m) => new Map(m).set(bookId, job));
    }
    this.syncTask(job);
  }

  /** Bytes the enhanced derivatives of one book occupy. */
  private bookBytes(bookId: string): number {
    const job = this._jobs().get(bookId);
    if (job === undefined) return 0;
    let total = 0;
    for (const s of job.state.values()) {
      if (isComplete(s)) total += s.bytes;
    }
    return total;
  }

  /** Bytes the enhanced derivatives of a whole series occupy. */
  private seriesBytes(series: SeriesWindow): number {
    let total = 0;
    for (const id of series.bookIds) total += this.bookBytes(id);
    return total;
  }

  /**
   * Bytes a book occupies once its queued pages are written: what is on disk
   * now plus an estimate for the pages still to come.
   */
  private bookCommittedBytes(series: SeriesWindow, bookId: string): number {
    const job = this._jobs().get(bookId);
    if (job === undefined) return 0;
    const done = this.bookBytes(bookId);
    if (!job.enabled) return done;
    let completed = 0;
    for (const s of job.state.values()) if (isComplete(s)) completed++;
    const remaining = Math.max(0, job.pages.length - completed);
    return done + remaining * this.averageBytesPerPage(series);
  }

  /** What the whole series occupies once its queued work is written. */
  private committedBytes(series: SeriesWindow): number {
    let total = 0;
    for (const id of series.bookIds) total += this.bookCommittedBytes(series, id);
    return total;
  }

  /** What the books AHEAD of the reader occupy once their work is written. */
  private aheadCommittedBytes(series: SeriesWindow): number {
    let total = 0;
    for (let i = series.anchor; i < series.bookIds.length; i++) {
      total += this.bookCommittedBytes(series, series.bookIds[i]);
    }
    return total;
  }

  /** How many of the series' books are enhanced right now. */
  private seriesBookCount(series: SeriesWindow): number {
    let count = 0;
    for (const id of series.bookIds) if (this.bookBytes(id) > 0) count++;
    return count;
  }

  /** Measured average size of an enhanced page in this series. */
  private averageBytesPerPage(series: SeriesWindow): number {
    let bytes = 0;
    let pages = 0;
    for (const id of series.bookIds) {
      const job = this._jobs().get(id);
      if (job === undefined) continue;
      for (const s of job.state.values()) {
        if (!isComplete(s)) continue;
        bytes += s.bytes;
        pages++;
      }
    }
    if (pages === 0) return DEFAULT_BYTES_PER_PAGE;
    return bytes / pages;
  }

  /** The disk budget for one series (0 = unlimited). */
  private budgetBytes(): number {
    return this.appSettings.settings().enhancement.seriesBudgetBytes;
  }

  private publishSeriesState(series: SeriesWindow): void {
    const state: SeriesEnhancementState = {
      seriesId: series.seriesId,
      budgetBytes: this.budgetBytes(),
      usedBytes: this.seriesBytes(series),
      booksEnhanced: this.seriesBookCount(series),
      booksTotal: series.bookIds.length,
    };
    this._seriesStates.update((m) => new Map(m).set(series.seriesId, state));
  }

  private persistSeries(series: SeriesWindow): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(
        SERIES_PREFIX + series.seriesId,
        JSON.stringify({
          bookIds: series.bookIds,
          frontier: series.frontier,
          anchor: series.anchor,
        }),
      );
    } catch {
      // ignore
    }
  }

  /** Read a persisted window so a restart doesn't start the series over. */
  private readSeries(seriesId: string): { frontier: number; anchor: number } | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(SERIES_PREFIX + seriesId);
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as { frontier?: unknown; anchor?: unknown };
      return {
        frontier: typeof parsed.frontier === 'number' ? parsed.frontier : 0,
        anchor: typeof parsed.anchor === 'number' ? parsed.anchor : 0,
      };
    } catch {
      return null;
    }
  }

  public pause(): void {
    this._paused.set(true);
    void this.stopForeground();
  }

  public resume(): void {
    this._paused.set(false);
    void this.pump();
  }

  /** Cancel a single page's work in the open book (or its queued slot). */
  public async cancelPage(index: number): Promise<void> {
    const id = this._displayedBookId();
    if (id === null) return;
    const job = this._jobs().get(id);
    if (job === undefined) return;
    if (this._activeSlot?.bookId === id && job.currentJob?.index === index) {
      await this.cancelInFlight();
    }
    this.updateJobState(id, (map) => {
      const st = map.get(index);
      if (st === undefined) return map;
      if (st.status === 'processing' || st.status === 'queued' || st.status === 'pending') {
        const next = new Map(map);
        next.set(index, { ...st, status: 'cancelled', error: null });
        return next;
      }
      return map;
    });
  }

  /** Change a model/scale/denoise/quality setting for the OPEN book. Any such
   *  change invalidates the open book's derivatives and requeues it. */
  public async updateSettings(patch: Partial<EnhancementSettings>): Promise<void> {
    const prev = this._settings();
    const next = { ...prev, ...patch };
    const invalidates =
      prev.model !== next.model ||
      prev.scale !== next.scale ||
      prev.denoise !== next.denoise ||
      prev.outputQuality !== next.outputQuality ||
      prev.maxOutputWidth !== next.maxOutputWidth;
    this._settings.set(next);

    const id = this._displayedBookId();
    if (id === null) return;
    const job = this._jobs().get(id);
    if (job === undefined) return;
    job.settings = { ...next };
    if (invalidates) {
      await this.invalidateJob(job);
      // The job is what runs, not the global `enabled` flag (which is only
      // set per book) — gating on it meant a model change silently stopped
      // the enhancement.
      if (job.enabled) void this.pump();
    }
  }

  // ─────────────────────────────── Engine ───────────────────────────────

  /** Load (or reload) what the device can do. Cheap; safe to call on open. */
  public async refreshCapabilities(): Promise<void> {
    try {
      const caps = await this.plugin.getCapabilities();
      this._capabilities.set(caps);
      // The backend only bundles specific model ids; if the current choice
      // isn't among them, snap to the preferred (2×) one so enhancePage never
      // fails with "model … is not bundled".
      //
      // We also bias toward 2× when a 2× net is available: 4× is "overkill" for
      // comics and far slower. This auto-upgrades a legacy persisted 4× (saved
      // before 2× existed) to the 2× default, while a deliberately chosen 2× or
      // any other bundled id is left untouched.
      if (caps.available && caps.models.length > 0) {
        const cur = this._settings().model;
        const preferred = preferredModel(caps.models);
        const twoXAvailable = caps.models.some((m) => isTwoX(m));
        if (!caps.models.includes(cur) || (isFourX(cur) && twoXAvailable)) {
          this._settings.update((s) => ({ ...s, model: preferred, scale: scaleOf(preferred) }));
        }
      }
    } catch (err) {
      this._capabilities.set({ available: false, backend: 'none', models: [], maxDimension: 0 });
    }
  }

  /**
   * Load a book's persisted enhancement record the first time it is opened.
   *
   * Jobs only live in memory otherwise, so a book enhanced in an earlier session
   * rendered its originals until the user tapped Enhance again. Restoring also
   * resumes an enabled job (it was left enabled on purpose).
   */
  private async restoreForOpenBook(book: Book): Promise<void> {
    if (this._jobs().has(book.id)) return;
    const persisted = this.readPersisted(book.id);
    if (persisted === null || persisted.pages === 0) return;

    await this.refreshCapabilities();
    if (!this.isSupported()) return;
    // The reader may have moved on while capabilities were resolving.
    if (this._displayedBookId() !== book.id || this._jobs().has(book.id)) return;

    const job = this.getOrCreateJob(book);
    job.enabled = persisted.enabled;
    job.state =
      this.loadPersisted(book.id, book.pages, job.settings) ??
      this.seedPending(book.id, book.pages, job.settings);
    this._jobs.update((m) => new Map(m).set(book.id, job));
    // Let the reader re-resolve page URLs to the restored derivatives.
    this._revision.update((r) => r + 1);
    if (job.enabled) {
      this.syncTask(job);
      void this.pump();
    }
  }

  /** Minimal persisted record, enough to decide whether to restore a job. */
  private readPersisted(bookId: string): { enabled: boolean; pages: number } | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + bookId);
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as { enabled?: boolean; pages?: unknown[] };
      return { enabled: parsed.enabled === true, pages: parsed.pages?.length ?? 0 };
    } catch {
      return null;
    }
  }

  /** Pick the next (book, index) to process, prioritizing the open book. */  private nextTarget(): { bookId: string; index: number } | null {
    const displayed = this._displayedBookId();
    const jobs = this._jobs();

    const consider = (bookId: string | null): { bookId: string; index: number } | null => {
      if (bookId === null) return null;
      const job = jobs.get(bookId);
      if (job === undefined || !job.enabled) return null;
      const current = this.bookstore.currentPage()?.index ?? 0;
      const order = this.priorityOrder(job.pages, current);
      for (const i of order) {
        const st = job.state.get(i);
        if (st && (st.status === 'pending' || st.status === 'queued')) return { bookId, index: i };
      }
      return null;
    };

    const displayedTarget = consider(displayed);
    if (displayedTarget) return displayedTarget;
    for (const bookId of this.targetOrder()) {
      if (bookId === displayed) continue;
      const t = consider(bookId);
      if (t) return t;
    }
    return null;
  }

  /**
   * The order books are worked in: the one being read first, then the books
   * of every series in reading order, then the rest.
   *
   * Series order matters — the whole point of the rolling window is that the
   * chapters ahead of the reader are the ones that get enhanced next, so the
   * reader never runs into an unenhanced chapter.
   */
  private targetOrder(): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (id: string | null): void => {
      if (id === null || seen.has(id)) return;
      if (!this._jobs().has(id)) return;
      seen.add(id);
      out.push(id);
    };
    push(this._displayedBookId());
    for (const series of this._series.values()) {
      for (const id of series.bookIds) push(id);
    }
    for (const id of this._jobs().keys()) push(id);
    return out;
  }

  private priorityOrder(pages: readonly Page[], current: number): number[] {
    const total = pages.length;
    if (total === 0) return [];
    const window = 3;
    const ranked = new Map<number, number>();
    for (let i = 0; i < total; i++) {
      const dist = Math.abs(i - current);
      let rank: number;
      if (i === current) rank = 0;
      else if (dist === 1) rank = 1;
      else if (dist <= window) rank = 2;
      else rank = 3;
      ranked.set(i, rank);
    }
    return [...ranked.keys()].sort((a, b) => {
      const ra = ranked.get(a)!;
      const rb = ranked.get(b)!;
      if (ra !== rb) return ra - rb;
      return Math.abs(a - current) - Math.abs(b - current) || a - b;
    });
  }

  /** Live completion counts across all enabled jobs (error pages don't count). */
  private jobCounts(): { done: number; remaining: number } {
    let done = 0;
    let remaining = 0;
    for (const job of this._jobs().values()) {
      if (!job.enabled) continue;
      for (const s of job.state.values()) {
        if (isComplete(s)) done++;
        else if (s.status !== 'error') remaining++;
      }
    }
    return { done, remaining };
  }

  /** Start the Android foreground service once per batch (no-op elsewhere). */
  private async ensureForeground(): Promise<void> {
    if (this._fgActive) return;
    const { done, remaining } = this.jobCounts();
    await this.plugin.startForeground({ done, total: done + remaining });
    this._fgActive = true;
  }

  /** Update the notification; stop the service once no work remains. */
  private async syncForeground(): Promise<void> {
    if (!this._fgActive) return;
    const { done, remaining } = this.jobCounts();
    if (remaining === 0) {
      this._fgActive = false;
      await this.plugin.stopForeground();
    } else {
      await this.plugin.updateForeground({ done, total: done + remaining });
    }
  }

  /** Force-stop the foreground service (pause / explicit stop). */
  private async stopForeground(): Promise<void> {
    if (!this._fgActive) return;
    this._fgActive = false;
    await this.plugin.stopForeground();
  }

  private async pump(): Promise<void> {
    if (this._paused()) return;
    if (!this._capabilities().available) {
      console.warn('[enhance] pump → capabilities not available, aborting');
      return;
    }
    if (this._activeSlot !== null) return; // one native job at a time

    const target = this.nextTarget();
    if (target === null) {
      console.log('[enhance] pump → no target (nothing pending/enabled)');
      return;
    }

    const job = this._jobs().get(target.bookId);
    if (job === undefined || !job.enabled) return;

    const page = job.pages[target.index];
    if (page === undefined) return;

    const settings = job.settings;
    const sourceHash = sourceHashFor(page.url);
    const key: EnhancementCacheKey = {
      bookId: job.bookId,
      pageIndex: target.index,
      sourceHash,
      model: settings.model,
      scale: settings.scale,
      denoise: settings.denoise,
      outputQuality: settings.outputQuality,
      maxOutputWidth: settings.maxOutputWidth,
    };
    const cacheKey = cacheKeyString(key);
    const destinationUri = this.assets.buildDestinationUri(key, page.url);

    // Cache hit: the derivative already exists on disk (e.g. it survived a
    // removeEnhancement that hasn't been garbage-collected yet, or a previous
    // run produced it). Mark complete without any native work.
    if (await this.assets.exists(destinationUri)) {
      this.setJobStatus(job, target.index, 'complete', {
        enhancedUri: destinationUri,
        cacheKey,
        sourceHash,
        bytes: await this.assets.sizeOf(destinationUri),
        error: null,
      });
      this._revision.update((r) => r + 1);
      void this.pump();
      return;
    }

    const jobId = `job-${++this.jobCounter}`;

    // A page re-enhanced with different settings (or a different format) leaves
    // the previous derivative behind. Remember it so it can be reclaimed.
    const supersededUri = job.state.get(target.index)?.enhancedUri ?? null;

    job.currentJob = { jobId, index: target.index, cacheKey };
    this._activeSlot = { bookId: job.bookId, jobId };
    this.setJobStatus(job, target.index, 'processing', { enhancedUri: null, cacheKey, sourceHash, error: null });

    try {
      await this.ensureForeground();
      const result = await this.plugin.enhancePage({
        sourceUri: page.url,
        destinationUri,
        scale: settings.scale,
        model: settings.model,
        tileSize: TILE_SIZE,
        denoise: settings.denoise,
        outputQuality: settings.outputQuality,
        maxOutputWidth: settings.maxOutputWidth,
        jobId,
      });
      // Reject stale / wrong-book completions.
      if (this._activeSlot?.jobId !== jobId) return;
      this._activeSlot = null;
      job.currentJob = null;
      await this.assets.markExists(result.destinationUri);
      if (supersededUri !== null && supersededUri !== result.destinationUri) {
        this.queueForGc(job.bookId, supersededUri);
      }
      this.setJobStatus(job, target.index, 'complete', {
        enhancedUri: result.destinationUri,
        cacheKey,
        sourceHash,
        bytes: result.bytes,
        error: null,
      });
      this._revision.update((r) => r + 1);
      await this.syncForeground();
      // The page just landed on disk: roll the series window so the budget
      // still holds and the next book can be queued.
      const series = this.seriesFor(job.bookId);
      if (series !== undefined) this.rebalance(series);
      void this.pump(); // continue the queue
    } catch (err) {
      console.error('[enhance] pump → enhancePage FAILED', err);
      if (this._activeSlot?.jobId !== jobId) return;
      this._activeSlot = null;
      job.currentJob = null;
      const kind = (err as { kind?: string })?.kind ?? 'unknown';
      const message = err instanceof Error ? err.message : String(err);
      if (kind === 'cancelled') {
        this.updateJobState(job.bookId, (map) => {
          const st = map.get(target.index);
          if (st && st.status === 'processing') {
            const next = new Map(map);
            next.set(target.index, { ...st, status: 'idle', error: null });
            return next;
          }
          return map;
        });
        return;
      }
      const error: EnhancementError = { kind: kind as EnhancementError['kind'], message };
      this.setJobStatus(job, target.index, 'error', { enhancedUri: null, cacheKey, sourceHash, error });
      await this.syncForeground();
      void this.pump();
    }
  }

  private async cancelInFlight(): Promise<void> {
    if (this._activeSlot) {
      const id = this._activeSlot.jobId;
      this._activeSlot = null;
      try {
        await this.plugin.cancelPage(id);
      } catch {
        // ignore
      }
    }
  }

  private async invalidateJob(job: InternalJob): Promise<void> {
    if (this._activeSlot?.bookId === job.bookId) await this.cancelInFlight();
    this._paused.set(false);
    const rebuilt = new Map<number, EnhancementPageState>();
    for (let i = 0; i < job.pages.length; i++) {
      const page = job.pages[i];
      const sourceHash = sourceHashFor(page.url);
      const key: EnhancementCacheKey = {
        bookId: job.bookId,
        pageIndex: i,
        sourceHash,
        model: job.settings.model,
        scale: job.settings.scale,
        denoise: job.settings.denoise,
        outputQuality: job.settings.outputQuality,
        maxOutputWidth: job.settings.maxOutputWidth,
      };
      rebuilt.set(i, {
        index: i,
        status: 'pending',
        enhancedUri: null,
        sourceHash,
        cacheKey: cacheKeyString(key),
        bytes: 0,
        error: null,
      });
    }
    job.state = rebuilt;
    this._jobs.update((m) => new Map(m).set(job.bookId, { ...job }));
  }

  private demoteIncomplete(job: InternalJob): void {
    const next = new Map<number, EnhancementPageState>();
    for (const [i, st] of job.state) {
      if (st.status !== 'complete' && st.status !== 'idle') {
        next.set(i, { ...st, status: 'idle', error: null });
      } else {
        next.set(i, st);
      }
    }
    job.state = next;
  }

  // ─────────────────────────────── Job helpers ───────────────────────────────

  private getOrCreateJob(book: Book): InternalJob {
    const existing = this._jobs().get(book.id);
    if (existing) {
      existing.pages = book.pages;
      existing.title = book.title;
      return existing;
    }
    const job: InternalJob = {
      bookId: book.id,
      title: book.title,
      pages: book.pages,
      state: new Map(),
      enabled: false,
      settings: { ...this._settings() },
      currentJob: null,
      jobCounter: 0,
    };
    this._jobs.update((m) => new Map(m).set(book.id, job));
    return job;
  }

  private setJobStatus(
    job: InternalJob,
    index: number,
    status: EnhancementStatus,
    patch: Partial<EnhancementPageState>,
  ): void {
    const prev = job.state.get(index);
    const base: EnhancementPageState = prev ?? {
      index,
      status: 'idle',
      enhancedUri: null,
      sourceHash: patch.sourceHash ?? '',
      cacheKey: patch.cacheKey ?? '',
      bytes: 0,
      error: null,
    };
    const next = new Map(job.state);
    next.set(index, { ...base, ...patch, index, status });
    job.state = next;
    this._jobs.update((m) => new Map(m).set(job.bookId, { ...job }));
    this.syncTask(job);
  }

  private updateJobState(
    bookId: string,
    fn: (map: Map<number, EnhancementPageState>) => Map<number, EnhancementPageState>,
  ): void {
    const job = this._jobs().get(bookId);
    if (job === undefined) return;
    job.state = fn(new Map(job.state));
    this._jobs.update((m) => new Map(m).set(bookId, { ...job }));
    this.syncTask(job);
  }

  /** Mirror this job's progress into the shared TaskManager (upscale list). */
  private syncTask(job: InternalJob): void {
    const { done, total, processing } = this.progressForBook(job.bookId);
    const id = job.bookId;
    if (!job.enabled) {
      this.tasks.remove(id, 'upscale');
      return;
    }
    if (this.tasks.task(id, 'upscale') === undefined) {
      this.tasks.register({ id, kind: 'upscale', title: job.title, total });
    }
    let status: TaskStatus = 'queued';
    if (processing > 0) status = 'processing';
    else if (total > 0 && done >= total) status = 'done';
    else {
      // "Queued" should mean waiting for the single native slot. If this job
      // has nothing runnable left and only failures remain, it is stuck, not
      // queued — otherwise a job whose pages all failed sits at "Queued" forever.
      let runnable = 0;
      let failed = 0;
      for (const s of job.state.values()) {
        if (s.status === 'pending' || s.status === 'queued') runnable++;
        else if (s.status === 'error') failed++;
      }
      if (runnable === 0 && failed > 0) status = 'error';
    }
    this.tasks.update(id, 'upscale', {
      done,
      total,
      status,
      error: status === 'error' ? 'Some pages could not be enhanced' : undefined,
    });
  }

  // ─────────────────────────────── Persistence ───────────────────────────────

  private schedulePersist(): void {
    if (this.persistScheduled) return;
    this.persistScheduled = true;
    queueMicrotask(() => {
      this.persistScheduled = false;
      this.persist();
    });
  }

  private persist(): void {
    if (typeof localStorage === 'undefined') return;
    for (const job of this._jobs().values()) {
      try {
        const payload = JSON.stringify({
          bookId: job.bookId,
          settings: job.settings,
          enabled: job.enabled,
          pages: [...job.state.values()],
        });
        localStorage.setItem(STORAGE_PREFIX + job.bookId, payload);
      } catch {
        // Quota / private mode — in-memory state still works for this session.
      }
    }
  }

  private loadPersisted(
    bookId: string,
    pages: readonly Page[],
    settings: EnhancementSettings,
  ): Map<number, EnhancementPageState> | null {
    if (typeof localStorage === 'undefined') return null;
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + bookId);
      if (raw === null) return null;
      const parsed = JSON.parse(raw) as {
        settings?: EnhancementSettings;
        enabled?: boolean;
        pages?: EnhancementPageState[];
      };
      const map = new Map<number, EnhancementPageState>();
      const storedSettings = parsed.settings
        ? { ...DEFAULT_ENHANCEMENT_SETTINGS, ...parsed.settings }
        : settings;
      for (const st of parsed.pages ?? []) {
        // A non-complete page must be reprocessed; a complete one is verified.
        if (st.status === 'complete') {
          map.set(st.index, { ...st, bytes: typeof st.bytes === 'number' ? st.bytes : 0 });
        } else {
          map.set(st.index, {
            ...st,
            status: 'pending',
            enhancedUri: null,
            bytes: 0,
            error: null,
          });
        }
      }
      // Ensure every page has an entry (covers books whose page count changed).
      for (let i = 0; i < pages.length; i++) {
        if (!map.has(i)) {
          const page = pages[i];
          const sourceHash = sourceHashFor(page.url);
          const key: EnhancementCacheKey = {
            bookId,
            pageIndex: i,
            sourceHash,
            model: storedSettings.model,
            scale: storedSettings.scale,
            denoise: storedSettings.denoise,
            outputQuality: storedSettings.outputQuality,
            maxOutputWidth: storedSettings.maxOutputWidth,
          };
          map.set(i, {
            index: i,
            status: 'pending',
            enhancedUri: null,
            sourceHash,
            cacheKey: cacheKeyString(key),
            bytes: 0,
            error: null,
          });
        }
      }
      return map;
    } catch {
      return null;
    }
  }

  private seedPending(
    bookId: string,
    pages: readonly Page[],
    settings: EnhancementSettings,
  ): Map<number, EnhancementPageState> {
    const map = new Map<number, EnhancementPageState>();
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const sourceHash = sourceHashFor(page.url);
      const key: EnhancementCacheKey = {
        bookId,
        pageIndex: i,
        sourceHash,
        model: settings.model,
        scale: settings.scale,
        denoise: settings.denoise,
        outputQuality: settings.outputQuality,
        maxOutputWidth: settings.maxOutputWidth,
      };
      map.set(i, {
        index: i,
        status: 'pending',
        enhancedUri: null,
        sourceHash,
        cacheKey: cacheKeyString(key),
        bytes: 0,
        error: null,
      });
    }
    return map;
  }

  /** Upgrade a legacy persisted 4× job to the 2× default when a 2× net is
   *  bundled. New jobs already copy the (already-2×) global settings. */
  private applyDefaultModel(job: InternalJob): void {
    const caps = this._capabilities();
    if (!caps.available || caps.models.length === 0) return;
    const cur = job.settings.model;
    if (!caps.models.includes(cur) || (isFourX(cur) && caps.models.some(isTwoX))) {
      const preferred = preferredModel(caps.models);
      job.settings = { ...job.settings, model: preferred, scale: scaleOf(preferred) };
    }
  }
}

// ─────────────────────────────── Model helpers ───────────────────────────────

/** True for 2× model ids (x2 / 2x / v2 nets). */
function isTwoX(id: string): boolean {
  return id.includes('x2') || id.includes('2x') || id.includes('v2');
}

/** True for 4× model ids. */
function isFourX(id: string): boolean {
  return id.includes('x4') || id.includes('4x');
}

/** Upscale factor implied by a model id (2× for x2/v2 nets, else 4×). */
function scaleOf(id: string): 2 | 4 {
  return isTwoX(id) ? 2 : 4;
}

/** Preferred model to snap to: the first 2× net, else the first bundled model. */
function preferredModel(models: readonly string[]): string {
  return models.find((m) => isTwoX(m)) ?? models[0];
}
