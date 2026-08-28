import { InjectionToken } from '@angular/core';

/**
 * A node in the library's folder tree (the file explorer).
 *
 * Every book is itself a folder of pages. A folder whose `isBook` is true can
 * be opened in the reader once it has been scanned (`imageUrls` present and the
 * scanner has registered it on the shelf). Folders that have not been scanned
 * (or that are just containers) render as plain folders in the explorer.
 */
export interface FsFolder {
  /** Stable id (path-based, unique within the tree). */
  readonly id: string;
  /** Display name (folder name). */
  readonly name: string;
  /** True when this folder is itself a book (a folder of pages). */
  readonly isBook: boolean;
  /** Present once the book has been scanned — used for cover + reader pages. */
  readonly imageUrls?: readonly string[];
  /** Child folders. */
  readonly children: readonly FsFolder[];
}

/** The root of the library tree returned by a scan discovery. */
export interface LibraryTree {
  readonly root: FsFolder;
}

/**
 * Backend that discovers the library's folder tree. v1 ships
 * `AssetsPresetScanner` (debug/web manifest). Real devices plug in behind this
 * token later: Tauri (desktop) and `@capacitor-community/saf` (Android) — they
 * just need to return the same `LibraryTree` shape.
 */
export interface LibraryScannerPort {
  discover(): Promise<LibraryTree>;
}

export const LIBRARY_SCANNER = new InjectionToken<LibraryScannerPort>('LIBRARY_SCANNER');
