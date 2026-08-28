import { Injectable } from '@angular/core';

import type { DiscoveredBook, LibraryScannerPort } from './library-scanner.port';

interface PresetBookEntry {
  readonly id: string;
  readonly title: string;
  readonly imageUrls: readonly string[];
}

interface PresetManifest {
  readonly books: readonly PresetBookEntry[];
}

/**
 * Debug/web-only scanner: reads the generated `assets/preset-books.json`
 * manifest (see `scripts/gen-preset-books.mjs`). Real-device scanning
 * (Tauri desktop, Android SAF) plugs in behind LIBRARY_SCANNER later.
 */
@Injectable()
export class AssetsPresetScanner implements LibraryScannerPort {
  public async discover(): Promise<readonly DiscoveredBook[]> {
    try {
      const res = await fetch('assets/preset-books.json');
      if (!res.ok) return [];
      const manifest = (await res.json()) as PresetManifest;
      return manifest.books ?? [];
    } catch {
      return [];
    }
  }
}
