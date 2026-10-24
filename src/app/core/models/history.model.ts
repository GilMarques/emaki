/**
 * One row in the reading history: the last page the user was on in a book,
 * and when they last turned to it.
 *
 * Deliberately a snapshot, not a reference — the shelf is rebuilt from the
 * filesystem on every scan and a book may disappear, so the entry has to
 * stand on its own until the shelf can resolve the id again.
 */
export interface HistoryEntry {
  /** Matches `Book.id` on the shelf. */
  readonly bookId: string;
  readonly title: string;
  /** Raw cover URL (preset asset, fs path, or already-resolved file URL). */
  readonly coverUrl?: string;
  /** Last page index the reader was on. */
  readonly pageIndex: number;
  /** Page count at the time it was read. */
  readonly pageCount: number;
  /** Epoch milliseconds of the last page turn / open. */
  readonly readAt: number;
}
