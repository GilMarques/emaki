import { Injectable, inject, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';

import type { Book } from '../models/book.model';
import { DownloadStore } from '../native/download-store';
import { FILE_SYSTEM_BROWSER } from '../native/file-system-browser.port';

/**
 * Turns a real filesystem path into a URL the reader/canvas can draw.
 *
 * On native, device files are served by Capacitor's local file server
 * (`convertFileSrc`) so the WebView streams them from disk — reading whole
 * pages through the bridge produces base64 strings that exhaust the JS heap on
 * large (enhanced) pages. Everything else (SAF `content://`, desktop) falls back
 * to reading the bytes and wrapping them in an object URL, cached by path and
 * revoked on `revokeAll()` (book close); extracted-archive temp dirs are
 * removed then too.
 *
 * Callers warm the cache via `preload()` (whole book) or `ensure()` (single
 * path, e.g. a cover) before rendering so the first paint already has real URLs.
 */
@Injectable({ providedIn: 'root' })
export class FilePageService {
  private readonly fs = inject(FILE_SYSTEM_BROWSER);
  private readonly downloads = inject(DownloadStore);
  private readonly native = Capacitor.isNativePlatform();

  private readonly blobCache = new Map<string, string>();
  private readonly tempDirs = new Set<string>();

  /** Bumped when a blob URL is added/removed so bound views can refresh. */
  private readonly _revision = signal(0);
  public readonly revision = this._revision.asReadonly();

  /** Synchronous: a displayable URL for `fsPath` (cached blob, or the raw path
   *  until `ensure()` finishes loading it). */
  public displayUrl(fsPath: string): string {
    // Already loadable by the WebView: http(s) (incl. Capacitor's file server)
    // or blob/data URLs. Downloaded pages arrive in this form.
    if (isLoadableUrl(fsPath)) return fsPath;
    // Device files are served by Capacitor's local file server. Streaming them
    // from disk keeps the WebView's decoder in charge of memory; reading whole
    // pages through the bridge (base64) OOMs on enhanced pages, which are 4×
    // the pixels of the original.
    if (this.canStreamFromDisk(fsPath)) return Capacitor.convertFileSrc(fsPath);
    const cached = this.blobCache.get(fsPath);
    if (cached) return cached;
    // Not yet loaded — kick off the fetch; revision bumps once it is ready so the
    // view re-renders with the real URL.
    void this.ensure(fsPath);
    return fsPath;
  }

  /**
   * True when `url` has to be passed through `displayUrl()` before rendering:
   * real filesystem paths (SAF `content://`, File System Access handles) and
   * app-private download storage. Plain asset paths (`assets/…`) are already
   * loadable by the browser, so they return false.
   */
  public needsResolve(url: string): boolean {
    return !isLoadableUrl(url) && !url.startsWith('assets/');
  }

  /** Ensure `fsPath`'s bytes are loaded into a blob URL (no-op if cached). */
  public async ensure(fsPath: string): Promise<string> {
    if (isLoadableUrl(fsPath)) return fsPath;
    if (this.canStreamFromDisk(fsPath)) return Capacitor.convertFileSrc(fsPath);
    const cached = this.blobCache.get(fsPath);
    if (cached) return cached;
    // Downloaded chapters live in the filesystem plugin's store on web (there
    // is no file server to stream them from) and in the SAF root otherwise.
    const blob = this.downloads.ownsPath(fsPath)
      ? await this.downloads.readFile(fsPath)
      : await this.fs.readFile(fsPath);
    const url = URL.createObjectURL(blob);
    this.blobCache.set(fsPath, url);
    this._revision.update((r) => r + 1);
    return url;
  }

  /** True when the WebView can fetch this device path/URI through Capacitor. */
  private canStreamFromDisk(path: string): boolean {
    if (!this.native) return false;
    // content:// (SAF) isn't mapped by convertFileSrc and still needs a read.
    return path.startsWith('/') || path.startsWith('file://');
  }

  /** True while `fsPath` has a live blob URL cached (i.e. is in use). */
  public isLoaded(fsPath: string): boolean {
    return this.blobCache.has(fsPath);
  }

  /** Warm the cache for a whole book (all pages). */
  public async preload(book: Book): Promise<void> {
    if (book.source.type !== 'folder') return;
    // Only pages that need a bridge read (SAF content://) are warmed. Device
    // paths and http(s) URLs are streamed by the WebView, so they need nothing.
    // Read a few at a time: a full chapter of base64 strings at once is what
    // used to exhaust the heap on big pages.
    const pending = book.pages
      .map((p) => p.url)
      .filter((url) => !isLoadableUrl(url) && !this.canStreamFromDisk(url));
    const BATCH = 3;
    for (let i = 0; i < pending.length; i += BATCH) {
      await Promise.all(
        pending.slice(i, i + BATCH).map((url) => this.ensure(url).catch(() => null)),
      );
    }
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

/** URL schemes the WebView loads itself, no bridge read required. */
function isLoadableUrl(value: string): boolean {
  return /^(https?:|blob:|data:|capacitor:)/i.test(value);
}
