import type { Book } from '../models/book.model';
import type { FileSystemBrowser } from '../native/file-system-browser.port';
import type { PackPageSource, PackSource } from './pack-writer';

/**
 * Read a shelf book's pages off disk for `buildPack`.
 *
 * Only folder-backed books can be published: a preset book's pages are asset
 * URLs the file browser cannot open, so it would fail on page one with a
 * confusing path error instead of saying why.
 */
export function bookPackSource(book: Book, fs: FileSystemBrowser): PackSource {
  if (book.source.type !== 'folder') {
    throw new Error(`"${book.title}" is not a folder of pages, so it cannot be published.`);
  }
  return {
    bookId: book.id,
    title: book.title,
    pageCount: book.pages.length,
    readPage: async (index): Promise<PackPageSource> => {
      const page = book.pages[index];
      if (page === undefined) {
        throw new Error(`Page ${index + 1} is missing from "${book.title}".`);
      }
      const blob = await fs.readFile(page.url);
      return {
        bytes: new Uint8Array(await blob.arrayBuffer()),
        mime: blob.type !== '' ? blob.type : mimeForName(page.url),
      };
    },
  };
}

/** Fallback for backends that hand back a Blob with no type set. */
export function mimeForName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.avif')) return 'image/avif';
  return 'application/octet-stream';
}
