import type {
  BlobDownloadOptions,
  BlobEntry,
  BlobReader,
  BlobSink,
} from './blob-store.port';
import { BlobNotFoundError } from './blob-store.port';
import type { RemoteLibrary } from './remote-library.service';

/**
 * A MEGA folder link as a `BlobReader`.
 *
 * The link is read-only by MEGA's design ("exported folders cannot be written
 * to"), which is exactly what a reading device should get: no credential, no
 * account, and no way to damage the library.
 *
 * The node tree is injected rather than imported outright so the mapping can
 * be tested without a network, and so `megajs` — about a megabyte of JS with
 * its own crypto — is only loaded once a link is actually used.
 */

/** The subset of megajs' download stream this reader relies on. */
export interface MegaDownload {
  on(event: 'data', listener: (chunk: Uint8Array) => void): void;
  on(event: 'end', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  pause(): void;
  resume(): void;
  destroy(): void;
}

/** The subset of a megajs node this reader relies on. */
export interface MegaNode {
  readonly name: string;
  readonly size?: number;
  readonly directory?: boolean;
  readonly children?: readonly MegaNode[];
  download?(): MegaDownload;
}

/** Loads the shared folder for a link. Swapped out in tests. */
export type MegaRootLoader = (url: string) => Promise<MegaNode>;

/** Default loader: the real megajs client, imported on first use. */
export async function loadMegaFolder(url: string): Promise<MegaNode> {
  const { File } = await import('megajs');
  const folder = File.fromURL(url) as unknown as MegaNode & {
    loadAttributes(): Promise<unknown>;
  };
  await folder.loadAttributes();
  return folder;
}

export class MegaFolderBlobReader implements BlobReader {
  public readonly id = 'mega-folder-link';

  private root: Promise<MegaNode> | null = null;

  constructor(
    private readonly library: Pick<RemoteLibrary, 'url'>,
    private readonly loadRoot: MegaRootLoader = loadMegaFolder,
  ) {}

  public async list(prefix = ''): Promise<readonly BlobEntry[]> {
    const node = await this.nodeAt(prefix);
    const children = node.children;
    if (children === undefined) {
      throw new Error(`"${prefix}" is a file, not a folder.`);
    }
    return children.map<BlobEntry>((child) => ({
      key: joinKey(prefix, child.name),
      size: child.size ?? 0,
      folder: isFolder(child),
    }));
  }

  public async open(
    key: string,
    sink: BlobSink,
    options: BlobDownloadOptions = {},
  ): Promise<void> {
    const node = await this.nodeAt(key);
    const download = node.download;
    if (download === undefined) {
      throw new Error(`"${key}" is a folder, not a file.`);
    }
    if (options.signal?.aborted === true) throw abortError();

    const stream = download();
    const total = node.size ?? 0;
    options.onProgress?.(0, total);

    await new Promise<void>((resolve, reject) => {
      let received = 0;
      let settled = false;
      // Writes are serialised: a disk-backed sink is slower than the network,
      // and buffering an unread pack in the heap is the thing to avoid.
      let chain: Promise<void> = Promise.resolve();

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener('abort', onAbort);
        if (error === undefined) resolve();
        else reject(error);
      };

      const onAbort = (): void => {
        stream.destroy();
        finish(abortError());
      };

      options.signal?.addEventListener('abort', onAbort, { once: true });

      stream.on('data', (chunk) => {
        if (settled) return;
        stream.pause();
        chain = chain
          .then(async () => {
            if (settled) return;
            const bytes = toBytes(chunk);
            await sink.write(bytes);
            received += bytes.length;
            options.onProgress?.(received, total);
            if (!settled) stream.resume();
          })
          .catch((error: unknown) => {
            stream.destroy();
            finish(error instanceof Error ? error : new Error(String(error)));
          });
      });

      stream.on('error', (error) => {
        void chain.then(() => finish(describeMegaError(error)));
      });
      // Do not report completion before the last write is on disk.
      stream.on('end', () => {
        void chain.then(
          () => finish(),
          () => finish(),
        );
      });
    });
  }

  /** Resolve a slash path inside the shared folder. */
  private async nodeAt(key: string): Promise<MegaNode> {
    let node = await this.rootNode();
    for (const segment of key.split('/').filter((part) => part.length > 0)) {
      const children = node.children;
      if (children === undefined) {
        throw new BlobNotFoundError(key);
      }
      const next = children.find((child) => child.name === segment);
      if (next === undefined) {
        throw new BlobNotFoundError(key);
      }
      node = next;
    }
    return node;
  }

  /** Log in to the link once; a failure clears the cache so retry can work. */
  private rootNode(): Promise<MegaNode> {
    if (this.root === null) {
      this.root = this.loadRoot(this.library.url).catch((error: unknown) => {
        this.root = null;
        throw describeMegaError(error);
      });
    }
    return this.root;
  }
}

/** Build the reader for a configured library. */
export function blobReaderFor(library: RemoteLibrary): BlobReader {
  switch (library.kind) {
    case 'mega-folder-link':
      return new MegaFolderBlobReader(library);
    default: {
      const unsupported: never = library.kind;
      throw new Error(`Unsupported store: ${String(unsupported)}`);
    }
  }
}

/** Path of a child inside its parent. */
export function joinKey(prefix: string, name: string): string {
  return prefix === '' ? name : `${prefix}/${name}`;
}

/**
 * Turn a MEGA client error into something worth showing a person.
 *
 * MEGA reports failures as numeric API codes; the ones a reader can actually
 * hit are quota, throttling and a link that no longer points at the folder.
 */
export function describeMegaError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/EOVERQUOTA|\(-17\)/.test(message)) {
    return new Error('MEGA’s transfer quota is exhausted. Try again later.');
  }
  if (/EAGAIN|\(-3\)/.test(message)) {
    return new Error('MEGA is busy or limiting this connection. Try again in a moment.');
  }
  if (/ENOENT|\(-9\)/.test(message)) {
    return new Error('That file is no longer in the shared folder.');
  }
  if (/EACCESS|\(-11\)/.test(message)) {
    return new Error('The shared folder is no longer accessible.');
  }
  return error instanceof Error ? error : new Error(message);
}

function isFolder(node: MegaNode): boolean {
  return node.directory === true || node.children !== undefined;
}

function abortError(): Error {
  const error = new Error('The download was cancelled.');
  error.name = 'AbortError';
  return error;
}

function toBytes(chunk: unknown): Uint8Array {
  if (chunk instanceof Uint8Array) return chunk;
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  throw new Error('The store sent a chunk that is not binary data.');
}
