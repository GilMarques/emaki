/**
 * A single page in a book. v1: a URL pointing to a decodable image
 * (JPEG/PNG/GIF/BMP/WebP/TIFF) or an EPUB content fragment.
 *
 * Once we wire archives + EPUB, a Page will need to carry format-specific
 * data (offset/length inside a CBZ, EPUB CFI, etc.). Keep `url` for now and
 * add a discriminated union later — don't expand the shape preemptively.
 */
export interface Page {
  /** Stable index inside the book. */
  readonly index: number;
  /** Resolvable URL — relative to /assets/, or a Capacitor Filesystem URI. */
  readonly url: string;
  /** Optional human label (e.g. "Chapter 3 — Page 12"). */
  readonly label?: string;
}

/**
 * Where a book's pages come from. v1 only has `preset` (a debug/web bundle
 * under `assets/`). `folder` is the later real-device shape (Tauri desktop,
 * Android SAF). Add `cbz` / `pdf` here when those formats land.
 */
export type BookSource =
  | { readonly type: 'preset'; basePath: string }
  | { readonly type: 'folder'; uri: string }
  | { readonly type: 'online'; providerId: string; chapterId: string };

/**
 * A book = a folder (or archive root) containing ordered pages.
 * Title is best-effort — folder name for now.
 */
export interface Book {
  readonly id: string;
  readonly title: string;
  readonly pages: readonly Page[];
  /** First page URL, used as the shelf cover thumbnail. */
  readonly coverUrl?: string;
  readonly source: BookSource;
}

/** The container of an open book. Empty when no book is open. */
export type OpenBookState =
  | { readonly book: null }
  | {
      readonly book: Book;
      /** Index of the current page in `book.pages`. */
      readonly currentIndex: number;
    };

/** True when a book is loaded and index is in range. */
export function isBookOpen(
  state: OpenBookState,
): state is { book: Book; currentIndex: number } {
  return state.book !== null;
}