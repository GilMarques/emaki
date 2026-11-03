import { BlobNotFoundError } from './blob-store.port';
import type { BlobDownloadOptions, BlobEntry, BlobSink } from './blob-store.port';

/**
 * The parts of megajs' node tree this app uses, and the operations both the
 * read-only folder reader and the account store need.
 *
 * Kept as a hand-written subset on purpose: megajs pulls in `@types/node`,
 * and a narrow local type keeps the blast radius at one file while still
 * being honest about what is actually called.
 */

/** The subset of megajs' download stream this app relies on. */
export interface MegaDownload {
  on(event: 'data', listener: (chunk: Uint8Array) => void): void;
  on(event: 'end', listener: () => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  pause(): void;
  resume(): void;
  destroy(): void;
}

/** A node in a MEGA tree: a file or a folder. */
export interface MegaNode {
  readonly name: string;
  readonly size?: number;
  readonly directory?: boolean;
  readonly children?: readonly MegaNode[];
  download?(): MegaDownload;
}

export function isFolder(node: MegaNode): boolean {
  // The explicit flag wins: a file node can carry an empty `children` array in
  // some clients, and inferring from "has a children field" would call it a
  // folder. Only fall back when the flag is missing altogether.
  if (node.directory !== undefined) return node.directory;
  return node.children !== undefined;
}

/** Path of a child inside its parent. */
export function joinKey(prefix: string, name: string): string {
  return prefix === '' ? name : `${prefix}/${name}`;
}

/** Resolve a slash path inside a tree. Throws `BlobNotFoundError` when absent. */
export function nodeAt(root: MegaNode, key: string): MegaNode {
  let node = root;
  for (const segment of key.split('/').filter((part) => part.length > 0)) {
    const children = node.children;
    if (children === undefined) throw new BlobNotFoundError(key);
    const next = children.find((child) => child.name === segment);
    if (next === undefined) throw new BlobNotFoundError(key);
    node = next;
  }
  return node;
}

/** Direct children of a folder, as store entries. */
export function listNode(node: MegaNode, prefix: string): readonly BlobEntry[] {
  const children = node.children;
  if (children === undefined) throw new Error(`"${prefix}" is a file, not a folder.`);
  return children.map<BlobEntry>((child) => ({
    key: joinKey(prefix, child.name),
    size: child.size ?? 0,
    folder: isFolder(child),
  }));
}

/**
 * Stream one node into a sink.
 *
 * Writes are serialised and the stream is paused between them: a disk-backed
 * sink is slower than the network, and letting chunks pile up is how a pack
 * ends up in the heap. Completion is reported only once the last write has
 * been awaited, so a caller that closes its sink on resolve never truncates.
 */
export async function downloadNode(
  node: MegaNode,
  sink: BlobSink,
  options: BlobDownloadOptions = {},
): Promise<void> {
  const download = node.download;
  if (download === undefined) {
    throw new Error(`"${node.name}" is a folder, not a file.`);
  }
  if (options.signal?.aborted === true) throw abortError();

  const stream = download();
  const total = node.size ?? 0;
  options.onProgress?.(0, total);

  await new Promise<void>((resolve, reject) => {
    let received = 0;
    let settled = false;
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
    stream.on('end', () => {
      void chain.then(
        () => finish(),
        () => finish(),
      );
    });
  });
}

/**
 * Turn a MEGA client error into something worth showing a person.
 *
 * MEGA reports failures as numeric API codes; the ones a device can actually
 * hit are quota, throttling, and a link that no longer points at the folder.
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

/** True when MEGA refused a login because a two-factor code is required. */
export function isTwoFactorError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /-26\b|EMFAREQUIRED|second factor|two-factor|2fa/i.test(message);
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
