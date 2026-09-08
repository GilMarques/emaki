import { Injectable, inject, signal } from '@angular/core';

import type { Book } from '../models/book.model';
import { FILE_SYSTEM_BROWSER } from '../native/file-system-browser.port';

/**
 * Turns a real filesystem path into a URL the reader/canvas can draw.
 *
 * Strategy: read the file bytes across the Tauri bridge and wrap them in an
 * object URL. This is reliable across environments (it does not depend on the
 * Tauri `asset://` protocol being scoped to the path). Object URLs are cached by
 * path and revoked on `revokeAll()` (book close) to free memory; extracted-
 * archive temp dirs are removed then too.
 *
 * Callers warm the cache via `preload()` (whole book) or `ensure()` (single
 * path, e.g. a cover) before rendering so the first paint already has real URLs.
 */
@Injectable({ providedIn: 'root' })
export class FilePageService {
  private readonly fs = inject(FILE_SYSTEM_BROWSER);

  private readonly blobCache = new Map<string, string>();
  private readonly tempDirs = new Set<string>();

  /** Bumped when a blob URL is added/removed so bound views can refresh. */
  private readonly _revision = signal(0);
  public readonly revision = this._revision.asReadonly();

  /** Synchronous: a displayable URL for `fsPath` (cached blob, or the raw path
   *  until `ensure()` finishes loading it). */
  public displayUrl(fsPath: string): string {
    const cached = this.blobCache.get(fsPath);
    if (cached) return cached;
    // Not yet loaded — kick off the fetch; revision bumps once it is ready so the
    // view re-renders with the real URL.
    void this.ensure(fsPath);
    return fsPath;
  }

  /** Ensure `fsPath`'s bytes are loaded into a blob URL (no-op if cached). */
  public async ensure(fsPath: string): Promise<string> {
    const cached = this.blobCache.get(fsPath);
    if (cached) return cached;
    const blob = await this.fs.readFile(fsPath);
    const url = URL.createObjectURL(blob);
    this.blobCache.set(fsPath, url);
    this._revision.update((r) => r + 1);
    return url;
  }

  /** True while `fsPath` has a live blob URL cached (i.e. is in use). */
  public isLoaded(fsPath: string): boolean {
    return this.blobCache.has(fsPath);
  }

  /** Warm the cache for a whole book (all pages). */
  public async preload(book: Book): Promise<void> {
    if (book.source.type !== 'folder') return;
    await Promise.all(
      book.pages.map((p) => this.ensure(p.url).catch(() => null)),
    );
  }

  /** Remember an extracted-archive temp dir so it is cleaned up on close. */
  public trackTempDir(dir: string): void {
    this.tempDirs.add(dir);
  }

  /** Revoke blob URLs and delete any extracted-archive temp dirs. */
  public async revokeAll(): Promise<void> {
    for (const url of this.blobCache.values()) URL.revokeObjectURL(url);
    this.blobCache.clear();
    const dirs = [...this.tempDirs];
    this.tempDirs.clear();
    for (const dir of dirs) {
      try {
        await this.fs.cleanupArchive(dir);
      } catch {
        // best-effort
      }
    }
    this._revision.update((r) => r + 1);
  }
}
