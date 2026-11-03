import { BlobNotFoundError } from './blob-store.port';
import type { MegaMutableNode, MegaStorage } from './mega-account.blob-store';
import { LIBRARY_FOLDER, MegaAccountBlobStore } from './mega-account.blob-store';

/** A node tree that records what the store does to it. */
class FakeNode implements MegaMutableNode {
  public readonly children: FakeNode[] = [];
  public readonly uploads: { name: string; size: number }[] = [];
  public deleted = false;
  public parent: FakeNode | null = null;

  constructor(
    public readonly name: string,
    public readonly directory = false,
    private readonly bytes: number = 0,
  ) {}

  public get size(): number {
    return this.bytes;
  }

  public mkdir(name: string): Promise<MegaMutableNode> {
    const child = new FakeNode(name, true);
    child.parent = this;
    this.children.push(child);
    return Promise.resolve(child);
  }

  public upload(
    options: { name: string; size: number },
    _data: Uint8Array,
  ): { complete: Promise<unknown> } {
    const child = new FakeNode(options.name, false, options.size);
    child.parent = this;
    this.children.push(child);
    this.uploads.push({ name: options.name, size: options.size });
    return { complete: Promise.resolve(child) };
  }

  public delete(): Promise<unknown> {
    this.deleted = true;
    const parent = this.parent;
    if (parent !== null) {
      const at = parent.children.indexOf(this);
      if (at >= 0) parent.children.splice(at, 1);
    }
    return Promise.resolve();
  }
}

function storageWith(root: FakeNode): MegaStorage {
  return { root, toJSON: () => ({ sid: 'session' }) };
}

function find(node: FakeNode, name: string): FakeNode | undefined {
  return node.children.find((child) => child.name === name);
}

describe('MegaAccountBlobStore', () => {
  it('creates the library folder and the book folder on first publish', async () => {
    const root = new FakeNode('', true);
    const store = new MegaAccountBlobStore(storageWith(root));

    await store.put('bk-a/pages.pack', new Uint8Array([1, 2, 3]));

    const library = find(root, LIBRARY_FOLDER);
    expect(library?.directory).toBe(true);
    const book = find(library as FakeNode, 'bk-a');
    expect(book?.uploads).toEqual([{ name: 'pages.pack', size: 3 }]);
  });

  it('replaces a file it already published instead of adding a duplicate', async () => {
    const root = new FakeNode('', true);
    const store = new MegaAccountBlobStore(storageWith(root));

    await store.put('bk-a/pages.pack', new Uint8Array([1]));
    await store.put('bk-a/pages.pack', new Uint8Array([1, 2]));

    const book = find(find(root, LIBRARY_FOLDER) as FakeNode, 'bk-a') as FakeNode;
    expect(book.children.filter((child) => child.name === 'pages.pack').length).toBe(1);
    expect(book.uploads).toEqual([
      { name: 'pages.pack', size: 1 },
      { name: 'pages.pack', size: 2 },
    ]);
  });

  it('lists a folder with sizes and folder flags', async () => {
    const root = new FakeNode('', true);
    await storeFor(root).put('bk-a/pages.pack', new Uint8Array([1, 2, 3, 4]));
    await storeFor(root).put('bk-a/index.json', new Uint8Array([1]));

    const entries = await storeFor(root).list('bk-a');

    expect(entries.map((e) => [e.key, e.size, e.folder])).toEqual([
      ['bk-a/pages.pack', 4, false],
      ['bk-a/index.json', 1, false],
    ]);
  });

  it('deletes a file by key', async () => {
    const root = new FakeNode('', true);
    const store = storeFor(root);
    await store.put('bk-a/pages.pack', new Uint8Array([1]));

    await store.remove('bk-a/pages.pack');

    const book = find(find(root, LIBRARY_FOLDER) as FakeNode, 'bk-a') as FakeNode;
    expect(book.children).toEqual([]);
  });

  it('lists nothing when the account has never published', async () => {
    const store = storeFor(new FakeNode('', true));

    expect(await store.list()).toEqual([]);
  });

  it('reports a missing file as not found', async () => {
    const store = storeFor(new FakeNode('', true));

    await expectAsync(
      store.open('bk-a/pages.pack', { write: () => Promise.resolve() }),
    ).toBeRejectedWithError(BlobNotFoundError);
  });

  it('says so when the session cannot create folders', async () => {
    const root: MegaMutableNode = { name: '', directory: true, children: [] };
    const store = new MegaAccountBlobStore({ root, toJSON: () => ({}) });

    await expectAsync(store.put('bk-a/pages.pack', new Uint8Array([1]))).toBeRejectedWithError(
      /cannot create folders/,
    );
  });
});

/** A store over the same tree, so folder lookups are exercised repeatedly. */
function storeFor(root: FakeNode): MegaAccountBlobStore {
  return new MegaAccountBlobStore(storageWith(root));
}
