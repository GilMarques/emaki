import { InjectionToken } from '@angular/core';

/** One entry in a directory listing returned by the file browser. */
export interface FsEntry {
  /** Display name (file/folder name). */
  readonly name: string;
  /** Absolute filesystem path. */
  readonly path: string;
  /** `dir` | `image` | `archive` | `other`. */
  readonly kind: 'dir' | 'image' | 'archive' | 'other';
  /** True when this entry can be opened as a book (an image folder or an archive). */
  readonly isBook: boolean;
}

/** Result of extracting a comic archive to a temp dir. */
export interface ArchiveInfo {
  readonly tempDir: string;
  readonly entries: readonly { readonly name: string; readonly path: string }[];
}

/**
 * Backend that lets the shelf roam the real filesystem. The Tauri build provides
 * `TauriFsBrowser` (real). The debug/web build provides `UnavailableFsBrowser`
 * so the `Files` tab stays hidden and the preset Library is unaffected.
 *
 * `convertFileSrc` is optional: when the Tauri host exposes it (global Tauri),
 * pages are served lazily by path (no byte preloading); otherwise the resolver
 * falls back to reading bytes and serving blob URLs.
 */
export interface FileSystemBrowser {
  isAvailable(): boolean;
  pickDirectory(): Promise<string | null>;
  listDirectory(path: string): Promise<readonly FsEntry[]>;
  readFile(path: string): Promise<Blob>;
  /** Byte size of a file at `path`, or null when it can't be stat'ed. */
  stat(path: string): Promise<number | null>;
  openArchive(path: string): Promise<ArchiveInfo>;
  cleanupArchive(tempDir: string): Promise<void>;
  convertFileSrc?(path: string): string | null;
}

export const FILE_SYSTEM_BROWSER = new InjectionToken<FileSystemBrowser>(
  'FILE_SYSTEM_BROWSER',
);
