import type { BlobSink } from './blob-store.port';
import {
  MegaFolderBlobReader,
  blobReaderFor,
  describeMegaError,
  joinKey,
  type MegaDownload,
  type MegaNode,
} from './mega-folder.blob-reader';
import type { RemoteLibrary } from './remote-library.service';

/** A download stream that respects pause/resume, like a real one. */
class FakeStream {
  public destroyed = false;

  private readonly onData: ((chunk: Uint8Array) => void)[] = [];
  private readonly onEnd: (() => void)[] = [];
  private readonly onError: ((error: Error) => void)[] = [];
  private index = 0;
  private paused = false;

  constructor(private readonly chunks: readonly Uint8Array[]) {}

  public on(event: 'data' | 'end' | 'error', listener: (...args: never[]) => void): void {
    if (event === 'data') this.onData.push(listener as (chunk: Uint8Array) => void);
    else if (event === 'end') this.onEnd.push(listener as () => void);
    else this.onError.push(listener as (error: Error) => void);
  }

  public pause(): void {
    this.paused = true;
  }

  public resume(): void {
    this.paused = false;
    queueMicrotask(() => this.pump());
  }

  public destroy(): void {
    this.destroyed = true;
  }

  public start(): void {
    queueMicrotask(() => this.pump());
  }

  private pump(): void {
    if (this.destroyed || this.paused) return;
    if (this.index >= this.chunks.length) {
      for (const listener of this.onEnd) listener();
      return;
    }
    const chunk = this.chunks[this.index];
    this.index += 1;
    for (const listener of this.onData) listener(chunk);
    queueMicrotask(() => this.pump());
  }
}

function fileNode(name: string, bytes: Uint8Array, chunks = 2): MegaNode {
  const size = Math.ceil(bytes.length / chunks);
  const parts: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    parts.push(bytes.slice(offset, offset + size));
  }
  const stream = new FakeStream(parts);
  return {
    name,
    size: bytes.length,
    download: (): MegaDownload => {
      stream.start();
      return stream as unknown as MegaDownload;
    },
  };
}

function folderNode(name: string, children: readonly MegaNode[]): MegaNode {
  return { name, directory: true, children };
}

const LIBRARY: RemoteLibrary = {
  kind: 'mega-folder-link',
  url: 'https://mega.nz/folder/AbCd1234#xYz-1234567890abcdef',
  handle: 'AbCd1234',
  key: 'xYz-1234567890abcdef',
  addedAt: 1,
};

const INDEX = new TextEncoder().encode('{"pages":2}');
const PACK = new Uint8Array([1, 2, 3, 4, 5, 6]);

function tree(): MegaNode {
  return folderNode('Emaki', [
    folderNode('bk-a', [fileNode('pages.pack', PACK), fileNode('index.json', INDEX)]),
  ]);
}

function reader(): MegaFolderBlobReader {
  return new MegaFolderBlobReader(LIBRARY, () => Promise.resolve(tree()));
}

/** Collects everything a download writes. */
function collector(): { sink: BlobSink; bytes: () => Uint8Array } {
  const chunks: Uint8Array[] = [];
  return {
    sink: {
      write: (chunk) => {
        chunks.push(chunk);
        return Promise.resolve();
      },
    },
    bytes: () => {
      const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
      }
      return out;
    },
  };
}

describe('MegaFolderBlobReader', () => {
  it('maps the root of the shared folder to entries with folder flags', async () => {
    const entries = await reader().list();

    expect(entries).toEqual([{ key: 'bk-a', size: 0, folder: true }]);
  });

  it('resolves a nested folder and reports sizes', async () => {
    const entries = await reader().list('bk-a');

    expect(entries.map((e) => [e.key, e.size, e.folder])).toEqual([
      ['bk-a/pages.pack', PACK.length, false],
      ['bk-a/index.json', INDEX.length, false],
    ]);
  });

  it('streams a file to the sink and reports progress', async () => {
    const { sink, bytes } = collector();
    const progress: number[] = [];

    await reader().open('bk-a/pages.pack', sink, {
      onProgress: (received) => progress.push(received),
    });

    expect(Array.from(bytes())).toEqual([1, 2, 3, 4, 5, 6]);
    expect(progress).toEqual([0, 3, 6]);
  });

  it('rejects a key the shared folder does not contain', async () => {
    await expectAsync(reader().open('bk-z/pages.pack', collector().sink)).toBeRejectedWithError(
      /no "bk-z\/pages.pack"/,
    );
  });

  it('stops and rejects when the caller aborts', async () => {
    const controller = new AbortController();
    let error: Error | null = null;
    let sawStream = false;

    try {
      await reader().open('bk-a/pages.pack', collector().sink, {
        signal: controller.signal,
        onProgress: (received) => {
          if (received > 0 && !controller.signal.aborted) {
            sawStream = true;
            controller.abort();
          }
        },
      });
    } catch (caught) {
      error = caught as Error;
    }

    expect(sawStream).toBe(true);
    expect(error?.name).toBe('AbortError');
  });
});

describe('blobReaderFor', () => {
  it('builds a MEGA reader for a folder link', () => {
    const store = blobReaderFor(LIBRARY);

    expect(store).toBeInstanceOf(MegaFolderBlobReader);
    expect(store.id).toBe('mega-folder-link');
  });
});

describe('describeMegaError', () => {
  it('turns MEGA quota codes into something readable', () => {
    const error = describeMegaError(new Error('API error -17: EOVERQUOTA'));

    expect(error.message).toContain('transfer quota');
  });

  it('leaves an unrelated error alone', () => {
    const original = new Error('socket closed');

    expect(describeMegaError(original)).toBe(original);
  });
});

describe('joinKey', () => {
  it('treats the root as no prefix', () => {
    expect(joinKey('', 'bk-a')).toBe('bk-a');
    expect(joinKey('bk-a', 'pages.pack')).toBe('bk-a/pages.pack');
  });
});
