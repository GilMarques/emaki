import { InjectionToken } from '@angular/core';

/** A book found by a scanner before it is turned into a full `Book`. */
export interface DiscoveredBook {
  readonly id: string;
  readonly title: string;
  readonly imageUrls: readonly string[];
}

/**
 * Backend that discovers books. v1 ships `AssetsPresetScanner` (debug/web
 * manifest). Real devices plug in behind this token later: Tauri (desktop)
 * and `@capacitor-community/saf` (Android).
 */
export interface LibraryScannerPort {
  discover(): Promise<readonly DiscoveredBook[]>;
}

export const LIBRARY_SCANNER = new InjectionToken<LibraryScannerPort>('LIBRARY_SCANNER');
