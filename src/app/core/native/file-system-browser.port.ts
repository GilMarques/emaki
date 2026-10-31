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
 * Backend that lets the shelf roam the real filesystem. Android provides
 * `SafFileSystemBrowser` (SAF); the desktop provides `FileSystemAccessBrowser`
 * (File System Access API in Chrome/Edge). Browsers without either API get a
 * browser whose `isAvailable()` is false, so the `Files` tab stays hidden and
 * the preset Library is unaffected.
 *
 * `convertFileSrc` is optional: when the host can serve a file by path it is
 * used to avoid preloading bytes; otherwise the resolver reads the bytes and
 * serves blob URLs.
 */
export interface FileSystemBrowser {
  isAvailable(): boolean;
  pickDirectory(): Promise<string | null>;
  /**
   * Re-attach to a previously picked folder without prompting, when the
   * backend can persist handles. Returns the root path or null.
   */
  restoreRoot?(): Promise<string | null>;
  listDirectory(path: string): Promise<readonly FsEntry[]>;
  readFile(path: string): Promise<Blob>;
  /** Byte size of a file at `path`, or null when it can't be stat'ed. */
  stat(path: string): Promise<number | null>;
  openArchive(path: string): Promise<ArchiveInfo>;
  cleanupArchive(tempDir: string): Promise<void>;
  /**
   * Write bytes to a path, creating parent folders as needed. Optional:
   * read-only backends (Android SAF without a persistable write grant) omit it.
   */
  writeFile?(path: string, data: Blob): Promise<void>;
  convertFileSrc?(path: string): string | null;
}

export const FILE_SYSTEM_BROWSER = new InjectionToken<FileSystemBrowser>(
  'FILE_SYSTEM_BROWSER',
);
