import { Injectable, computed, effect, inject, signal } from '@angular/core';

import type { Book, Page } from '../models/book.model';
import { BookstoreService } from './bookstore.service';
import { FilePageService } from './file-page.service';
import { PageAssetService, cacheKeyString, sourceHashFor } from './page-asset.service';
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
const TILE_SIZE = 0; // 0 = native auto

interface InternalJob {
  readonly bookId: string;
  /** Human title for the Manager task list. */
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
  /** True while the Android foreground service is keeping the batch alive. */
  private _fgActive = false;
  private persistScheduled = false;

  constructor() {
    // Track the open book so displayUrlFor always resolves against it.
    effect(() => {
      const book = this.bookstore.state().book;
      this._displayedBookId.set(book ? book.id : null);
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

  /** True when a book has at least one completed enhanced derivative. Reads the
   *  persisted record so it works even if the job isn't loaded in memory. */
  public hasEnhanced(bookId: string): boolean {
    const job = this._jobs().get(bookId);
    if (job !== undefined) {
      for (const s of job.state.values()) if (isComplete(s)) return true;
    }
    if (typeof localStorage === 'undefined') return false;
    try {
      const raw = localStorage.getItem(STORAGE_PREFIX + bookId);
      if (raw === null) return false;
      const parsed = JSON.parse(raw) as { pages?: EnhancementPageState[] };
      return (parsed.pages ?? []).some((s) => isComplete(s));
    } catch {
      return false;
    }
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

  /** Enhance a book in the BACKGROUND (does not open it, does not affect the
   *  reader). Safe to call for a book that is not currently open. */
  public async enhanceBook(book: Book): Promise<void> {
    await this.refreshCapabilities();
    if (book.source.type === 'folder') {
      await this.filePages.preload(book);
    }
    const job = this.getOrCreateJob(book);
    this.applyDefaultModel(job);
    job.enabled = true;
    job.state = this.loadPersisted(book.id, job.pages, job.settings) ?? this.seedPending(book.id, job.pages, job.settings);
    this._jobs.update((m) => new Map(m).set(book.id, job));
    this.syncTask(job);
    void this.pump();
  }

  /** Enhance every book in a series (a folder of books) in the background. */
  public async enhanceSeries(books: readonly Book[]): Promise<void> {
    await this.refreshCapabilities();
    for (const book of books) {
      if (book.source.type === 'folder') {
        await this.filePages.preload(book);
      }
      const job = this.getOrCreateJob(book);
      this.applyDefaultModel(job);
      job.enabled = true;
      job.state = this.loadPersisted(book.id, job.pages, job.settings) ?? this.seedPending(book.id, job.pages, job.settings);
      this._jobs.update((m) => new Map(m).set(book.id, job));
      this.syncTask(job);
    }
    void this.pump();
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
      prev.outputQuality !== next.outputQuality;
    this._settings.set(next);

    const id = this._displayedBookId();
    if (id === null) return;
    const job = this._jobs().get(id);
    if (job === undefined) return;
    job.settings = { ...next };
    if (invalidates) {
      await this.invalidateJob(job);
      if (next.enabled) void this.pump();
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

  /** Pick the next (book, index) to process, prioritizing the open book. */
  private nextTarget(): { bookId: string; index: number } | null {
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
    for (const bookId of jobs.keys()) {
      if (bookId === displayed) continue;
      const t = consider(bookId);
      if (t) return t;
    }
    return null;
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
    };
    const cacheKey = cacheKeyString(key);
    const destinationUri = this.assets.buildDestinationUri(key, page.url);
    const jobId = `job-${++job.jobCounter}`;

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
        jobId,
      });
      // Reject stale / wrong-book completions.
      if (this._activeSlot?.jobId !== jobId) return;
      this._activeSlot = null;
      job.currentJob = null;
      await this.assets.markExists(result.destinationUri);
      this.setJobStatus(job, target.index, 'complete', {
        enhancedUri: result.destinationUri,
        cacheKey,
        sourceHash,
        error: null,
      });
      this._revision.update((r) => r + 1);
      await this.syncForeground();
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
      };
      rebuilt.set(i, {
        index: i,
        status: 'pending',
        enhancedUri: null,
        sourceHash,
        cacheKey: cacheKeyString(key),
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
    this.tasks.update(id, 'upscale', { done, total, status });
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
          map.set(st.index, st);
        } else {
          map.set(st.index, { ...st, status: 'pending', enhancedUri: null, error: null });
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
          };
          map.set(i, {
            index: i,
            status: 'pending',
            enhancedUri: null,
            sourceHash,
            cacheKey: cacheKeyString(key),
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
      };
      map.set(i, {
        index: i,
        status: 'pending',
        enhancedUri: null,
        sourceHash,
        cacheKey: cacheKeyString(key),
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
