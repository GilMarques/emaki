import { Injectable, signal } from '@angular/core';

const SERIES_KEY = 'openviewer:library-series';
const LEGACY_ROOT_KEY = 'openviewer:library-root';

/** A folder the user added. The library is this list, not one parent path. */
export interface LibrarySeries {
  /** Filesystem path or SAF tree URI. Stable for the life of the grant. */
  readonly path: string;
  /** Folder name shown on the shelf. */
  readonly name: string;
}

/**
 * The series the user has added by picking folders.
 *
 * A content URI left by the old single-root library is adopted on load.
 * A desktop handle is adopted by the filesystem backend, which still owns it.
 */
@Injectable({ providedIn: 'root' })
export class LibrarySeriesService {
  private readonly _series = signal<readonly LibrarySeries[]>(this.load());
  public readonly series = this._series.asReadonly();

  /** Append a folder. Picking the same path twice leaves the list unchanged. */
  public add(series: LibrarySeries): void {
    if (this._series().some((entry) => entry.path === series.path)) return;
    this._series.update((list) => [...list, series]);
    this.save();
  }

  /** Drop a folder from the library. The files on disk stay where they are. */
  public remove(path: string): void {
    this._series.update((list) => list.filter((entry) => entry.path !== path));
    this.save();
  }

  /** Forget the pre-series library path once its folder has been adopted. */
  public clearLegacyPath(): void {
    try {
      localStorage.removeItem(LEGACY_ROOT_KEY);
    } catch {
      // ignore
    }
  }

  private load(): readonly LibrarySeries[] {
    const stored = this.read();
    if (stored.length > 0) return stored;
    const legacy = this.legacyContentUri();
    if (legacy === null) return [];
    const adopted = [{ path: legacy, name: contentDisplayName(legacy) }];
    this.persist(adopted);
    this.clearLegacyPath();
    return adopted;
  }

  private read(): readonly LibrarySeries[] {
    try {
      const raw = localStorage.getItem(SERIES_KEY);
      if (raw === null) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isSeries);
    } catch {
      return [];
    }
  }

  private legacyContentUri(): string | null {
    try {
      const path = localStorage.getItem(LEGACY_ROOT_KEY);
      return path !== null && path.startsWith('content://') ? path : null;
    } catch {
      return null;
    }
  }

  private save(): void {
    this.persist(this._series());
  }

  private persist(series: readonly LibrarySeries[]): void {
    try {
      localStorage.setItem(SERIES_KEY, JSON.stringify(series));
    } catch {
      // persistence is best-effort
    }
  }
}

function isSeries(value: unknown): value is LibrarySeries {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as { path?: unknown; name?: unknown };
  return typeof entry.path === 'string' && entry.path.length > 0 && typeof entry.name === 'string' && entry.name.length > 0;
}

/** Last segment of a SAF tree URI, without the storage-volume prefix. */
function contentDisplayName(path: string): string {
  const idx = path.lastIndexOf('/');
  const raw = idx < 0 ? path : path.slice(idx + 1);
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // not valid percent-encoding — keep raw
  }
  const colon = decoded.indexOf(':');
  const name = colon > 0 ? decoded.slice(colon + 1) : decoded;
  return name.length > 0 ? name : 'Series';
}
