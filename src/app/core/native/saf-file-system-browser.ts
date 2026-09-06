import { Capacitor, registerPlugin } from '@capacitor/core';
import { Filesystem } from '@capacitor/filesystem';

import type {
  ArchiveInfo,
  FileSystemBrowser,
  FsEntry,
} from './file-system-browser.port';

/** One entry returned by the native SAF plugin. */
interface SafEntry {
  readonly name: string;
  readonly uri: string;
  readonly mime: string;
  readonly isDirectory: boolean;
}

/** Shape of the `SafBrowser` native plugin (see native/saf-browser). */
interface SafBrowserPlugin {
  pickDirectory(): Promise<{ uri: string | null; name: string | null }>;
  listDirectory(args: { uri: string }): Promise<{ entries: SafEntry[] }>;
  stat(args: { uri: string }): Promise<{ size: number }>;
}

/**
 * Typed proxy for the native plugin. `registerPlugin` is the supported way to
 * reach a native-only plugin — native plugins are NOT placed on
 * `Capacitor.plugins` (the registry is `Capacitor.Plugins` and only holds
 * plugins that JS called `registerPlugin` for). The proxy dispatches every call
 * to the native bridge by plugin+method name.
 */
const SafBrowser = registerPlugin<SafBrowserPlugin>('SafBrowser');

const ARCHIVE_EXT = /\.(cbz|cbr|cb7|cbt|cba|zip|rar|7z)$/i;

/**
 * Android backend: SAF (Storage Access Framework) via the local
 * `@openviewer/saf-browser` plugin. Picking a folder grants a persistable read
 * (and often write) permission; the tree URI is stored as the library root and
 * survives restarts.
 *
 * Directory enumeration goes through the native plugin; page bytes are read via
 * `@capacitor/filesystem` (`content://` support, no `directory` arg) and wrapped
 * in object URLs exactly like the Tauri bridge does. Archives are out of scope
 * for mobile v1.
 */
export class SafFileSystemBrowser implements FileSystemBrowser {
  readonly id = 'saf';

  isAvailable(): boolean {
    // The plugin is a bundled native dependency of the app — on a Capacitor
    // platform it is always registered, so native platform is the gate.
    return Capacitor.isNativePlatform();
  }

  /** Opens the Android folder picker; returns the tree URI or null on cancel. */
  async pickDirectory(): Promise<string | null> {
    try {
      const result = await SafBrowser.pickDirectory();
      return result.uri;
    } catch (err) {
      throw err;
    }
  }

  async listDirectory(path: string): Promise<readonly FsEntry[]> {
    const { entries } = await SafBrowser.listDirectory({ uri: path });
    return entries.map(toFsEntry);
  }

  async readFile(path: string): Promise<Blob> {
    // Originals are content:// (SAF); enhanced derivatives are absolute
    // app-cache paths. Filesystem requires file:// (or content://) when
    // `directory` is omitted, so normalize bare absolute paths.
    const fsPath =
      path.startsWith('content://') || path.startsWith('file://') ? path : `file://${path}`;
    const { data } = await Filesystem.readFile({ path: fsPath });
    // Native returns base64; web returns a Blob directly.
    return typeof data === 'string' ? new Blob([base64ToBytes(data)]) : data;
  }

  async stat(path: string): Promise<number | null> {
    try {
      const { size } = await SafBrowser.stat({ uri: path });
      return size;
    } catch (err) {
      console.warn('[saf] stat() failed for', path, err);
      return null;
    }
  }

  openArchive(_path: string): Promise<ArchiveInfo> {
    return Promise.reject(new Error('Archives are not supported on mobile yet'));
  }

  async cleanupArchive(_tempDir: string): Promise<void> {
    // no extracted archives on mobile — nothing to clean up
  }
}

function isImageMime(mime: string): boolean {
  return mime.startsWith('image/');
}

/** Classify an entry into the port's `kind` vocabulary. */
function kindFor(name: string, mime: string): FsEntry['kind'] {
  if (isImageMime(mime)) return 'image';
  if (ARCHIVE_EXT.test(name)) return 'archive';
  return 'other';
}

/** Convert a native SAF entry into a port `FsEntry`. Mirror Tauri: only archive
 *  files (and folders that contain images — computed by the scanner, not here)
 *  are `isBook`; a bare image file is a page, not a book. */
export function toFsEntry(e: SafEntry): FsEntry {
  return {
    name: e.name,
    path: e.uri,
    kind: e.isDirectory ? 'dir' : kindFor(e.name, e.mime),
    isBook: !e.isDirectory && kindFor(e.name, e.mime) === 'archive',
  };
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}