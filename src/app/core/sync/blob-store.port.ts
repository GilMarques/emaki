/**
 * The remote store that page packs are read from.
 *
 * Deliberately narrow. A reader can list and download, and that is all —
 * `BlobStore` (which adds writing) is implemented only by the computer, so a
 * device that cannot write is never trusted to try.
 *
 * Packs are tens to hundreds of megabytes, so `open()` hands bytes to a sink
 * in chunks instead of returning one buffer: a pack must never sit whole in
 * the WebView heap. Small objects (a manifest) go through `readBlob`, which
 * caps what it will buffer.
 */

/** One object in the store. */
export interface BlobEntry {
  /** Path relative to the store root, e.g. `bk-9f2c/pages.pack`. */
  readonly key: string;
  /** Size in bytes; 0 when the store does not report a size for it. */
  readonly size: number;
  /** True for a directory entry, which has no bytes of its own. */
  readonly folder: boolean;
}

/** Receives a blob's bytes as they arrive. */
export interface BlobSink {
  write(chunk: Uint8Array): Promise<void>;
}

/**
 * Raised when a key is not in the store.
 *
 * Callers that walk a store need to tell "this folder is not a book" apart
 * from "this book is broken", and a message string cannot do that reliably.
 */
export class BlobNotFoundError extends Error {
  constructor(key: string) {
    super(`"${key}" is not in the library.`);
    this.name = 'BlobNotFoundError';
  }
}

export interface BlobDownloadOptions {
  /** Aborts the transfer; the store must stop reading and release the stream. */
  readonly signal?: AbortSignal;
  /** Bytes received so far and the total when the store knows it up front. */
  readonly onProgress?: (received: number, total: number) => void;
}

/** Read side of a store — everything a reading device needs. */
export interface BlobReader {
  /** Identifies the transport, for logs and error messages. */
  readonly id: string;
  /** Direct children of `prefix` ('' is the store root). Folders included. */
  list(prefix?: string): Promise<readonly BlobEntry[]>;
  /** Stream one object into `sink`. Rejects when the key is missing. */
  open(key: string, sink: BlobSink, options?: BlobDownloadOptions): Promise<void>;
}

/** Read and write. Only the computer implements this. */
export interface BlobStore extends BlobReader {
  put(key: string, data: Uint8Array, mime: string): Promise<void>;
  remove(key: string): Promise<void>;
}

/** Default ceiling for `readBlob` — a manifest, not a pack. */
const READ_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * Read one small object into memory.
 *
 * `maxBytes` exists so a mistake — pointing this at a pack — fails loudly
 * instead of exhausting the heap.
 */
export async function readBlob(
  reader: BlobReader,
  key: string,
  options: BlobDownloadOptions & { readonly maxBytes?: number } = {},
): Promise<Uint8Array> {
  const maxBytes = options.maxBytes ?? READ_LIMIT_BYTES;
  const chunks: Uint8Array[] = [];
  let total = 0;
  await reader.open(
    key,
    {
      write: (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          throw new Error(
            `"${key}" is larger than ${maxBytes} bytes; download it with open() instead.`,
          );
        }
        chunks.push(chunk);
        return Promise.resolve();
      },
    },
    options,
  );
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
