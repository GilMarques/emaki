import { BlobNotFoundError, readBlob, type BlobReader } from './blob-store.port';
import { INDEX_FILE, parsePackIndexJson, type PackIndex } from './pack-index.model';

/**
 * What a remote store offers, as a list a person can read.
 *
 * The store knows nothing about books — it holds folders and bytes. This walks
 * it, reads one small manifest per candidate folder, and turns the usable ones
 * into books. Folders without an index are silently not books (a MEGA folder
 * may hold anything); folders whose index is invalid are reported, because
 * that is a published book gone wrong.
 */

/** A book available in the remote store. */
export interface RemoteBook {
  readonly bookId: string;
  readonly title: string;
  /** Folder the pack lives in; '' when the link points straight at one book. */
  readonly folder: string;
  readonly pageCount: number;
  readonly packSize: number;
  /** Preview file beside the pack, or null for packs written before covers. */
  readonly cover: { readonly key: string; readonly mime: string } | null;
  /** Set when the pages are derivatives rather than originals. */
  readonly model?: string;
  readonly scale?: number;
  readonly createdAt: number;
}

export interface RemoteCatalog {
  /** Usable books, by title. */
  readonly books: readonly RemoteBook[];
  /** One line per folder that has an index we cannot trust. */
  readonly problems: readonly string[];
}

/** Read the whole catalogue. Never throws for one bad book. */
export async function readRemoteCatalog(reader: BlobReader): Promise<RemoteCatalog> {
  const entries = await reader.list();
  const problems: string[] = [];

  // A link may point at the library root, or straight at one book's folder.
  const rootIsBook = entries.some((entry) => !entry.folder && entry.key === INDEX_FILE);
  const folders = rootIsBook
    ? ['']
    : entries.filter((entry) => entry.folder).map((entry) => entry.key);

  const books: RemoteBook[] = [];
  // Sequential on purpose: MEGA rate-limits by request weight per address, and
  // a burst of parallel reads is exactly what it pushes back on.
  for (const folder of folders) {
    const book = await readBook(reader, folder, problems);
    if (book !== null) books.push(book);
  }

  books.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
  return { books, problems };
}

async function readBook(
  reader: BlobReader,
  folder: string,
  problems: string[],
): Promise<RemoteBook | null> {
  const indexPath = folder === '' ? INDEX_FILE : `${folder}/${INDEX_FILE}`;
  const label = folder === '' ? 'This link' : folder;
  try {
    const raw = await readBlob(reader, indexPath);
    const parsed = parsePackIndexJson(new TextDecoder().decode(raw));
    if (!parsed.ok) {
      problems.push(`${label}: ${parsed.reason}`);
      return null;
    }
    return toRemoteBook(folder, parsed.index);
  } catch (error) {
    // No index at all means the folder simply is not a book.
    if (error instanceof BlobNotFoundError) return null;
    problems.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function toRemoteBook(folder: string, index: PackIndex): RemoteBook {
  const prefix = folder === '' ? '' : `${folder}/`;
  return {
    bookId: index.bookId,
    title: index.title,
    folder,
    pageCount: index.pages.length,
    packSize: index.packSize,
    cover:
      index.cover === undefined
        ? null
        : { key: `${prefix}${index.cover.file}`, mime: index.cover.mime },
    model: index.model,
    scale: index.scale,
    createdAt: index.createdAt,
  };
}
