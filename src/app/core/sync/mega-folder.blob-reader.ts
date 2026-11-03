import type { BlobDownloadOptions, BlobEntry, BlobReader, BlobSink } from './blob-store.port';
import type { MegaNode } from './mega-node.io';
import {
  describeMegaError,
  downloadNode,
  joinKey,
  listNode,
  nodeAt,
} from './mega-node.io';
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

export type { MegaDownload, MegaNode } from './mega-node.io';
export { describeMegaError, joinKey };

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
    return listNode(nodeAt(await this.rootNode(), prefix), prefix);
  }

  public async open(
    key: string,
    sink: BlobSink,
    options: BlobDownloadOptions = {},
  ): Promise<void> {
    await downloadNode(nodeAt(await this.rootNode(), key), sink, options);
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
