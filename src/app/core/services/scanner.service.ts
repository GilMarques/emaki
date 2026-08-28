import { Injectable, inject, signal } from '@angular/core';

import type { Book } from '../models/book.model';
import { LIBRARY_SCANNER } from '../native/library-scanner.port';
import type { FsFolder } from '../native/library-scanner.port';
import { ShelfService } from './shelf.service';

/**
 * Orchestrates the library: `discover()` loads the folder tree (so the file
 * explorer can show structure immediately), while `scan()` walks that tree and
 * registers every book leaf on the `ShelfService` (cover = first image).
 *
 * A folder only shows a cover once scanned — until then the explorer renders it
 * as a plain folder. The `scanned` set drives that, and `coverFor()` exposes the
 * cover URL for already-scanned book leaves.
 */
@Injectable({ providedIn: 'root' })
export class ScannerService {
  private readonly shelf = inject(ShelfService);
  private readonly scanner = inject(LIBRARY_SCANNER);

  private readonly _scanning = signal(false);
  public readonly scanning = this._scanning.asReadonly();

  private readonly _booksFound = signal(0);
  public readonly booksFound = this._booksFound.asReadonly();

  private readonly _tree = signal<FsFolder | null>(null);
  public readonly tree = this._tree.asReadonly();

  private readonly _scanned = signal<ReadonlySet<string>>(new Set());
  public readonly scanned = this._scanned.asReadonly();

  /** Load the folder tree (structure only — book covers appear after scan). */
  public async discover(): Promise<void> {
    const { root } = await this.scanner.discover();
    this._tree.set(root);
  }

  /** Register every book leaf on the shelf so it can be opened in the reader. */
  public async scan(): Promise<void> {
    this._scanning.set(true);
    this._booksFound.set(0);
    try {
      const root = this._tree() ?? (await this.scanner.discover()).root;
      const scanned = new Set<string>();
      const books: Book[] = [];

      const walk = (folder: FsFolder): void => {
        if (folder.isBook && folder.imageUrls && folder.imageUrls.length > 0) {
          const urls = folder.imageUrls;
          scanned.add(folder.id);
          books.push({
            id: folder.id,
            title: folder.name,
            coverUrl: urls[0],
            source: { type: 'preset', basePath: '' },
            pages: urls.map((url: string, index: number) => ({ index, url, label: url })),
          });
        }
        folder.children.forEach(walk);
      };
      walk(root);

      books.forEach((b) => this.shelf.addOrUpdate(b));
      this._scanned.set(scanned);
      this._booksFound.set(books.length);
      this._tree.set(root);
    } finally {
      this._scanning.set(false);
    }
  }

  /** True once a book leaf has been scanned and can show a cover / be opened. */
  public isScanned(id: string): boolean {
    return this._scanned().has(id);
  }

  /** Cover URL for a book leaf, or undefined until it has been scanned. */
  public coverFor(folder: FsFolder): string | undefined {
    return this.isScanned(folder.id) ? folder.imageUrls?.[0] : undefined;
  }
}
