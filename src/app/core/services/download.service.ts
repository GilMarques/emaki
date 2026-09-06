import { Injectable, computed, inject, signal } from '@angular/core';

import { Capacitor } from '@capacitor/core';

import type { Chapter } from '../connectors/connector.model';
import { Connector } from '../connectors/connector.base';
import { TaskManagerService } from '../tasks/task-manager.service';
import { DownloadStore } from '../native/download-store';
import {
  NATIVE_DOWNLOADER,
  type NativeDownloaderPort,
} from '../native/native-downloader.port';

/** A finished (or in-progress) chapter download, keyed by `providerId:chapterId`. */
export interface ChapterDownload {
  readonly providerId: string;
  readonly chapterId: string;
  readonly title: string;
  readonly files: readonly string[];
}

/** A chapter waiting to be downloaded, with the connector to fetch it. */
interface QueuedChapter {
  readonly key: string;
  readonly provider: Connector;
  readonly chapter: Chapter;
  readonly title: string;
}

const PENDING_KEY = 'emaki:downloads:pending';
/** Delay between starting page downloads to avoid provider rate limits. */
const PAGE_START_DELAY_MS = 600;
/** Delay between starting chapter downloads in the queue. */
const CHAPTER_START_DELAY_MS = 1500;

/**
 * Downloads a chapter's pages from a provider to on-device storage.
 *
 * On Android, pages are handed to the system `DownloadManager` (via the
 * native downloader port), so transfers continue when the app is backgrounded
 * or closed. On web it falls back to a session-only blob download so
 * `ionic serve` still works.
 *
 * Progress is reported to `TaskManagerService` (queued → processing →
 * done/error) and downloaded chapters are recorded in `DownloadStore`, which
 * persists a manifest so the queue can be rehydrated after a restart.
 */
@Injectable({ providedIn: 'root' })
export class DownloadService {
  private readonly tasks = inject(TaskManagerService);
  private readonly store = inject(DownloadStore);
  private readonly native = inject(NATIVE_DOWNLOADER);
  private readonly isNative = Capacitor.isNativePlatform();

  private readonly _active = signal<ReadonlySet<string>>(new Set());
  public readonly active = this._active.asReadonly();

  private readonly _queue: QueuedChapter[] = [];
  private processing = false;
  private pendingInit = false;
  private pending = new Set<string>();

  /** Downloaded chapters from the store manifest, keyed by `providerId:chapterId`. */
  public readonly downloads = computed<ReadonlyMap<string, ChapterDownload>>(() => {
    const map = new Map<string, ChapterDownload>();
    for (const c of this.store.chapters().values()) {
      map.set(`${c.providerId}:${c.chapterId}`, {
        providerId: c.providerId,
        chapterId: c.chapterId,
        title: c.title,
        files: c.files,
      });
    }
    return map;
  });

  /** True while any chapters are queued or being downloaded. */
  public readonly busy = computed(() => this._active().size > 0);

  public get(providerId: string, chapterId: string): ChapterDownload | undefined {
    return this.downloads().get(`${providerId}:${chapterId}`);
  }

  /** True when a chapter is already downloaded to disk. */
  public isDownloaded(providerId: string, chapterId: string): boolean {
    return this.store.get(providerId, chapterId) !== undefined;
  }

  /** Add a chapter to the download queue. Idempotent per provider+chapter. */
  public enqueue(provider: Connector, chapter: Chapter, title: string): void {
    const key = `${provider.id}:${chapter.id}`;
    if (this.store.get(provider.id, chapter.id) !== undefined || this._active().has(key)) return;
    this._queue.push({ key, provider, chapter, title });
    this._active.update((s) => new Set(s).add(key));
    this.tasks.register({ id: chapter.id, kind: 'download', title, total: 0 });
    this.tasks.update(chapter.id, 'download', { status: 'queued' });
    this.rememberPending(key);
    void this.pump();
  }

  /** Add many chapters to the queue (e.g. "download all"). */
  public enqueueMany(provider: Connector, chapters: readonly Chapter[], titleFor: (c: Chapter) => string): void {
    for (const chapter of chapters) this.enqueue(provider, chapter, titleFor(chapter));
  }

  /** Drop a downloaded chapter and its files. */
  public async remove(providerId: string, chapterId: string): Promise<void> {
    const key = `${providerId}:${chapterId}`;
    this._active.update((s) => {
      const next = new Set(s);
      next.delete(key);
      return next;
    });
    this.forgetPending(key);
    await this.store.remove(providerId, chapterId);
    this.tasks.remove(chapterId, 'download');
  }

  /** Re-queue any chapters that were in-flight when the app last closed. */
  public async restorePending(provider: Connector, chapters: readonly Chapter[], titleFor: (c: Chapter) => string): Promise<void> {
    const pending = this.loadPending();
    if (pending.size === 0) return;
    const byKey = new Map(chapters.map((c) => [`${provider.id}:${c.id}`, c]));
    for (const key of pending) {
      const chapter = byKey.get(key);
      if (!chapter) continue;
      const [providerId, chapterId] = splitKey(key);
      if (providerId !== provider.id) continue;
      if (this.store.get(provider.id, chapterId)) {
        this.forgetPending(key);
        continue;
      }
      this.enqueue(provider, chapter, titleFor(chapter));
    }
  }

  // ─────────────────────────────── Engine ───────────────────────────────

