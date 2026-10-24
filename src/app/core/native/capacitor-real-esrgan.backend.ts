import { Capacitor, registerPlugin } from '@capacitor/core';

import type {
  EnhancementCapabilities,
  EnhancePageResult,
} from '../models/scan-enhancement.model';
import type {
  EnhancePageArgs,
  ForegroundState,
  ScanEnhancementBackend,
} from './scan-enhancement-backend';

function makeError(kind: string, message: string): Error {
  const err = new Error(message);
  (err as Error & { kind?: string }).kind = kind;
  return err;
}

interface NativeRealEsrgan {
  getCapabilities(): Promise<EnhancementCapabilities>;
  enhancePage(args: EnhancePageArgs): Promise<EnhancePageResult>;
  cancelPage(args: { jobId: string }): Promise<{ cancelled: boolean }>;
  startForeground(args: ForegroundState): Promise<void>;
  updateForeground(args: ForegroundState): Promise<void>;
  stopForeground(): Promise<void>;
}

/**
 * Typed proxy for the native `RealEsrgan` plugin. Native-only plugins are not
 * exposed on `Capacitor.plugins`; `registerPlugin` is the supported way to reach
 * them (the proxy dispatches every call to the native bridge by name).
 */
const RealEsrgan = registerPlugin<NativeRealEsrgan>('RealEsrgan');

/**
 * Backend that bridges to the Capacitor native plugin `RealEsrgan` (the Android
 * ncnn implementation in `native/real-esrgan`). Available only inside a Capacitor
 * shell on a device that has the plugin registered.
 */
export class CapacitorRealEsrganBackend implements ScanEnhancementBackend {
  public readonly id = 'capacitor';

  public isAvailable(): boolean {
    return Capacitor.isNativePlatform();
  }

  public async getCapabilities(): Promise<EnhancementCapabilities> {
    try {
      const caps = await RealEsrgan.getCapabilities();
      return caps;
    } catch (err) {
      return { available: false, backend: 'none', models: [], maxDimension: 0 };
    }
  }

  public async enhancePage(args: EnhancePageArgs): Promise<EnhancePageResult> {
    const t0 = performance.now();
    try {
      const res = await RealEsrgan.enhancePage({
        ...args,
        sourceUri: toNativeSourcePath(args.sourceUri),
      });
      return res;
    } catch (err) {
      throw makeError('backend-unavailable', String((err as Error)?.message ?? err));
    }
  }

  public async cancelPage(jobId: string): Promise<{ cancelled: boolean }> {
    try {
      const res = await RealEsrgan.cancelPage({ jobId });
      return res;
    } catch (err) {
      return { cancelled: false };
    }
  }

  public async startForeground(state: ForegroundState): Promise<void> {
    await RealEsrgan.startForeground(state);
  }

  public async updateForeground(state: ForegroundState): Promise<void> {
    await RealEsrgan.updateForeground(state);
  }

  public async stopForeground(): Promise<void> {
    await RealEsrgan.stopForeground();
  }
}

/** Capacitor's local file server exposes device files under this URL prefix. */
const FILE_SERVER_MARKER = '/_capacitor_file_';

/**
 * The native engine opens the page itself (ncnn needs a real file), so a
 * WebView URL like `https://localhost/_capacitor_file_/data/.../p.jpg` has to
 * become the device path before crossing the bridge. Anything else (bare
 * paths, `file://`, `content://`) is passed through untouched.
 */
export function toNativeSourcePath(uri: string): string {
  const marker = uri.indexOf(FILE_SERVER_MARKER);
  if (marker < 0) return uri;
  const path = uri.slice(marker + FILE_SERVER_MARKER.length).split(/[?#]/)[0];
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}