/**
 * Desktop/browser filesystem backend built on the File System Access API.
 *
 * Chrome/Edge expose `showDirectoryPicker()`, which hands out a
 * `FileSystemDirectoryHandle` — a live, permission-backed view of a real folder.
 * There are no absolute paths in that world, so this backend keeps the port's
 * path-shaped API by minting synthetic paths (`/<root>/<sub>/<file>`) and
 * resolving them back to handles by walking the tree from the root handle.
 *
 * The root handle is persisted in IndexedDB (handles are structured-cloneable),
 * so the library survives a reload without asking for the folder again.
 */
import type {
  ArchiveInfo,
  FileSystemBrowser,
  FsEntry,
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
}

type PickerWindow = Window & {
  showDirectoryPicker?(options?: { mode?: 'read' | 'readwrite' }): Promise<FsDirectoryHandle>;
};

/** Where the root handle is parked between sessions. */
const HANDLE_DB = 'emaki-fs-access';
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'library-root';

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

  private rootHandle: FsDirectoryHandle | null = null;

  isAvailable(): boolean {
    return typeof (window as PickerWindow).showDirectoryPicker === 'function';
  }

  /** Ask the user for a folder and remember it (handle in IndexedDB). */
  async pickDirectory(): Promise<string | null> {
    const picker = (window as PickerWindow).showDirectoryPicker;
    if (!picker) return null;
    const handle = await picker.call(window, { mode: 'readwrite' });
    this.rootHandle = handle;
    await idbSet(HANDLE_KEY, handle);
    return `/${handle.name}`;
  }

  /** Re-attach to the folder picked in a previous session, if any. */
  async restoreRoot(): Promise<string | null> {
    if (this.rootHandle) return `/${this.rootHandle.name}`;
    const handle = await idbGet<FsDirectoryHandle>(HANDLE_KEY);
    if (!handle) return null;
    const perm = await handle.queryPermission?.({ mode: 'readwrite' });
    if (perm === 'denied') return null;
    this.rootHandle = handle;
    return `/${handle.name}`;
  }

  /**
   * Resolve a synthetic path back to a handle by walking down from the root.
   * `path` is `/<root>/<a>/<b>`; the root segment is the picked folder's name.
   */
  private async resolve(path: string): Promise<FsFileHandle | FsDirectoryHandle | null> {
    if (!this.rootHandle) {
      const restored = await this.restoreRoot();
      if (!restored) return null;
    }
    const root = this.rootHandle;
    if (!root) return null;
    const segments = path.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) return null;
    if (segments[0] !== root.name) return null;

    let current: FsFileHandle | FsDirectoryHandle = root;
    for (const segment of segments.slice(1)) {
      if (current.kind !== 'directory') return null;
      try {
        current = await current.getFileHandle(segment);
      } catch {
        return null;
      }
    }
    return current;
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

  /** Walk down from the root, creating each folder on the way. */
  private async resolveDirectory(segments: readonly string[]): Promise<FsDirectoryHandle> {
    if (!this.rootHandle) {
      const restored = await this.restoreRoot();
      if (!restored) throw new Error('No library folder is open');
    }
    const root = this.rootHandle;
    if (!root) throw new Error('No library folder is open');
    if (segments.length === 0) return root;
    if (segments[0] !== root.name) {
      throw new Error('Path is outside the library root');
    }

    let current = root;
    for (const segment of segments.slice(1)) {
      current = await current.getDirectoryHandle(segment, { create: true });
    }
    return current;
  }
}
