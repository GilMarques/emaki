import type { PackIndex, PackPage } from './pack-index.model';
import { PACK_INDEX_VERSION } from './pack-index.model';

/**
 * Writing side of the pack format: book pages in, one pack plus its index out.
 *
 * The reader (`pack-catalog.ts`) validates the invariants this produces —
 * pages laid end to end with no gap, `packSize` equal to the end of the last
 * page. They are not repeated loosely here: an off-by-one in either direction
 * means every page after it shows the wrong picture.
 */

/** One page's bytes, as read from wherever the book actually lives. */
export interface PackPageSource {
  readonly bytes: Uint8Array;
  readonly mime: string;
}

/**
 * Where pages come from. Kept as an interface so the writer never touches the
 * filesystem (or SAF, or a browser blob) and can be tested with plain bytes.
 */
export interface PackSource {
  readonly bookId: string;
  readonly title: string;
  readonly pageCount: number;
  readPage(index: number): Promise<PackPageSource>;
}

export interface BuildPackOptions {
  /** Pipeline that produced the pages, when they are derivatives. */
  readonly model?: string;
  readonly scale?: number;
  /** Epoch ms; defaults to now. Injected so tests are deterministic. */
  readonly now?: number;
  /** Called after each page with the running count. */
  readonly onProgress?: (done: number, total: number) => void;
  readonly signal?: AbortSignal;
  /** Refuse rather than exhaust the heap on a runaway book. */
  readonly maxBytes?: number;
}

/** A finished pack: the bytes to upload and the manifest to upload beside it. */
export interface PackBuild {
  readonly index: PackIndex;
  readonly bytes: Uint8Array;
  /** First page kept as a preview image, or null when there were no pages. */
  readonly cover: PackCover | null;
}

/** The preview file a pack carries alongside it. */
export interface PackCover {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly file: string;
}

const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;

/**
 * Read every page, hash it, and lay the bytes out contiguously.
 *
 * The whole pack is held in memory once. That is the price of a simple,
 * testable writer and is acceptable for a book-sized pack on the computer;
 * a streaming writer is the next step if packs ever outgrow that.
 */
export async function buildPack(
  source: PackSource,
  options: BuildPackOptions = {},
): Promise<PackBuild> {
  if (source.pageCount <= 0) {
    throw new Error(`"${source.title}" has no pages to publish.`);
  }
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const pages: PackPage[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let cover: PackCover | null = null;

  for (let index = 0; index < source.pageCount; index += 1) {
    if (options.signal?.aborted === true) throw abortError();

    const page = await source.readPage(index);
    if (page.bytes.length === 0) {
      throw new Error(`Page ${index + 1} of "${source.title}" is empty.`);
    }
    if (offset + page.bytes.length > maxBytes) {
      throw new Error(
        `"${source.title}" is larger than ${maxBytes} bytes; publish it in parts.`,
      );
    }

    // The first page doubles as the shelf preview: one extra small file beats
    // asking every device to range into the pack for a thumbnail.
    if (index === 0) {
      cover = { bytes: page.bytes, mime: page.mime, file: coverFileName(page.mime) };
    }

    pages.push({
      offset,
      length: page.bytes.length,
      sha256: await sha256Hex(page.bytes),
      mime: page.mime,
    });
    chunks.push(page.bytes);
    offset += page.bytes.length;
    options.onProgress?.(index + 1, source.pageCount);
  }

  const index: PackIndex = {
    v: PACK_INDEX_VERSION,
    bookId: source.bookId,
    title: source.title,
    pages,
    packSize: offset,
    ...(cover === null ? {} : { cover: { file: cover.file, mime: cover.mime } }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.scale === undefined ? {} : { scale: options.scale }),
    createdAt: options.now ?? Date.now(),
  };

  return { index, bytes: concat(chunks, offset), cover };
}

/** File name for a preview, chosen from the image type. */
export function coverFileName(mime: string): string {
  switch (mime.toLowerCase()) {
    case 'image/webp':
      return 'cover.webp';
    case 'image/png':
      return 'cover.png';
    case 'image/jpeg':
      return 'cover.jpg';
    case 'image/gif':
      return 'cover.gif';
    case 'image/avif':
      return 'cover.avif';
    default:
      return 'cover.bin';
  }
}

/** The exact text that goes into `index.json`. */
export function serializePackIndex(index: PackIndex): string {
  // Pretty-printed on purpose: the manifest is small, and being able to read
  // it out of MEGA without a tool is worth a few hundred bytes.
  return `${JSON.stringify(index, null, 2)}\n`;
}

/** Lower-case hex SHA-256 of the given bytes. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  let hex = '';
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function abortError(): Error {
  const error = new Error('Publishing was cancelled.');
  error.name = 'AbortError';
  return error;
}
