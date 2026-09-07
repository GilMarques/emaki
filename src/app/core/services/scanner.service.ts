import { Injectable, computed, effect, inject, signal } from '@angular/core';

import type { Book } from '../models/book.model';
import { LIBRARY_SCANNER } from '../native/library-scanner.port';
import type { FsFolder } from '../native/library-scanner.port';
import { ShelfService } from './shelf.service';
import { DownloadsLibraryService } from './downloads-library.service';

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
  private readonly downloadsLibrary = inject(DownloadsLibraryService);

  private readonly _scanning = signal(false);
  public readonly scanning = this._scanning.asReadonly();

  private readonly _booksFound = signal(0);
  public readonly booksFound = this._booksFound.asReadonly();

  private readonly _tree = signal<FsFolder | null>(null);
  /**
   * The visible folder tree: the discovered library root plus a synthetic
   * "Downloads" child (when anything has been downloaded), so downloaded
   * manga show up in the shelf grouped by series.
   */
  public readonly tree = computed<FsFolder | null>(() => {
    const root = this._tree();
    if (root === null) return null;
    const downloadsRoot = this.downloadsLibrary.root();
    if (downloadsRoot === null) return root;
    // Avoid duplicating the node across recomputes.
    if (root.children.some((c) => c.id === downloadsRoot.id)) return root;
    return { ...root, children: [...root.children, downloadsRoot] };
  });

  private readonly _scanned = signal<ReadonlySet<string>>(new Set());
  public readonly scanned = this._scanned.asReadonly();

  /** Books registered purely from downloads (not the SAF scan). */
  private readonly _downloadBookIds = new Set<string>();

  constructor() {
    // Keep the shelf in sync with the download manifest so downloaded chapters
    // are immediately openable (no manual Scan needed) and disappear when
    // removed. Runs as an effect because downloads can complete anytime.
    effect(() => {
      const root = this.downloadsLibrary.root();
      const keep = new Set<string>();
      if (root !== null) {
        const walk = (folder: FsFolder): void => {
          if (folder.isBook) {
            keep.add(folder.id);
            const d = this.downloadsLibrary.downloadForBook(folder.id);
            if (d) this.shelf.addOrUpdate(this.downloadsLibrary.bookFor(d));
          }
          folder.children.forEach(walk);
        };
        root.children.forEach(walk);
      }
      for (const id of this._downloadBookIds) {
        if (!keep.has(id)) this.shelf.remove(id);
      }
      this._downloadBookIds.clear();
      for (const id of keep) this._downloadBookIds.add(id);
    });
  }

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

  /** True once a book leaf is registered (scanned or downloaded) and can show a cover / be opened. */
  public isScanned(id: string): boolean {
    return this.shelf.byId(id) !== undefined;
  }

  /** Cover URL for a book leaf, or undefined until it has been scanned. */
  public coverFor(folder: FsFolder): string | undefined {
    return this.isScanned(folder.id) ? folder.imageUrls?.[0] : undefined;
  }
}
