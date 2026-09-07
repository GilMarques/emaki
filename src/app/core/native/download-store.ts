/**
 * Manages where downloaded chapters live on disk and their persisted manifest.
 *
 * Layout (under app data dir `Directory.Data/emaki`):
 *   emaki/<providerId>/<chapterId>/000.jpg, 001.jpg, ...
 *
 * The manifest is a small JSON index keyed by `providerId:chapterId` → list of
 * saved file names. It is what lets the app rehydrate which chapters are
 * available after a restart.
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
 * On-disk storage for downloaded chapters. Uses `@capacitor/filesystem`
 * (Directory.Data) on native; on web it falls back to localStorage so
 * `ionic serve` still behaves.
 */
@Injectable({ providedIn: 'root' })
export class DownloadStore {
  private readonly native = Capacitor.isNativePlatform();
  private readonly _chapters = signal<ReadonlyMap<string, StoredChapter>>(new Map());

  public readonly chapters = this._chapters.asReadonly();

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

  public get(providerId: string, chapterId: string): StoredChapter | undefined {
    return this._chapters().get(`${providerId}:${chapterId}`);
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
    if (this.native) {
      try {
        await Filesystem.rmdir({
          path: this.chapterDir(providerId, chapterId),
          directory: Directory.Data,
          recursive: true,
        });
      } catch {
        // ignore missing dir
      }
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
    }
    this._chapters.set(this.loadManifest());
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