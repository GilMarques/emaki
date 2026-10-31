/**
 * Manages where downloaded chapters live on disk and their persisted manifest.
 *
 * Layout (under app data dir `Directory.Data/emaki`):
 *   emaki/<providerId>/<chapterId>/000.jpg, 001.jpg, ...
 *
 * The manifest is a small JSON index keyed by `providerId:chapterId` → list of
 * saved file names. It is what lets the app rehydrate which chapters are
 * available after a restart.
 *
 * On web the same paths go through `@capacitor/filesystem`'s IndexedDB-backed
 * implementation, so a downloaded chapter survives a reload there too.
 */
import { Injectable, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Directory, Filesystem } from '@capacitor/filesystem';

export interface StoredChapter {
  readonly providerId: string;
  readonly chapterId: string;
  /** Series (manga) title the chapter belongs to, used to group downloads. */
  readonly mangaTitle: string;
  /** Human chapter title. */
  readonly title: string;
  /** File names (e.g. `000.jpg`) saved under the chapter directory. */
  readonly files: readonly string[];
}

const BASE_DIR = 'emaki';
const STORAGE_KEY = 'emaki:downloads:v1';

/**
 * Root of the app's private page storage on every platform. Downloads and
 * enhanced derivatives share it: both are page files that the reader resolves
 * through the filesystem layer, and on web that layer is IndexedDB.
 */
export const APP_STORAGE_DIR = BASE_DIR;

/**
 * On-disk storage for downloaded chapters. Uses `@capacitor/filesystem`
 * (Directory.Data) on native; on web it falls back to localStorage so
 * `ionic serve` still behaves.
 */
@Injectable({ providedIn: 'root' })
export class DownloadStore {
  private readonly native = Capacitor.isNativePlatform();
  private readonly _chapters = signal<ReadonlyMap<string, StoredChapter>>(new Map());
  /**
   * Absolute on-device data directory (e.g. `/data/user/0/<pkg>/files`),
   * resolved once at startup. Needed because `Capacitor.convertFileSrc` only
   * maps absolute paths / `file://` URIs to a loadable URL — a store-relative
   * path is returned unchanged and 404s in the WebView.
   */
  private readonly _dataDir = signal<string | null>(null);

  public readonly chapters = this._chapters.asReadonly();
  public readonly dataDir = this._dataDir.asReadonly();

  constructor() {
    void this.init();
  }

  /** Chapter directory path relative to the base dir. */
  public chapterDir(providerId: string, chapterId: string): string {
    return `${BASE_DIR}/${providerId}/${chapterId}`;
  }

  /** Absolute path for a named page file under the chapter dir. */
  public filePath(providerId: string, chapterId: string, fileName: string): string {
    return `${this.chapterDir(providerId, chapterId)}/${fileName}`;
  }

  /** Absolute destination path for a page file under the chapter dir. */
  public pagePath(providerId: string, chapterId: string, index: number): string {
    return this.filePath(providerId, chapterId, `${String(index).padStart(3, '0')}.jpg`);
  }

  /** Alias: the path handed to the native downloader for a page. */
  public downloadDestination(providerId: string, chapterId: string, index: number): string {
    return this.pagePath(providerId, chapterId, index);
  }

  /**
   * Absolute on-device path for a store-relative path (e.g. `emaki/...`),
   * or null until the data directory has resolved on startup.
   */
  public absolutePath(relative: string): string | null {
    const base = this._dataDir();
    return base === null ? null : `${base}/${relative}`;
  }

  public get(providerId: string, chapterId: string): StoredChapter | undefined {
    return this._chapters().get(`${providerId}:${chapterId}`);
  }

  /** True when `path` is one of ours (`emaki/<provider>/<chapter>/<file>`). */
  public ownsPath(path: string): boolean {
    return path.startsWith(`${BASE_DIR}/`);
  }

  /**
   * Read a stored page back as a Blob.
   *
   * Native reads through the WebView's file server instead (see
   * `FilePageService.canStreamFromDisk`); this is the web path, where
   * `@capacitor/filesystem` keeps the bytes in IndexedDB and there is no
   * server to stream from.
   */
  public async readFile(path: string): Promise<Blob> {
    const { data } = await Filesystem.readFile({ path, directory: Directory.Data });
    return typeof data === 'string' ? base64ToBlob(data, mimeFor(path)) : data;
  }

