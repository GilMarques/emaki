import { Injectable, inject, signal } from '@angular/core';

import type { BlobStore } from './blob-store.port';
import { readBlob } from './blob-store.port';
import { MegaAccountService } from './mega-account.service';
import { readRemoteCatalog, type RemoteBook } from './pack-catalog';

/**
 * The library as it exists in the MEGA account.
 *
 * Owns the catalogue and the preview images, because both are expensive and
 * both are needed by more than one screen. Covers are fetched one at a time:
 * each is a small object of its own, and firing them all at once is exactly
 * the burst MEGA throttles.
 */
@Injectable({ providedIn: 'root' })
export class RemoteShelfService {
  private readonly account = inject(MegaAccountService);

  private readonly _books = signal<readonly RemoteBook[]>([]);
  public readonly books = this._books.asReadonly();

  /** Blob URLs of loaded previews, by book id. */
  private readonly _covers = signal<ReadonlyMap<string, string>>(new Map());
  public readonly covers = this._covers.asReadonly();

  public readonly loading = signal(false);
  public readonly error = signal<string | null>(null);

  /** Object URLs handed out, so they can be released on the next refresh. */
  private objectUrls: string[] = [];

  /** Read the catalogue and its covers. Safe to call repeatedly. */
  public async refresh(): Promise<void> {
    if (this.loading()) return;
    if (!this.account.signedIn()) {
      this.clear();
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    try {
      const store = await this.account.store();
      const catalog = await readRemoteCatalog(store);
      this.releaseCovers();
      this._books.set(catalog.books);
      this.account.markHealthy();
      await this.loadCovers(store, catalog.books);
      // A broken manifest is worth saying out loud, but does not stop the rest.
      if (catalog.problems.length > 0) this.error.set(catalog.problems[0]);
    } catch (caught) {
      this._books.set([]);
      this.error.set(caught instanceof Error ? caught.message : String(caught));
      this.account.markFailed();
    } finally {
      this.loading.set(false);
    }
  }

  /** Forget everything, e.g. after signing out. */
  public clear(): void {
    this._books.set([]);
    this.error.set(null);
    this.releaseCovers();
  }

  private async loadCovers(
    store: BlobStore,
    books: readonly RemoteBook[],
  ): Promise<void> {
    for (const book of books) {
      if (book.cover === null) continue;
      try {
        const bytes = await readBlob(store, book.cover.key);
        const url = URL.createObjectURL(
          new Blob([bytes as unknown as BlobPart], { type: book.cover.mime }),
        );
        this.objectUrls.push(url);
        this._covers.update((map) => new Map(map).set(book.bookId, url));
      } catch {
        // A missing preview is a placeholder tile, not a failure.
      }
    }
  }

  private releaseCovers(): void {
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls = [];
    this._covers.set(new Map());
  }
}
