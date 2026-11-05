/**
 * Desktop/browser filesystem backend built on the File System Access API.
 *
 * Chrome/Edge expose `showDirectoryPicker()`, which hands out a
 * `FileSystemDirectoryHandle` — a live, permission-backed view of a real folder.
 * There are no absolute paths in that world, so this backend keeps the port's
 * path-shaped API by minting synthetic paths (`/<series id>/<sub>/<file>`) and
 * resolving them back to handles by walking from that series' handle.
 *
 * Each series handle is persisted in IndexedDB (handles are structured-cloneable),
 * so added folders survive a reload without asking again.
 */
import type {
  ArchiveInfo,
  FileSystemBrowser,
  FsEntry,
  PickedDirectory,
} from './file-system-browser.port';

const ARCHIVE_EXT = /\.(cbz|cbr|cb7|cbt|cba|zip|rar|7z)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif|heic)$/i;

/** Minimal shape of the File System Access API (not in the TS lib yet). */
interface FsFileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<{
    write(data: Blob | BufferSource | string): Promise<void>;
    close(): Promise<void>;
  }>;
}

interface FsDirectoryHandle {
  readonly kind: 'directory';
  readonly name: string;
  values(): AsyncIterableIterator<FsFileHandle | FsDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsFileHandle>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FsDirectoryHandle>;
  queryPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  isSameEntry?(other: FsDirectoryHandle): Promise<boolean>;
}

type PickerWindow = Window & {
  showDirectoryPicker?(options?: { mode?: 'read' | 'readwrite' }): Promise<FsDirectoryHandle>;
};

/** Where series handles are parked between sessions. */
const HANDLE_DB = 'emaki-fs-access';
const HANDLE_STORE = 'handles';
/** The single folder remembered before the library became a list of series. */
const LEGACY_HANDLE_KEY = 'library-root';
const SERIES_HANDLE_PREFIX = 'series:';

/**
 * How long a real dismissal takes, at minimum.
 *
 * A picker the user actually saw and closed takes a moment; a dialog that
 * never opened rejects immediately. The distinction is the only way to tell
 * "cancelled" from "this window is not allowed to show it".
 */
const CANCEL_MS = 250;

