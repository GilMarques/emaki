import type { BlobDownloadOptions, BlobEntry, BlobSink, BlobStore } from './blob-store.port';
import { BlobNotFoundError } from './blob-store.port';
import type { MegaNode } from './mega-node.io';
import { downloadNode, isFolder, joinKey, listNode, nodeAt } from './mega-node.io';

/**
 * The signed-in account as a writable `BlobStore`.
 *
 * Only the computer ever holds this: it is the one device allowed to publish,
 * so the write credential never travels with a phone that leaves the house.
 * Everything lands under one folder (`Emaki` by default) so the library stays
 * findable and the folder can be shared read-only with the other devices.
 */

/** A node the signed-in account may change. */
export interface MegaMutableNode extends MegaNode {
  readonly children?: readonly MegaMutableNode[];
  mkdir?(name: string): Promise<MegaMutableNode>;
  upload?(
    options: { name: string; size: number },
    data: Uint8Array,
  ): { readonly complete: Promise<unknown> };
  delete?(permanent?: boolean): Promise<unknown>;
}

/** The subset of a logged-in storage this store uses. */
export interface MegaStorage {
  readonly root: MegaMutableNode;
  /** Session token. The password is never stored, only this. */
  toJSON(): unknown;
  close?(): unknown;
}

/** Folder the library lives in, at the root of the account. */
export const LIBRARY_FOLDER = 'Emaki';

export class MegaAccountBlobStore implements BlobStore {
  public readonly id = 'mega-account';

  /** Folders this store created or found, so a walk happens once. */
  private readonly known = new Map<string, MegaMutableNode>();

  constructor(
    private readonly storage: MegaStorage,
    private readonly base: string = LIBRARY_FOLDER,
  ) {}

  public async list(prefix = ''): Promise<readonly BlobEntry[]> {
    return listNode(await this.folderAt(prefix, false), prefix);
  }

  public async open(
    key: string,
    sink: BlobSink,
    options: BlobDownloadOptions = {},
  ): Promise<void> {
    await downloadNode(await this.nodeAt(key), sink, options);
  }

  public async put(key: string, data: Uint8Array): Promise<void> {
    const { path, name } = splitKey(key);
    const folder = await this.folderAt(path, true);

    // MEGA allows same-name siblings, so replacing means deleting first —
    // otherwise republishing a book leaves the store with two of everything.
    const existing = folder.children?.find((child) => child.name === name);
    if (existing?.delete !== undefined) await existing.delete(true);

    const upload = folder.upload?.({ name, size: data.length }, data);
    if (upload === undefined) throw new Error('This MEGA session cannot write files.');
    await upload.complete;
  }

  public async remove(key: string): Promise<void> {
    const node = await this.nodeAt(key);
    if (node.delete === undefined) throw new Error('This MEGA session cannot delete files.');
    await node.delete(true);
  }

  /** The library folder, created on first publish. */
  private async baseFolder(create: boolean): Promise<MegaMutableNode> {
    const cached = this.known.get('');
    if (cached !== undefined) return cached;
    const root = this.storage.root;
    const existing = root.children?.find(
      (child) => child.name === this.base && isFolder(child),
    );
    if (existing !== undefined) {
      this.known.set('', existing);
      return existing;
    }
    if (!create) throw new BlobNotFoundError(this.base);
    const created = await root.mkdir?.(this.base);
    if (created === undefined) throw new Error('This MEGA session cannot create folders.');
    this.known.set('', created);
    return created;
  }

  /** Resolve (and optionally create) a folder path under the library folder. */
  private async folderAt(path: string, create: boolean): Promise<MegaMutableNode> {
    const normalized = path
      .split('/')
      .filter((part) => part.length > 0)
      .join('/');
    let node = await this.baseFolder(create || normalized !== '');
    if (normalized === '') return node;

    let prefix = '';
    for (const segment of normalized.split('/')) {
      prefix = prefix === '' ? segment : `${prefix}/${segment}`;
      const cached = this.known.get(prefix);
      if (cached !== undefined) {
        node = cached;
        continue;
      }
      const existing = node.children?.find(
        (child) => child.name === segment && isFolder(child),
      );
      if (existing !== undefined) {
        node = existing;
        this.known.set(prefix, existing);
        continue;
      }
      if (!create) throw new BlobNotFoundError(joinKey(this.base, prefix));
      const created = await node.mkdir?.(segment);
      if (created === undefined) throw new Error('This MEGA session cannot create folders.');
      node = created;
      this.known.set(prefix, created);
    }
    return node;
  }

  /** Resolve one file inside the store. */
  private async nodeAt(key: string): Promise<MegaMutableNode> {
    const { path, name } = splitKey(key);
    const folder = await this.folderAt(path, false);
    const child = folder.children?.find((node) => node.name === name);
    if (child === undefined) throw new BlobNotFoundError(key);
    return child;
  }
}

/** Split `bk-x/pages.pack` into its folder and file name. */
function splitKey(key: string): { path: string; name: string } {
  const segments = key.split('/').filter((part) => part.length > 0);
  const name = segments.pop();
  if (name === undefined) throw new Error(`Not a store key: "${key}".`);
  return { path: segments.join('/'), name };
}
