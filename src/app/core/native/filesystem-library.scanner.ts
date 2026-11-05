import { Injectable, inject } from '@angular/core';

import type { FsFolder, LibraryScannerPort, LibraryTree } from './library-scanner.port';
import { FILE_SYSTEM_BROWSER } from './file-system-browser.port';
import { LibrarySeriesService } from '../services/library-series.service';

const MAX_DEPTH = 6;

/** App-internal folder names that must never surface in the library tree.
 *  Enhancement writes derivatives to `<book>/.enhanced/`; treating it as a
 *  book would misclassify its parent (series) and list upscaled pages as
 *  originals. */
const HIDDEN_DIRS = new Set(['.enhanced']);

/**
 * Builds the shelf from the folders the user added.
 *
 * Each added folder is one series. A folder that directly contains images is a
 * **book** (openable). A folder that contains subfolders is navigable, and its
 * subfolders are the books. The library itself is not a path on disk.
 * Archives are ignored for now.
 */
@Injectable({ providedIn: 'root' })
export class FileSystemLibraryScanner implements LibraryScannerPort {
  private readonly fs = inject(FILE_SYSTEM_BROWSER);
  private readonly seriesSvc = inject(LibrarySeriesService);

  async discover(): Promise<LibraryTree> {
    if (this.fs.importLegacyRoot) {
      const legacy = await this.fs.importLegacyRoot();
      if (legacy) {
        this.seriesSvc.add(legacy);
        this.seriesSvc.clearLegacyPath();
      }
    }

    const children: FsFolder[] = [];
    for (const series of this.seriesSvc.series()) {
      try {
        children.push(await this.buildNode(series.path, series.name, 0));
      } catch (err) {
        console.error('[fs-scanner] discover() FAILED walking series:', series.path, err);
        children.push({
          id: `fs:${series.path}`,
          name: series.name,
          isBook: false,
          children: [],
        });
      }
    }
    return { root: { id: 'root', name: 'Library', isBook: false, children } };
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
