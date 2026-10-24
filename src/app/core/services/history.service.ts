import { Injectable, computed, signal } from '@angular/core';

import type { Book } from '../models/book.model';
import type { HistoryEntry } from '../models/history.model';

const STORAGE_KEY = 'openviewer:history:v1';

/** Older entries are dropped — 100 books is far more than anyone resumes. */
const MAX_ENTRIES = 100;

/** Coalesce the localStorage write; page turns can happen several times a second. */
const SAVE_DELAY_MS = 300;

/**
 * Reading history: which books were opened, how far the reader got, and when.
 *
 * Newest first, one entry per book — reopening a book moves it to the top
 * instead of appending a duplicate. Persisted to `localStorage` (best-effort,
 * like `SettingsService`) so the list survives an app restart. Entries store
 * a title + cover snapshot because the shelf is rebuilt from disk and an
 * unscanned book's `Book` object isn't available yet.
 */
@Injectable({ providedIn: 'root' })
export class HistoryService {
  private readonly _entries = signal<readonly HistoryEntry[]>(this.load());
  public readonly entries = this._entries.asReadonly();
  public readonly hasEntries = computed(() => this._entries().length > 0);

  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  /** Record (or move to the top) the book at `pageIndex`. */
  public record(book: Book, pageIndex: number): void {
    const count = book.pages.length;
    const entry: HistoryEntry = {
      bookId: book.id,
      title: book.title,
      coverUrl: book.coverUrl ?? book.pages[0]?.url,
      pageIndex: clampIndex(pageIndex, count),
      pageCount: count,
      readAt: Date.now(),
    };
    this._entries.update((list) => {
      const rest = list.filter((e) => e.bookId !== entry.bookId);
      return [entry, ...rest].slice(0, MAX_ENTRIES);
    });
    this.scheduleSave();
  }

  public entryFor(bookId: string): HistoryEntry | undefined {
    return this._entries().find((e) => e.bookId === bookId);
  }

  /** Forget one book. */
  public remove(bookId: string): void {
    this._entries.update((list) => list.filter((e) => e.bookId !== bookId));
    this.scheduleSave();
  }

  /** Forget everything. */
  public clear(): void {
    this._entries.set([]);
    this.scheduleSave();
  }

  /** Write pending changes now (used by tests; the app relies on the timer). */
  public flush(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.save();
  }

  // ──────────────────────── Persistence ────────────────────────

  private scheduleSave(): void {
    if (typeof localStorage === 'undefined') return;
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DELAY_MS);
  }

  private load(): readonly HistoryEntry[] {
    if (typeof localStorage === 'undefined') return [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return [];
      const parsed = JSON.parse(raw) as unknown;
      return validateEntries(parsed).slice(0, MAX_ENTRIES);
    } catch {
      // Unreadable or corrupt: start empty rather than crash the history page.
      return [];
    }
  }

  private save(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._entries()));
    } catch {
      // Quota exceeded or storage disabled. History stays in memory.
    }
  }
}

function clampIndex(index: number, count: number): number {
  if (!Number.isFinite(index) || count <= 0) return 0;
  return Math.min(Math.max(0, Math.round(index)), count - 1);
}

/** Keep only well-formed entries from stored JSON; older/newer fields are tolerated. */
function validateEntries(input: unknown): readonly HistoryEntry[] {
  if (!Array.isArray(input)) return [];
  const out: HistoryEntry[] = [];
  for (const raw of input) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    if (typeof r['bookId'] !== 'string' || r['bookId'].length === 0) continue;
    if (typeof r['title'] !== 'string') continue;
    if (typeof r['pageIndex'] !== 'number' || !Number.isFinite(r['pageIndex'])) continue;
    if (typeof r['pageCount'] !== 'number' || !Number.isFinite(r['pageCount'])) continue;
    if (typeof r['readAt'] !== 'number' || !Number.isFinite(r['readAt'])) continue;
    out.push({
      bookId: r['bookId'],
      title: r['title'],
      coverUrl: typeof r['coverUrl'] === 'string' ? r['coverUrl'] : undefined,
      pageIndex: clampIndex(r['pageIndex'], r['pageCount']),
      pageCount: Math.max(0, Math.round(r['pageCount'])),
      readAt: Math.max(0, r['readAt']),
    });
  }
  return out;
}
