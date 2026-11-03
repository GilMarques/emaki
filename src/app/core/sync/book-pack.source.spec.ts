import type { Book } from '../models/book.model';
import type { FileSystemBrowser } from '../native/file-system-browser.port';
import { bookPackSource, mimeForName } from './book-pack.source';

const encoder = new TextEncoder();

function browserWith(files: Readonly<Record<string, Blob>>): FileSystemBrowser {
  return {
    isAvailable: () => true,
    pickDirectory: () => Promise.resolve(null),
    listDirectory: () => Promise.resolve([]),
    readFile: (path) => {
      const file = files[path];
      return file === undefined
        ? Promise.reject(new Error(`Not a file: ${path}`))
        : Promise.resolve(file);
    },
    stat: () => Promise.resolve(null),
    openArchive: () => Promise.reject(new Error('Archives are not supported')),
    cleanupArchive: () => Promise.resolve(),
  };
}

function book(paths: readonly string[]): Book {
  return {
    id: 'bk:9f2c',
    title: 'One Piece v01',
    source: { type: 'folder', uri: '/Library/One Piece v01' },
    pages: paths.map((url, index) => ({ index, url })),
  };
}

describe('bookPackSource', () => {
  it('reads each page through the filesystem and keeps its MIME type', async () => {
    const source = bookPackSource(
      book(['/lib/001.webp', '/lib/002.webp']),
      browserWith({
        '/lib/001.webp': new Blob([encoder.encode('one')], { type: 'image/webp' }),
        '/lib/002.webp': new Blob([encoder.encode('two')], { type: 'image/webp' }),
      }),
    );

    const first = await source.readPage(0);
    const second = await source.readPage(1);

    expect(new TextDecoder().decode(first.bytes)).toBe('one');
    expect(second.mime).toBe('image/webp');
    expect(source.pageCount).toBe(2);
  });

  it('falls back to the file name when the backend reports no type', async () => {
    const source = bookPackSource(
      book(['/lib/001.PNG']),
      browserWith({ '/lib/001.PNG': new Blob([encoder.encode('x')]) }),
    );

    const page = await source.readPage(0);

    expect(page.mime).toBe('image/png');
  });

  it('refuses a book that is not a folder of pages', () => {
    const preset: Book = {
      id: 'preset-1',
      title: 'Sample',
      source: { type: 'preset', basePath: '' },
      pages: [{ index: 0, url: 'sample/001.jpg' }],
    };

    expect(() => bookPackSource(preset, browserWith({}))).toThrowError(/not a folder of pages/);
  });

  it('says which page is missing instead of failing on a path', async () => {
    const source = bookPackSource(book(['/lib/001.webp']), browserWith({}));

    await expectAsync(source.readPage(0)).toBeRejectedWithError(/Not a file/);
  });
});

describe('mimeForName', () => {
  it('knows the formats the reader decodes', () => {
    expect(mimeForName('a/b/c.WEBP')).toBe('image/webp');
    expect(mimeForName('c.jpeg')).toBe('image/jpeg');
    expect(mimeForName('c.avif')).toBe('image/avif');
    expect(mimeForName('c.bin')).toBe('application/octet-stream');
  });
});
