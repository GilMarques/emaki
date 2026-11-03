/**
 * How a published book is laid out in the remote store.
 *
 * One folder per book, one pack, one index beside it:
 *
 *   bk-9f2c1a.../pages.pack    every page's bytes, back to back
 *   bk-9f2c1a.../index.json    where each page starts, and what it is
 *
 * A pack keeps the object count sane (one node per book, not two hundred) and
 * makes a download a single transfer that can be retried or resumed. The index
 * is what turns those bytes back into pages, so it is validated strictly: a
 * wrong offset is silent corruption, not a visible error.
 */

export const PACK_INDEX_VERSION = 1;
export const PACK_FILE = 'pages.pack';
export const INDEX_FILE = 'index.json';

/** One page inside the pack. */
export interface PackPage {
  /** Byte offset of the page inside `pages.pack`. */
  readonly offset: number;
  readonly length: number;
  /** Lower-case hex SHA-256 of the page bytes, as delivered. */
  readonly sha256: string;
  /** MIME type of the bytes (image/webp for derivatives). */
  readonly mime: string;
}

/** The manifest written next to a pack. */
export interface PackIndex {
  readonly v: typeof PACK_INDEX_VERSION;
  /** Stable id the book carries on every device (`bk:…`). */
  readonly bookId: string;
  readonly title: string;
  readonly pages: readonly PackPage[];
  /** Byte length of `pages.pack`; must equal the end of the last page. */
  readonly packSize: number;
  /**
   * Preview image beside the pack: the first page, kept as a file of its own
   * so a shelf can show covers without opening (or ranging into) the pack.
   */
  readonly cover?: { readonly file: string; readonly mime: string };
  /** Pipeline that produced the pages, when they are derivatives. */
  readonly model?: string;
  readonly scale?: number;
  /** Epoch ms the pack was written. */
  readonly createdAt: number;
}

/** Outcome of reading a manifest: a valid index, or why it is not usable. */
export type PackIndexResult =
  | { readonly ok: true; readonly index: PackIndex }
  | { readonly ok: false; readonly reason: string };

/** A SHA-256 digest, as this format writes it. */
const SHA256 = /^[0-9a-f]{64}$/;

/** Parse the text of an `index.json`. Never throws. */
export function parsePackIndexJson(text: string): PackIndexResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'The index is not valid JSON.' };
  }
  return validatePackIndex(raw);
}

/**
 * Check a parsed manifest.
 *
 * Beyond the field types this enforces the invariant that makes slicing safe:
 * pages start where the previous one ended, and the pack is exactly as long as
 * the last page says. A pack index that skips bytes would "work" and show the
 * wrong page, which is worse than refusing it.
 */
export function validatePackIndex(raw: unknown): PackIndexResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, reason: 'The index is not an object.' };
  }
  const v = raw as Record<string, unknown>;

  if (v['v'] !== PACK_INDEX_VERSION) {
    return { ok: false, reason: `Unsupported index version: ${String(v['v'])}.` };
  }
  const bookId = v['bookId'];
  if (typeof bookId !== 'string' || bookId.trim() === '') {
    return { ok: false, reason: 'The index has no book id.' };
  }
  const title = v['title'];
  if (typeof title !== 'string' || title.trim() === '') {
    return { ok: false, reason: 'The index has no title.' };
  }
  const createdAt = v['createdAt'];
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
    return { ok: false, reason: 'The index has no creation time.' };
  }

  const rawPages = v['pages'];
  if (!Array.isArray(rawPages) || rawPages.length === 0) {
    return { ok: false, reason: 'The index lists no pages.' };
  }

  const pages: PackPage[] = [];
  let expectedOffset = 0;
  for (let i = 0; i < rawPages.length; i += 1) {
    const page = rawPages[i] as unknown;
    if (typeof page !== 'object' || page === null) {
      return { ok: false, reason: `Page ${i + 1} is not an object.` };
    }
    const p = page as Record<string, unknown>;
    const offset = p['offset'];
    const length = p['length'];
    const sha256 = p['sha256'];
    const mime = p['mime'];

    if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
      return { ok: false, reason: `Page ${i + 1} has no valid offset.` };
    }
    if (typeof length !== 'number' || !Number.isInteger(length) || length <= 0) {
      return { ok: false, reason: `Page ${i + 1} has no valid length.` };
    }
    if (offset !== expectedOffset) {
      return {
        ok: false,
        reason: `Page ${i + 1} starts at ${offset} but page ${i} ends at ${expectedOffset}.`,
      };
    }
    if (typeof sha256 !== 'string' || !SHA256.test(sha256)) {
      return { ok: false, reason: `Page ${i + 1} has no valid digest.` };
    }
    if (typeof mime !== 'string' || mime === '') {
      return { ok: false, reason: `Page ${i + 1} has no MIME type.` };
    }

    pages.push({ offset, length, sha256, mime });
    expectedOffset += length;
  }

  const packSize = v['packSize'];
  if (typeof packSize !== 'number' || !Number.isInteger(packSize) || packSize < 0) {
    return { ok: false, reason: 'The index has no pack size.' };
  }
  if (packSize !== expectedOffset) {
    return {
      ok: false,
      reason: `The pack is ${packSize} bytes but its pages add up to ${expectedOffset}.`,
    };
  }

  const model = v['model'];
  const scale = v['scale'];
  const cover = readCover(v['cover']);
  if (cover === false) {
    return { ok: false, reason: 'The index has an unusable cover entry.' };
  }

  return {
    ok: true,
    index: {
      v: PACK_INDEX_VERSION,
      bookId,
      title,
      pages,
      packSize,
      ...(cover === null ? {} : { cover }),
      ...(typeof model === 'string' && model !== '' ? { model } : {}),
      ...(typeof scale === 'number' && Number.isFinite(scale) ? { scale } : {}),
      createdAt,
    },
  };
}

/** `null` when absent, `false` when present but malformed. */
function readCover(raw: unknown): { file: string; mime: string } | null | false {
  if (raw === undefined) return null;
  if (typeof raw !== 'object' || raw === null) return false;
  const cover = raw as Record<string, unknown>;
  const file = cover['file'];
  const mime = cover['mime'];
  if (typeof file !== 'string' || file === '') return false;
  if (typeof mime !== 'string' || mime === '') return false;
  return { file, mime };
}

/**
 * Folder name for a book.
 *
 * Ids carry characters a URL path and a MEGA node dislike (`bk:9f2c`), so the
 * folder is the sanitised form. It is deliberately not reversible: the index
 * holds the real id, and the folder is only a place to put bytes.
 */
export function packFolderFor(bookId: string): string {
  const safe = bookId.trim().replace(/[^A-Za-z0-9_-]+/g, '-');
  if (safe === '' || safe === '-') {
    throw new Error(`A book id needs at least one letter or digit: "${bookId}".`);
  }
  return safe;
}

/** Path of the pack for a book. */
export function packPathFor(bookId: string): string {
  return `${packFolderFor(bookId)}/${PACK_FILE}`;
}

/** Path of the index for a book. */
export function indexPathFor(bookId: string): string {
  return `${packFolderFor(bookId)}/${INDEX_FILE}`;
}