function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(HANDLE_STORE)) {
        req.result.createObjectStore(HANDLE_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  try {
    const db = await openHandleDb();
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly');
      const req = tx.objectStore(HANDLE_STORE).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
}

async function idbSet(key: string, value: unknown): Promise<void> {
  try {
    const db = await openHandleDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      tx.objectStore(HANDLE_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Private mode / no IndexedDB: the handle simply won't survive a reload.
  }
}

async function idbDelete(key: string): Promise<void> {
  try {
    const db = await openHandleDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      tx.objectStore(HANDLE_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // ignore
  }
}

async function idbKeys(): Promise<readonly string[]> {
  try {
    const db = await openHandleDb();
    return await new Promise<readonly string[]>((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly');
      const req = tx.objectStore(HANDLE_STORE).getAllKeys();
      req.onsuccess = () => resolve(req.result.map((key) => String(key)));
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

function kindFor(name: string): FsEntry['kind'] {
  if (IMAGE_EXT.test(name)) return 'image';
  if (ARCHIVE_EXT.test(name)) return 'archive';
  return 'other';
}

/**
 * Browser filesystem backend. `isAvailable()` is true in Chrome/Edge (and any
 * Chromium with the File System Access API); everywhere else the shelf keeps
 * using the preset library.
 */
export class FileSystemAccessBrowser implements FileSystemBrowser {
  readonly id = 'fs-access';

  /** Series id → the folder handle the user granted. */
  private readonly roots = new Map<string, FsDirectoryHandle>();

  isAvailable(): boolean {
    return typeof (window as PickerWindow).showDirectoryPicker === 'function';
  }

  /** Ask the user for a series folder and remember its handle. */
  async pickDirectory(): Promise<PickedDirectory | null> {
    const picker = (window as PickerWindow).showDirectoryPicker;
    if (!picker) return null;
    // A cross-origin frame cannot open the picker at all, and some of them
    // report that as a dismissal — which would look like nothing happening.
    if (isEmbedded()) throw pickerFailure(new DOMException('Embedded', 'SecurityError'));

    const started = Date.now();
    let handle: FsDirectoryHandle;
    try {
      handle = await picker.call(window, { mode: 'readwrite' });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        // A dialog a person actually saw takes at least a moment to dismiss.
        // An instant rejection means it never opened, so say why instead of
        // leaving the tap with no visible effect.
        if (Date.now() - started < CANCEL_MS) {
          throw pickerFailure(new DOMException('Never opened', 'SecurityError'));
        }
        return null;
      }
      throw pickerFailure(error);
    }

    const existing = await this.matchExisting(handle);
    if (existing !== null) return existing;

    const id = crypto.randomUUID();
    this.roots.set(id, handle);
    await idbSet(seriesKey(id), handle);
    return { path: `/${id}`, name: handle.name };
  }

  /**
   * Turn the old single library folder into one series, once.
   * The handle moves to a series key so later picks can tell it apart.
   */
  async importLegacyRoot(): Promise<PickedDirectory | null> {
    const handle = await idbGet<FsDirectoryHandle>(LEGACY_HANDLE_KEY);
    if (!handle) return null;
    const perm = await handle.queryPermission?.({ mode: 'readwrite' });
    if (perm === 'denied') return null;
    const existing = await this.matchExisting(handle);
    await idbDelete(LEGACY_HANDLE_KEY);
    if (existing !== null) return existing;
    const id = crypto.randomUUID();
    this.roots.set(id, handle);
    await idbSet(seriesKey(id), handle);
    return { path: `/${id}`, name: handle.name };
  }

  /** Reuse the id of a folder the user already added. */
  private async matchExisting(handle: FsDirectoryHandle): Promise<PickedDirectory | null> {
    for (const [id, known] of this.roots) {
      if (await known.isSameEntry?.(handle)) return { path: `/${id}`, name: known.name };
    }
    for (const key of await idbKeys()) {
      if (!key.startsWith(SERIES_HANDLE_PREFIX)) continue;
      const stored = await idbGet<FsDirectoryHandle>(key);
      if (!stored || !(await stored.isSameEntry?.(handle))) continue;
      const id = key.slice(SERIES_HANDLE_PREFIX.length);
      this.roots.set(id, stored);
      return { path: `/${id}`, name: stored.name };
    }
    return null;
  }

  /**
   * Resolve a synthetic path back to a handle by walking down from its series.
   * `path` is `/<series id>/<a>/<b>`.
   */
  private async resolve(path: string): Promise<FsFileHandle | FsDirectoryHandle | null> {
    const segments = path.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) return null;
    const root = await this.rootHandleFor(segments[0]);
    if (!root) return null;

    let current: FsFileHandle | FsDirectoryHandle = root;
    for (const segment of segments.slice(1)) {
      if (current.kind !== 'directory') return null;
      const directory: FsDirectoryHandle = current;
      try {
        current = await directory.getDirectoryHandle(segment);
      } catch {
        try {
          current = await directory.getFileHandle(segment);
        } catch {
          return null;
        }
      }
    }
    return current;
  }

  private async rootHandleFor(id: string): Promise<FsDirectoryHandle | null> {
    const cached = this.roots.get(id);
    if (cached) return cached;
    const stored = await idbGet<FsDirectoryHandle>(seriesKey(id));
    if (!stored) return null;
    const perm = await stored.queryPermission?.({ mode: 'readwrite' });
    if (perm === 'denied') return null;
    this.roots.set(id, stored);
    return stored;
  }

  async listDirectory(path: string): Promise<readonly FsEntry[]> {
    const handle = await this.resolve(path);
    if (!handle || handle.kind !== 'directory') return [];
    const entries: FsEntry[] = [];
    for await (const child of handle.values()) {
      const childPath = `${path.replace(/\/+$/, '')}/${child.name}`;
      entries.push({
        name: child.name,
        path: childPath,
        kind: child.kind === 'directory' ? 'dir' : kindFor(child.name),
        isBook: child.kind === 'file' && ARCHIVE_EXT.test(child.name),
      });
    }
    return entries;
  }

  async readFile(path: string): Promise<Blob> {
    const handle = await this.resolve(path);
    if (!handle || handle.kind !== 'file') throw new Error(`Not a file: ${path}`);
    return handle.getFile();
  }

  async stat(path: string): Promise<number | null> {
    try {
      const handle = await this.resolve(path);
      if (!handle || handle.kind !== 'file') return null;
      return (await handle.getFile()).size;
    } catch {
      return null;
    }
  }

  openArchive(_path: string): Promise<ArchiveInfo> {
    return Promise.reject(new Error('Archives are not supported in the browser build'));
  }

  async cleanupArchive(_tempDir: string): Promise<void> {
    // nothing to clean up: archives never get extracted here
  }

  /**
   * Write a file, creating the parent folders on the way. This is how the
   * desktop writes enhanced pages next to their source (`.enhanced/`), which
   * is also what the device-sync feature ships to the phone.
   */
  async writeFile(path: string, data: Blob): Promise<void> {
    const segments = path.split('/').filter((s) => s.length > 0);
    const fileName = segments.pop();
    if (!fileName) throw new Error(`Not a file path: ${path}`);
    const dir = await this.resolveDirectory(segments);
    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(data);
    } finally {
      await writable.close();
    }
  }

  /** Walk down from the series folder, creating each folder on the way. */
  private async resolveDirectory(segments: readonly string[]): Promise<FsDirectoryHandle> {
    if (segments.length === 0) throw new Error('No series folder is open');
    const root = await this.rootHandleFor(segments[0]);
    if (!root) throw new Error('No series folder is open');

    let current = root;
    for (const segment of segments.slice(1)) {
      current = await current.getDirectoryHandle(segment, { create: true });
    }
    return current;
  }
}

function seriesKey(id: string): string {
  return `${SERIES_HANDLE_PREFIX}${id}`;
}

/**
 * True inside a cross-origin frame.
 *
 * Such a frame is not allowed to open a directory picker, but the refusal is
 * not reliable to detect after the fact — one webview reports it as the user
 * dismissing the dialog — so it is checked up front.
 */
function isEmbedded(): boolean {
  try {
    if (window.self === window.top) return false;
    // Reading across the boundary throws only when the parent is another origin.
    return window.top?.document === undefined;
  } catch {
    return true;
  }
}

/**
 * Turn a picker rejection into something worth showing.
 *
 * Chrome refuses `showDirectoryPicker` in a cross-origin frame and in some
 * embedded webviews; the browser's own message says nothing useful about why,
 * so the fix is spelled out: the app is fine, the window is not.
 */
function pickerFailure(error: unknown): Error {
  if (error instanceof DOMException && error.name === 'SecurityError') {
    return new Error(
      'This window is not allowed to open a folder picker. Open Emaki in a Chrome or Edge tab to choose a series folder.',
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}
