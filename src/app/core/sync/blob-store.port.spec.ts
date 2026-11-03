import type { BlobEntry, BlobReader, BlobSink } from './blob-store.port';
import { listFiles, readBlob } from './blob-store.port';

/** In-memory reader: folders are explicit, files are emitted in two chunks. */
class MemoryReader implements BlobReader {
  public readonly id = 'memory';

  constructor(
    private readonly files: Readonly<Record<string, Uint8Array>>,
    private readonly folders: readonly string[] = [],
  ) {}

  public async list(prefix = ''): Promise<readonly BlobEntry[]> {
    const out: BlobEntry[] = [];
    for (const folder of this.folders) {
      if (parentOf(folder) === prefix) out.push({ key: folder, size: 0, folder: true });
    }
    for (const [key, bytes] of Object.entries(this.files)) {
      if (parentOf(key) === prefix) out.push({ key, size: bytes.length, folder: false });
    }
    return out;
  }

  public async open(key: string, sink: BlobSink): Promise<void> {
    const bytes = this.files[key];
    if (bytes === undefined) throw new Error(`missing ${key}`);
    const middle = Math.floor(bytes.length / 2);
    await sink.write(bytes.slice(0, middle));
    await sink.write(bytes.slice(middle));
  }
}

function parentOf(key: string): string {
  const at = key.lastIndexOf('/');
  return at < 0 ? '' : key.slice(0, at);
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('listFiles', () => {
  it('flattens nested folders down to the files', async () => {
    const reader = new MemoryReader(
      {
        'index.json': bytesOf('[]'),
        'bk-a/pages.pack': new Uint8Array([1, 2, 3]),
        'bk-b/pages.pack': new Uint8Array([4, 5]),
      },
      ['bk-a', 'bk-b'],
    );

    const files = await listFiles(reader);

    expect(files.map((f) => f.key).sort()).toEqual([
      'bk-a/pages.pack',
      'bk-b/pages.pack',
      'index.json',
    ]);
    expect(files.find((f) => f.key === 'bk-a/pages.pack')?.size).toBe(3);
  });

  it('refuses to walk a store nested deeper than it expects', async () => {
    const reader = new MemoryReader({}, ['a', 'a/b', 'a/b/c', 'a/b/c/d', 'a/b/c/d/e']);

    await expectAsync(listFiles(reader)).toBeRejected();
  });
});

describe('readBlob', () => {
  it('joins the chunks back into one buffer', async () => {
    const reader = new MemoryReader({ 'index.json': bytesOf('{"pages":2}') });

    const text = new TextDecoder().decode(await readBlob(reader, 'index.json'));

    expect(text).toBe('{"pages":2}');
  });

  it('refuses an object larger than the caller allowed', async () => {
    const reader = new MemoryReader({ 'pages.pack': new Uint8Array([1, 2, 3, 4, 5, 6]) });

    await expectAsync(readBlob(reader, 'pages.pack', { maxBytes: 4 })).toBeRejectedWithError(
      /larger than 4 bytes/,
    );
  });
});
