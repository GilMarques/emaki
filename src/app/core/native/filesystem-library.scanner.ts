import { Injectable, inject } from '@angular/core';

import type { FsFolder, LibraryScannerPort, LibraryTree } from './library-scanner.port';
import { FILE_SYSTEM_BROWSER } from './file-system-browser.port';
import { LibraryRootService } from '../services/library-root.service';

const MAX_DEPTH = 6;

/** App-internal folder names that must never surface in the library tree.
 *  Enhancement writes derivatives to `<book>/.enhanced/`; treating it as a
 *  book would misclassify its parent (series) and list upscaled pages as
 *  originals. */
const HIDDEN_DIRS = new Set(['.enhanced']);

/** Last path segment of an absolute path (handles `/` and `\`). */
function basename(path: string): string {
  const norm = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = norm.lastIndexOf('/');
  return idx < 0 ? norm : norm.slice(idx + 1) || norm;
}

/** Human-readable name for a root path. SAF content URIs carry the document id
 *  URL-encoded (`…/tree/primary%3AComics`); decode it and strip the storage
 *  volume prefix (`primary:`) so the breadcrumb reads "Comics". */
function displayName(path: string): string {
  if (path.startsWith('content://')) {
    const idx = path.lastIndexOf('/');
    const raw = idx < 0 ? path : path.slice(idx + 1);
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      // not valid percent-encoding — keep raw
    }
    const colon = decoded.indexOf(':');
    return colon > 0 ? decoded.slice(colon + 1) : decoded;
  }
  return basename(path);
}

/**
 * Desktop scanner: reads the user's chosen library root from disk and builds the
 * same `FsFolder` tree the shelf already navigates.
 *
 * Convention (from the plan): a folder that directly contains images is a
 * **book** (openable). A folder that contains subfolders is a **series** — it is
 * navigable, and its subfolders are the books. We descend one level to reach
 * books; deeper nesting is not flattened. Archives are ignored for now.
 */
@Injectable({ providedIn: 'root' })
export class FileSystemLibraryScanner implements LibraryScannerPort {
  private readonly fs = inject(FILE_SYSTEM_BROWSER);
  private readonly rootSvc = inject(LibraryRootService);

  async discover(): Promise<LibraryTree> {
    const root = this.rootSvc.root();
    if (!root) {
      return { root: { id: 'root', name: 'Library', isBook: false, children: [] } };
    }
    try {
      const tree = await this.buildNode(root, displayName(root), 0);
      return { root: tree };
    } catch (err) {
      console.error('[fs-scanner] discover() FAILED walking root:', root, err);
      return { root: { id: 'root', name: 'Library', isBook: false, children: [] } };
    }
  }

  private async buildNode(path: string, name: string, depth: number): Promise<FsFolder> {
    const entries = await this.fs.listDirectory(path);
    const subfolders = entries.filter((e) => e.kind === 'dir' && !HIDDEN_DIRS.has(e.name));
    const images = entries
      .filter((e) => e.kind === 'image')
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    const id = `fs:${path}`;

    // Series: has subfolders → navigate into them (they are the books).
    if (subfolders.length > 0 && depth < MAX_DEPTH) {
      const children = await Promise.all(
        subfolders.map((sf) => this.buildNode(sf.path, sf.name, depth + 1)),
      );
      return { id, name, isBook: false, children };
    }

    // Book: holds images directly → openable, with pages = the images.
    if (images.length > 0) {
      return {
        id,
        name,
        isBook: true,
        imageUrls: images.map((i) => i.path),
        children: [],
      };
    }

    return { id, name, isBook: false, children: [] };
  }
}
