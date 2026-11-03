import type { BlobReader, BlobSink } from './blob-store.port';
import { readBlob } from './blob-store.port';

/** In-memory reader: files are emitted in two chunks. */
class MemoryReader implements BlobReader {
  public readonly id = 'memory';

  constructor(private readonly files: Readonly<Record<string, Uint8Array>>) {}

  public list(): Promise<readonly never[]> {
    return Promise.resolve([]);
  }

  public async open(key: string, sink: BlobSink): Promise<void> {
    const bytes = this.files[key];
    if (bytes === undefined) throw new Error(`missing ${key}`);
    const middle = Math.floor(bytes.length / 2);
    await sink.write(bytes.slice(0, middle));
    await sink.write(bytes.slice(middle));
  }
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

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
