import { Injectable } from '@angular/core';

import type { LibraryScannerPort, LibraryTree } from './library-scanner.port';

/**
 * Debug/web-only scanner: reads the generated `assets/preset-library.json`
 * manifest (see `scripts/gen-preset-books.mjs`). The manifest describes the
 * full folder tree; book leaves carry their page URLs so the ScannerService
 * can register them on scan. Real-device scanning (Tauri desktop, Android SAF)
 * plugs in behind LIBRARY_SCANNER later and returns the same tree shape.
 */
@Injectable()
export class AssetsPresetScanner implements LibraryScannerPort {
  public async discover(): Promise<LibraryTree> {
    try {
      const res = await fetch('assets/preset-library.json');
      if (!res.ok) return { root: { id: 'root', name: 'Library', isBook: false, children: [] } };
      const manifest = (await res.json()) as LibraryTree;
      return manifest?.root ? manifest : { root: { id: 'root', name: 'Library', isBook: false, children: [] } };
    } catch {
      return { root: { id: 'root', name: 'Library', isBook: false, children: [] } };
    }
  }
}
