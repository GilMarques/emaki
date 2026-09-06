import { Injectable, computed, inject, signal } from '@angular/core';

import type { Chapter } from '../connectors/connector.model';
import { Connector } from '../connectors/connector.base';
import { ConnectorRequestService } from '../connectors/connector-request.service';
import { TaskManagerService } from '../tasks/task-manager.service';

/** A chapter download held in memory: blob URL per page, plus mime. */
export interface DownloadedPage {
  readonly url: string;
  readonly blobUrl: string;
  readonly type: string;
}

/** One finished (or in-progress) chapter download keyed by provider + chapter id. */
export interface ChapterDownload {
  readonly providerId: string;
  readonly chapterId: string;
  readonly title: string;
  readonly pages: readonly DownloadedPage[];
}

/** A chapter waiting to be downloaded, with the connector to fetch it. */
interface QueuedChapter {
  readonly key: string;
  readonly provider: Connector;
  readonly chapter: Chapter;
  readonly title: string;
}

/**
 * Downloads a chapter's pages from a provider and exposes them as blob URLs.
 *
 * Chapters are queued and processed one at a time. Each page is fetched via
 * `ConnectorRequestService.fetchImage` (same transport as the connector
 * engine) and materialized into an object URL the viewer can render.
 * Progress is reported to `TaskManagerService` so the Manager page shows the
 * running job (queued → processing → done/error).
 *
 * Storage is in-memory for now — a real on-device folder (SAF) lands with the
 * file-system phase. Blob URLs live for the session and should be revoked by
 * the owner when done.
 */
@Injectable({ providedIn: 'root' })
export class DownloadService {
  private readonly requests = inject(ConnectorRequestService);
  private readonly tasks = inject(TaskManagerService);

  private readonly _downloads = signal<ReadonlyMap<string, ChapterDownload>>(new Map());

  /** Chapter ids currently queued or processing (per provider). */
  private readonly _active = signal<ReadonlySet<string>>(new Set());
  public readonly active = this._active.asReadonly();

  private readonly _queue: QueuedChapter[] = [];
  private processing = false;

  /** Completed (or errored-but-partial) downloads, keyed by `providerId:chapterId`. */
  public readonly downloads = this._downloads.asReadonly();

  /** True while any chapters are queued or being downloaded. */
  public readonly busy = computed(() => this._active().size > 0);

  public get(providerId: string, chapterId: string): ChapterDownload | undefined {
    return this._downloads().get(`${providerId}:${chapterId}`);
  }

  /** True when a chapter is downloaded, queued, or in progress. */
  public isDownloaded(providerId: string, chapterId: string): boolean {
    return this._downloads().has(`${providerId}:${chapterId}`);
  }

  /** Add a chapter to the download queue. Idempotent per provider+chapter. */
  public enqueue(provider: Connector, chapter: Chapter, title: string): void {
    const key = `${provider.id}:${chapter.id}`;
    if (this._downloads().has(key) || this._active().has(key)) return;
    this._queue.push({ key, provider, chapter, title });
    this._active.update((s) => new Set(s).add(key));
    this.tasks.register({ id: chapter.id, kind: 'download', title, total: 0 });
    this.tasks.update(chapter.id, 'download', { status: 'queued' });
    void this.pump();
  }

  /** Add many chapters to the queue (e.g. "download all"). */
  public enqueueMany(provider: Connector, chapters: readonly Chapter[], titleFor: (c: Chapter) => string): void {
    for (const chapter of chapters) this.enqueue(provider, chapter, titleFor(chapter));
  }

  /** Drop a downloaded chapter and release its blob URLs. */
  public remove(providerId: string, chapterId: string): void {
    const key = `${providerId}:${chapterId}`;
    const existing = this._downloads().get(key);
    if (existing) {
      for (const p of existing.pages) URL.revokeObjectURL(p.blobUrl);
    }
    const next = new Map(this._downloads());
    next.delete(key);
    this._downloads.set(next);
    this.tasks.remove(chapterId, 'download');
  }

  // ─────────────────────────────── Engine ───────────────────────────────

  private async pump(): Promise<void> {
    if (this.processing) return;
    this.processing = true;
    try {
      while (this._queue.length > 0) {
        const item = this._queue.shift()!;
        await this.downloadOne(item);
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

      const pages: DownloadedPage[] = [];
      for (let i = 0; i < pageRefs.length; i++) {
        try {
          const ref = pageRefs[i];
          const blob = await this.requests.fetchImage(ref.url);
          pages.push({ url: ref.url, blobUrl: URL.createObjectURL(blob), type: blob.type });
        } catch (err) {
          // Skip a broken page but keep the rest of the chapter.
          console.warn('[download] page failed', i, err);
        }
        this.tasks.update(chapter.id, 'download', { done: i + 1 });
      }

      this._downloads.update((m) =>
        new Map(m).set(key, { providerId: provider.id, chapterId: chapter.id, title, pages }),
      );
      this.tasks.update(chapter.id, 'download', { status: pages.length > 0 ? 'done' : 'error' });
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
}