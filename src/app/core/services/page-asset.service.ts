import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory } from '@capacitor/filesystem';

import type { EnhancementCacheKey } from '../models/scan-enhancement.model';

const ENHANCED_DIR = 'enhanced';

/** Where native derivatives physically live. The Android plugin maps
 *  `enhanced/<name>` to `<app cache>/enhanced/<name>`, i.e. Directory.Cache —
 *  not Directory.Documents. Reading the wrong directory made `exists()` always
 *  false, so every re-enabled book re-ran the whole enhancement queue and
 *  `enforceBudget` never evicted anything. */
const NATIVE_DIRECTORY = Directory.Cache;

/** Stable, filesystem-safe hash of an arbitrary string (FNV-1a, base36). */
export function sourceHashFor(url: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** FNV-1a hash → base36, used to turn a cache key into a safe filename. */
function filenameHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Deterministic cache-key string. Any field change invalidates the derivative. */
export function cacheKeyString(key: EnhancementCacheKey): string {
  return [
    key.bookId,
    `p${key.pageIndex}`,
    key.sourceHash,
    key.model,
    `s${key.scale}`,
    `d${key.denoise}`,
    `q${key.outputQuality}`,
    `w${key.maxOutputWidth}`,
  ].join('~');
}

/**
 * Owns the local derivative store: where enhanced pages live, how they are
 * named, and how they are cleaned up. Originals are never referenced here.
 *
 * Web builds use an in-memory map (so the queue/cache logic is unit-testable
 * without a device). On a native platform we additionally honor real files via
 * `@capacitor/filesystem` so derivatives survive process restarts and can be
 * evicted under storage pressure. The service never assumes a raw filesystem
 * path — URIs are passed through to the native bridge.
 */
@Injectable({ providedIn: 'root' })
export class PageAssetService {
  private readonly memory = new Map<string, true>();

  /** Build the destination URI for a derivative. On native this resolves to a
   *  real app-owned file; in web it is a logical identifier (never persisted).
   *
   *  Native (Capacitor/Android) derivatives are WebP: the platform encoder
   *  writes about half the bytes of a baseline JPEG at the same perceptual
   *  quality. Desktop (Tauri/ONNX) still writes PNG.
   *
   *  On Tauri/desktop (not a Capacitor native platform) we write a REAL sibling
   *  file in a `.enhanced` subfolder next to the source so the very same
   *  file→blob-URL converter used for originals (FilePageService) can serve the
   *  upscaled page to the canvas. The cache key is hashed into a safe filename
   *  because book ids contain `/` and `:`. */
  public buildDestinationUri(key: EnhancementCacheKey, sourceUrl = ''): string {
    const extension = Capacitor.isNativePlatform() ? '.webp' : '.png';
    const filename = `${filenameHash(cacheKeyString(key))}${extension}`;
    if (Capacitor.isNativePlatform()) {
      return `${ENHANCED_DIR}/${filename}`;
    }
    if (sourceUrl) {
      const slash = Math.max(sourceUrl.lastIndexOf('/'), sourceUrl.lastIndexOf('\\'));
      const dir = slash >= 0 ? sourceUrl.slice(0, slash) : '.';
      return `${dir}/.enhanced/${filename}`;
    }
    return `enhanced://${filename}`;
  }

  /** Record that a derivative exists (web memory map + best-effort native file). */
  public async markExists(uri: string): Promise<void> {
    this.memory.set(uri, true);
    if (Capacitor.isNativePlatform()) {
      // Existence is implied by a successful native write; nothing to do here.
    }
  }

  public async exists(uri: string): Promise<boolean> {
    if (this.memory.has(uri)) return true;
    if (!Capacitor.isNativePlatform()) return false;
    try {
      await Filesystem.stat({ path: await this.relativeToCache(uri), directory: NATIVE_DIRECTORY });
      return true;
    } catch {
      return false;
    }
  }

  /** Best-effort removal of a single derivative. Never throws. */
  public async delete(uri: string): Promise<void> {
    this.memory.delete(uri);
    if (!Capacitor.isNativePlatform()) return;
    try {
      await Filesystem.deleteFile({
        path: await this.relativeToCache(uri),
        directory: NATIVE_DIRECTORY,
      });
    } catch {
      // Already gone or inaccessible — ignore.
    }
  }

  /** Size of a derivative on disk, in bytes (0 when it can't be measured).
   *  The series budget is metered with these. */
  public async sizeOf(uri: string): Promise<number> {
    if (!Capacitor.isNativePlatform()) return 0;
    try {
      const stat = await Filesystem.stat({
        path: await this.relativeToCache(uri),
        directory: NATIVE_DIRECTORY,
      });
      return stat.size ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Map a derivative URI onto a path relative to the cache directory.
   *
   * The native plugin hands back an ABSOLUTE path (`/data/user/0/<pkg>/cache/
   * enhanced/x.webp`) because the reader streams it straight off disk through
   * Capacitor's file server — reading those bytes through the bridge instead
   * would base64 a multi-megabyte page into the WebView heap. The Filesystem
   * plugin, on the other hand, resolves paths RELATIVE to the requested
   * directory, so an absolute path was silently joined onto the cache dir and
   * every stat/delete failed — which is why derivatives could never be
   * removed from disk.
   */
  private async relativeToCache(uri: string): Promise<string> {
    if (!uri.startsWith('/')) return uri;
    // Every derivative lives in `<cache>/enhanced/`, so the file name after the
    // last `enhanced/` segment is the path the Filesystem plugin expects.
    const marker = `/${ENHANCED_DIR}/`;
    const at = uri.lastIndexOf(marker);
    if (at >= 0) return uri.slice(at + marker.length);
    return uri;
  }

  /**
   * Evict derivatives until at most `budgetBytes` would remain, oldest-first.
   * Returns the number of files removed. Real deletion is native-only; the web
   * map is cleared wholesale because it is not the source of truth there.
   */
  public async enforceBudget(uris: readonly string[], budgetBytes: number): Promise<number> {
    if (!Capacitor.isNativePlatform()) {
      for (const u of uris) this.memory.delete(u);
      return uris.length;
    }
    let removed = 0;
    let used = 0;
    const paths = new Map<string, string>();
    for (const uri of uris) {
      const path = await this.relativeToCache(uri);
      paths.set(uri, path);
      try {
        const stat = await Filesystem.stat({ path, directory: NATIVE_DIRECTORY });
        used += stat.size ?? 0;
      } catch {
        continue;
      }
    }
    if (used <= budgetBytes) return 0;
    for (const uri of uris) {
      if (used <= budgetBytes) break;
      const path = paths.get(uri);
      if (path === undefined) continue;
      try {
        const stat = await Filesystem.stat({ path, directory: NATIVE_DIRECTORY });
        await Filesystem.deleteFile({ path, directory: NATIVE_DIRECTORY });
        used -= stat.size ?? 0;
        removed++;
      } catch {
        // ignore
      }
    }
    return removed;
  }
}
