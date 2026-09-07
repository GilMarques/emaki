import { Injectable, computed, inject, signal } from '@angular/core';

import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';

import type { Chapter } from '../connectors/connector.model';
import { Connector } from '../connectors/connector.base';
import { ConnectorRequestService } from '../connectors/connector-request.service';
import { TaskManagerService } from '../tasks/task-manager.service';
import { DownloadStore } from '../native/download-store';

/** A finished (or in-progress) chapter download, keyed by `providerId:chapterId`. */
export interface ChapterDownload {
  readonly providerId: string;
  readonly chapterId: string;
  /** Series (manga) title, used to group chapters in the library. */
  readonly mangaTitle: string;
  readonly title: string;
  readonly files: readonly string[];
}

/** A chapter waiting to be downloaded, with the connector to fetch it. */
interface QueuedChapter {
  readonly key: string;
  readonly provider: Connector;
  readonly chapter: Chapter;
  readonly mangaTitle: string;
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
 * Each page is fetched through the connector transport and written to the
 * app-private `Directory.Data/emaki/<provider>/<chapter>/` folder via
 * `@capacitor/filesystem`. (The system `DownloadManager` was originally used
 * for this, but it refuses to write into `Android/data/<pkg>/` on modern
 * Android — it can only write to public MediaStore locations — so downloads
 * run inside the app instead. Consequence: transfers pause if the app is
 * killed, unlike the system downloader.)
 *
 * On web it falls back to a session-only blob download so `ionic serve`
 * still works.
 *
 * Progress is reported to `TaskManagerService` (queued → processing →
 * done/error) and downloaded chapters are recorded in `DownloadStore`, which
 * persists a manifest so the queue can be rehydrated after a restart.
 */
@Injectable({ providedIn: 'root' })
export class DownloadService {
  private readonly tasks = inject(TaskManagerService);
  private readonly store = inject(DownloadStore);
  private readonly requests = inject(ConnectorRequestService);
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
        mangaTitle: c.mangaTitle ?? '',
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
  public enqueue(provider: Connector, chapter: Chapter, mangaTitle: string, title: string): void {
    const key = `${provider.id}:${chapter.id}`;
    if (this.store.get(provider.id, chapter.id) !== undefined || this._active().has(key)) return;
    this._queue.push({ key, provider, chapter, mangaTitle, title });
    this._active.update((s) => new Set(s).add(key));
    this.tasks.register({ id: chapter.id, kind: 'download', title, total: 0 });
    this.tasks.update(chapter.id, 'download', { status: 'queued' });
    this.rememberPending(key);
    void this.pump();
  }

  /** Add many chapters to the queue (e.g. "download all"). */
  public enqueueMany(
    provider: Connector,
    chapters: readonly Chapter[],
    mangaTitle: string,
    titleFor: (c: Chapter) => string,
  ): void {
    for (const chapter of chapters) this.enqueue(provider, chapter, mangaTitle, titleFor(chapter));
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

  /**
   * Remove every downloaded chapter matching a chapter id. The Manager page
   * only knows tasks by chapter id, so it uses this to delete without the
   * provider id (a given chapter id is effectively unique per provider in
   * practice; all matches are removed defensively).
   */
  public async removeByChapterId(chapterId: string): Promise<void> {
    const matches = [...this.store.chapters().values()].filter((c) => c.chapterId === chapterId);
    for (const c of matches) {
      await this.remove(c.providerId, c.chapterId);
    }
  }

  /** Re-queue any chapters that were in-flight when the app last closed. */
  public async restorePending(
    provider: Connector,
    chapters: readonly Chapter[],
    mangaTitle: string,
    titleFor: (c: Chapter) => string,
  ): Promise<void> {
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
      this.enqueue(provider, chapter, mangaTitle, titleFor(chapter));
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

  /** Fetch each page and write it to app-private storage. */
  private async downloadNative(item: QueuedChapter, urls: readonly string[]): Promise<void> {
    const { provider, chapter } = item;
    const done: string[] = [];

    // Start pages one at a time with a small delay between them so the
    // provider doesn't rate-limit a burst of simultaneous downloads.
    for (let i = 0; i < urls.length; i++) {
      try {
        const blob = await this.requests.fetchImage(urls[i]);
        const fileName = `${String(i).padStart(3, '0')}${extensionFor(blob.type)}`;
        await Filesystem.writeFile({
          path: this.store.filePath(provider.id, chapter.id, fileName),
          directory: Directory.Data,
          data: await blobToBase64(blob),
          recursive: true,
        });
        done.push(fileName);
        this.tasks.update(chapter.id, 'download', { done: done.length });
      } catch {
        // Page failed — skip it; the chapter records only what landed.
      }
      if (i < urls.length - 1) await this.wait(PAGE_START_DELAY_MS);
    }

    if (done.length > 0) {
      await this.store.saveChapter(provider.id, chapter.id, item.mangaTitle, item.title, done);
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
    await this.store.saveChapter(provider.id, chapter.id, item.mangaTitle, item.title, files);
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

function splitKey(key: string): [string, string] {
  const i = key.indexOf(':');
  return [key.slice(0, i), key.slice(i + 1)];
}

/** Map a blob's mime type to a filename extension for stored pages. */
function extensionFor(type: string): string {
  switch (type) {
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    case 'image/bmp':
      return '.bmp';
    default:
      return '.jpg';
  }
}

/** Convert a Blob to base64 for `Filesystem.writeFile` (native requires it). */
async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}