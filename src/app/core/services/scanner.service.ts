import { Injectable, inject, signal } from '@angular/core';

import type { Book } from '../models/book.model';
import { LIBRARY_SCANNER } from '../native/library-scanner.port';
import { ShelfService } from './shelf.service';

/**
 * Orchestrates a "scan": asks the active `LibraryScannerPort` for books and
 * registers each one on the `ShelfService` (cover = first image). Exposes a
 * scanning flag + count so the UI can show progress.
 */
@Injectable({ providedIn: 'root' })
export class ScannerService {
  private readonly shelf = inject(ShelfService);
  private readonly scanner = inject(LIBRARY_SCANNER);

  private readonly _scanning = signal(false);
  public readonly scanning = this._scanning.asReadonly();

  private readonly _booksFound = signal(0);
  public readonly booksFound = this._booksFound.asReadonly();

  public async scan(): Promise<void> {
    this._scanning.set(true);
    this._booksFound.set(0);
    try {
      const discovered = await this.scanner.discover();
      for (const d of discovered) {
        const book: Book = {
          id: d.id,
          title: d.title,
          coverUrl: d.imageUrls[0] ?? undefined,
          source: { type: 'preset', basePath: '' },
          pages: d.imageUrls.map((url, index) => ({ index, url, label: url })),
        };
        this.shelf.addOrUpdate(book);
      }
      this._booksFound.set(discovered.length);
    } finally {
      this._scanning.set(false);
    }
  }
}
