import type { BlobEntry, BlobReader, BlobSink } from './blob-store.port';
import { BlobNotFoundError } from './blob-store.port';
import { readRemoteCatalog } from './pack-catalog';
import { PACK_INDEX_VERSION } from './pack-index.model';

class FakeStore implements BlobReader {
  public readonly id = 'fake';

  constructor(
    private readonly files: Readonly<Record<string, string>>,
    private readonly folders: readonly string[] = [],
  ) {}

  public async list(prefix = ''): Promise<readonly BlobEntry[]> {
    const direct = (key: string): boolean => parentOf(key) === prefix;
    const folders = this.folders
      .filter(direct)
      .map<BlobEntry>((key) => ({ key, size: 0, folder: true }));
    const files = Object.keys(this.files)
      .filter(direct)
      .map<BlobEntry>((key) => ({ key, size: 0, folder: false }));
    return [...folders, ...files];
  }

  public async open(key: string, sink: BlobSink): Promise<void> {
    const text = this.files[key];
    if (text === undefined) throw new BlobNotFoundError(key);
    await sink.write(new TextEncoder().encode(text));
  }
}

function parentOf(key: string): string {
  const at = key.lastIndexOf('/');
  return at < 0 ? '' : key.slice(0, at);
}

/** A valid index whose pages are `sizes` bytes long, laid end to end. */
function indexJson(bookId: string, title: string, sizes: readonly number[]): string {
  let offset = 0;
  const pages = sizes.map((length) => {
    const page = { offset, length, sha256: 'b'.repeat(64), mime: 'image/webp' };
    offset += length;
    return page;
  });
  return JSON.stringify({
    v: PACK_INDEX_VERSION,
    bookId,
    title,
    pages,
    packSize: offset,
    createdAt: 1,
  });
}

describe('readRemoteCatalog', () => {
  it('lists published books by title with their page counts and sizes', async () => {
    const store = new FakeStore(
      {
        'bk-bbb/index.json': indexJson('bk:bbb', 'Berserk v02', [10, 20]),
        'bk-aaa/index.json': indexJson('bk:aaa', 'Akira v01', [5]),
      },
      ['bk-aaa', 'bk-bbb'],
    );

    const catalog = await readRemoteCatalog(store);

    expect(catalog.books.map((b) => [b.title, b.pageCount, b.packSize])).toEqual([
      ['Akira v01', 1, 5],
      ['Berserk v02', 2, 30],
    ]);
    expect(catalog.problems).toEqual([]);
  });

  it('skips a folder that simply is not a book', async () => {
    const store = new FakeStore(
      { 'bk-aaa/index.json': indexJson('bk:aaa', 'Akira v01', [5]) },
      ['bk-aaa', 'holiday-photos'],
    );

    const catalog = await readRemoteCatalog(store);

    expect(catalog.books.length).toBe(1);
    expect(catalog.problems).toEqual([]);
  });

  it('reports a book whose index cannot be used, without losing the others', async () => {
    const store = new FakeStore(
      {
        'bk-aaa/index.json': indexJson('bk:aaa', 'Akira v01', [5]),
        'bk-bad/index.json': '{ not json',
      },
      ['bk-aaa', 'bk-bad'],
    );

    const catalog = await readRemoteCatalog(store);

    expect(catalog.books.map((b) => b.title)).toEqual(['Akira v01']);
    expect(catalog.problems.length).toBe(1);
    expect(catalog.problems[0]).toContain('bk-bad');
  });

  it('points the preview at the file beside the pack', async () => {
    const withCover = JSON.stringify({
      ...JSON.parse(indexJson('bk:aaa', 'Akira v01', [5])),
      cover: { file: 'cover.webp', mime: 'image/webp' },
    });
    const store = new FakeStore({ 'bk-aaa/index.json': withCover }, ['bk-aaa']);

    const catalog = await readRemoteCatalog(store);

    expect(catalog.books[0].cover).toEqual({
      key: 'bk-aaa/cover.webp',
      mime: 'image/webp',
    });
  });

  it('accepts a link that points straight at one book', async () => {
    const store = new FakeStore({
      'index.json': indexJson('bk:aaa', 'Akira v01', [5, 5]),
      'pages.pack': 'pack bytes',
    });

    const catalog = await readRemoteCatalog(store);

    expect(catalog.books.length).toBe(1);
    expect(catalog.books[0].folder).toBe('');
    expect(catalog.books[0].pageCount).toBe(2);
  });

  it('ignores loose files at the root', async () => {
    const store = new FakeStore({ 'readme.txt': 'hello' }, []);

    const catalog = await readRemoteCatalog(store);

    expect(catalog.books).toEqual([]);
    expect(catalog.problems).toEqual([]);
  });
});
