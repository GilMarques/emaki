import { Injectable, inject, signal } from '@angular/core';

import type { Book } from '../models/book.model';
import { FILE_SYSTEM_BROWSER } from '../native/file-system-browser.port';
import type { BlobStore } from './blob-store.port';
import { bookPackSource } from './book-pack.source';
import { indexPathFor, packFolderFor, packPathFor } from './pack-index.model';
import { buildPack, serializePackIndex } from './pack-writer';

/**
 * Publishing: shelf books in, packs in the store out.
 *
 * The pack is written before the index, so a half-finished book never shows up
 * in another device's catalogue — the reader looks for `index.json` and only
 * then believes a pack exists.
 */

/** What the UI needs while a publish runs. */
export interface PublishProgress {
  readonly title: string;
  readonly done: number;
  readonly total: number;
}

@Injectable({ providedIn: 'root' })
export class PackPublisherService {
  private readonly fs = inject(FILE_SYSTEM_BROWSER);

  public readonly publishing = signal(false);
  public readonly progress = signal<PublishProgress | null>(null);
  /** Books written this run. */
  public readonly published = signal(0);
  public readonly error = signal<string | null>(null);

  /** Books that can be published at all: pages on disk, not presets. */
  public publishable(books: readonly Book[]): readonly Book[] {
    return books.filter((book) => book.source.type === 'folder');
  }

  /**
   * Build and upload one pack + index per book.
   *
   * Sequential on purpose: each pack is held in memory while it is built, so
   * two at once doubles that, and MEGA throttles bursts of writes anyway.
   */
  public async publish(books: readonly Book[], store: BlobStore): Promise<void> {
    if (this.publishing()) return;
    const queue = this.publishable(books);
    this.publishing.set(true);
    this.published.set(0);
    this.error.set(null);
    try {
      for (const book of queue) {
        this.progress.set({ title: book.title, done: 0, total: book.pages.length });
        const pack = await buildPack(bookPackSource(book, this.fs), {
          onProgress: (done, total) => this.progress.set({ title: book.title, done, total }),
        });

        await store.put(packPathFor(pack.index.bookId), pack.bytes, 'application/octet-stream');
        if (pack.cover !== null) {
          await store.put(
            `${packFolderFor(pack.index.bookId)}/${pack.cover.file}`,
            pack.cover.bytes,
            pack.cover.mime,
          );
        }
        await store.put(
          indexPathFor(pack.index.bookId),
          new TextEncoder().encode(serializePackIndex(pack.index)),
          'application/json',
        );
        this.published.update((count) => count + 1);
      }
    } catch (caught) {
      this.error.set(caught instanceof Error ? caught.message : String(caught));
    } finally {
      this.progress.set(null);
      this.publishing.set(false);
    }
  }
}