  /** Record a finished chapter (all its files saved). */
  public async saveChapter(
    providerId: string,
    chapterId: string,
    mangaTitle: string,
    title: string,
    files: readonly string[],
  ): Promise<void> {
    const key = `${providerId}:${chapterId}`;
    this._chapters.update((m) =>
      new Map(m).set(key, { providerId, chapterId, mangaTitle, title, files }),
    );
    await this.persist();
  }

  public async remove(providerId: string, chapterId: string): Promise<void> {
    const key = `${providerId}:${chapterId}`;
    const next = new Map(this._chapters());
    next.delete(key);
    this._chapters.set(next);
    try {
      await Filesystem.rmdir({
        path: this.chapterDir(providerId, chapterId),
        directory: Directory.Data,
        recursive: true,
      });
    } catch {
      // ignore missing dir
    }
    await this.persist();
  }

  // ─────────────────────────────── Internals ───────────────────────────────

  private async init(): Promise<void> {
    if (this.native) {
      try {
        await Filesystem.mkdir({ path: BASE_DIR, directory: Directory.Data, recursive: true });
      } catch {
        // already exists
      }
      // Resolve the absolute data dir so page/cover URLs can be built with
      // Capacitor.convertFileSrc (which needs an absolute path on native).
      try {
        const { uri } = await Filesystem.getUri({ path: BASE_DIR, directory: Directory.Data });
        this._dataDir.set(uri.replace(/^file:\/\//, '').replace(/\/emaki\/?$/, ''));
      } catch {
        // leave null — page URLs fall back to relative paths
      }
    }
    let chapters = this.loadManifest();
    if (!this.native) chapters = await this.pruneMissingFiles(chapters);
    this._chapters.set(chapters);
  }

  /**
   * Drop manifest entries whose files aren't in the browser store.
   *
   * The web build used to record downloads without keeping the bytes, so a
   * manifest could point at files that never existed — those chapters then
   * 404'd on every cover and page. Checking the first file is enough: a
   * chapter is written page by page.
   */
  private async pruneMissingFiles(
    chapters: ReadonlyMap<string, StoredChapter>,
  ): Promise<ReadonlyMap<string, StoredChapter>> {
    const kept = new Map(chapters);
    let dropped = false;
    for (const [key, chapter] of chapters) {
      const first = chapter.files[0];
      if (first === undefined) {
        kept.delete(key);
        dropped = true;
        continue;
      }
      try {
        await Filesystem.stat({
          path: this.filePath(chapter.providerId, chapter.chapterId, first),
          directory: Directory.Data,
        });
      } catch {
        kept.delete(key);
        dropped = true;
      }
    }
    if (dropped) {
      this._chapters.set(kept);
      await this.persist();
    }
    return kept;
  }

  private loadManifest(): ReadonlyMap<string, StoredChapter> {
    if (typeof localStorage === 'undefined') return new Map();
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return new Map();
      const parsed = JSON.parse(raw) as { chapters?: StoredChapter[] };
      const map = new Map<string, StoredChapter>();
      for (const c of parsed.chapters ?? []) {
        map.set(`${c.providerId}:${c.chapterId}`, c);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  private async persist(): Promise<void> {
    const payload = JSON.stringify({ chapters: [...this._chapters().values()] });
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY, payload);
      } catch {
        // private mode — session only
      }
    }
    if (this.native) {
      try {
        await Filesystem.writeFile({
          path: `${BASE_DIR}/manifest.json`,
          data: payload,
          directory: Directory.Data,
        });
      } catch {
        // ignore
      }
    }
  }
}

/** MIME type from a stored page's file name. */
function mimeFor(path: string): string {
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.webp')) return 'image/webp';
  if (path.endsWith('.gif')) return 'image/gif';
  if (path.endsWith('.bmp')) return 'image/bmp';
  return 'image/jpeg';
}

/** Decode a base64 payload (native reads, and older web stores) into a Blob. */
function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}