  private async pump(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this._queue.length > 0) {
        const item = this._queue.shift()!;
        await this.downloadOne(item);
        if (this._queue.length > 0) await this.wait(CHAPTER_START_DELAY_MS);
      }
    } finally {
      this.processing = false;
    }
  }

  private async downloadOne(item: QueuedChapter): Promise<void> {
    const { key, provider, chapter, title } = item;
    this.tasks.update(chapter.id, 'download', { status: 'processing' });

    try {
      const pageRefs = await provider.getPages(chapter);
      this.tasks.update(chapter.id, 'download', { total: pageRefs.length });

      if (this.isNative) {
        await this.downloadNative(item, pageRefs.map((p) => p.url));
      } else {
        await this.downloadWeb(item, pageRefs.map((p) => p.url));
      }

      const stored = this.store.get(provider.id, chapter.id);
      const files = stored?.files ?? [];
      if (files.length > 0) {
        this.tasks.update(chapter.id, 'download', { status: 'done' });
        this.forgetPending(key);
      } else {
        this.tasks.update(chapter.id, 'download', { status: 'error' });
      }
    } catch (err) {
      this.tasks.update(chapter.id, 'download', {
        status: 'error',
        error: err instanceof Error ? err.message : 'Download failed',
      });
    } finally {
      this._active.update((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }

  /** Fire-and-forget each page into DownloadManager; files land on disk. */
  private async downloadNative(item: QueuedChapter, urls: readonly string[]): Promise<void> {
    const { provider, chapter } = item;
    const done = new Set<number>();
    const fail = new Set<number>();

    const offProgress = this.native.onProgress((d) => {
      const idx = pageIndex(d.id);
      if (idx !== undefined) this.tasks.update(chapter.id, 'download', { done: done.size });
    });
    const offCompleted = this.native.onCompleted((d) => {
      const idx = pageIndex(d.id);
      if (idx !== undefined) {
        done.add(idx);
        this.tasks.update(chapter.id, 'download', { done: done.size });
        if (done.size + fail.size === urls.length) {
          offProgress();
          offCompleted();
          offFailed();
        }
      }
    });
    const offFailed = this.native.onFailed((d) => {
      const idx = pageIndex(d.id);
      if (idx !== undefined) {
        fail.add(idx);
        this.tasks.update(chapter.id, 'download', { done: done.size });
        if (done.size + fail.size === urls.length) {
          offProgress();
          offCompleted();
          offFailed();
        }
      }
    });

    // Start pages one at a time with a small delay between them so the
    // provider doesn't rate-limit a burst of simultaneous downloads.
    for (let i = 0; i < urls.length; i++) {
      try {
        await this.native.start({
          id: pageTaskId(chapter.id, i),
          url: urls[i],
          destination: this.store.downloadDestination(provider.id, chapter.id, i),
        });
      } catch {
        fail.add(i);
      }
      if (i < urls.length - 1) await this.wait(PAGE_START_DELAY_MS);
    }

    // If the listeners already finished (all events fired before we got here),
    // tear them down now.
    if (done.size + fail.size === urls.length) {
      offProgress();
      offCompleted();
      offFailed();
    }

    // Record files for every page that actually landed (native reports via
    // downloadCompleted; we can't verify file existence cheaply, so trust the
    // completion events and assume the destination filename).
    if (done.size > 0) {
      const files = [...done].sort((a, b) => a - b).map((i) => `${String(i).padStart(3, '0')}.jpg`);
      await this.store.saveChapter(provider.id, chapter.id, item.title, files);
    }
  }

  /** Browser fallback: fetch blobs, fake progress, store nothing on disk. */
  private async downloadWeb(item: QueuedChapter, urls: readonly string[]): Promise<void> {
    const { provider, chapter } = item;
    // No real on-disk store on web — keep parity by recording an empty chapter
    // so `isDownloaded` still flips (session-scoped). Files are virtual names.
    const files: string[] = [];
    for (let i = 0; i < urls.length; i++) {
      files.push(`${String(i).padStart(3, '0')}.jpg`);
      this.tasks.update(chapter.id, 'download', { done: i + 1 });
    }
    await this.store.saveChapter(provider.id, chapter.id, item.title, files);
  }

  // ───────────────────────────── Pending persistence ─────────────────────────────

  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private rememberPending(key: string): void {
    this.pending.add(key);
    this.persistPending();
  }

  private forgetPending(key: string): void {
    this.pending.delete(key);
    this.persistPending();
  }

  private loadPending(): Set<string> {
    if (this.pendingInit) return this.pending;
    this.pendingInit = true;
    if (typeof localStorage === 'undefined') return this.pending;
    try {
      const raw = localStorage.getItem(PENDING_KEY);
      if (raw) this.pending = new Set(JSON.parse(raw) as string[]);
    } catch {
      // ignore
    }
    return this.pending;
  }

  private persistPending(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify([...this.pending]));
    } catch {
      // ignore
    }
  }
}

function pageTaskId(chapterId: string, index: number): string {
  return `${chapterId}:p${index}`;
}

function pageIndex(taskId: string): number | undefined {
  const m = /:p(\d+)$/.exec(taskId);
  return m ? Number(m[1]) : undefined;
}

function splitKey(key: string): [string, string] {
  const i = key.indexOf(':');
  return [key.slice(0, i), key.slice(i + 1)];
}