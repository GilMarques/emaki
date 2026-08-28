import { Injectable, computed, signal } from '@angular/core';

import type { Book } from '../models/book.model';

/**
 * In-memory registry of books the user has scanned/registered.
 *
 * v1 keeps this in signals only — the app's real files live on device
 * (Tauri desktop / Android SAF) and persistence (Dexie/IndexedDB) lands with
 * the real-device scan phase. Preset books reload from the manifest each scan,
 * so nothing needs to survive a reload today.
 */
@Injectable({ providedIn: 'root' })
export class ShelfService {
  private readonly _books = signal<readonly Book[]>([]);
  private readonly _progress = signal<ReadonlyMap<string, number>>(new Map());

  /** Registered books, in scan/registration order. */
  public readonly books = this._books.asReadonly();
  public readonly hasBooks = computed(() => this._books().length > 0);

  public byId(id: string): Book | undefined {
    return this._books().find((b) => b.id === id);
  }

  /** Idempotent upsert — re-scanning the same book updates it in place. */
  public addOrUpdate(book: Book): void {
    const current = this._books();
    const idx = current.findIndex((b) => b.id === book.id);
    if (idx === -1) {
      this._books.set([...current, book]);
      return;
    }
    const next = current.slice();
    next[idx] = book;
    this._books.set(next);
  }

  public remove(id: string): void {
    this._books.set(this._books().filter((b) => b.id !== id));
  }

  /** Next book's id in shelf order, or null at the end. Drives "next book". */
  public nextBookId(id: string): string | null {
    const list = this._books();
    const idx = list.findIndex((b) => b.id === id);
    if (idx === -1 || idx >= list.length - 1) return null;
    return list[idx + 1].id;
  }

  public prevBookId(id: string): string | null {
    const list = this._books();
    const idx = list.findIndex((b) => b.id === id);
    if (idx <= 0) return null;
    return list[idx - 1].id;
  }

  public progressFor(id: string): number {
    return this._progress().get(id) ?? 0;
  }

  /** Record the last-read page. UI deferred; field ready for later progress. */
  public setProgress(id: string, pageIndex: number): void {
    const next = new Map(this._progress());
    next.set(id, Math.max(0, pageIndex));
    this._progress.set(next);
  }
}
