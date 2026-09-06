import type {
  EnhancementCapabilities,
  EnhancePageResult,
  EnhancementModelId,
} from '../models/scan-enhancement.model';
import type { EnhancePageArgs, ScanEnhancementBackend } from './scan-enhancement-backend';

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Read `window.__TAURI__...invoke`, injected only when running inside Tauri.
 *  Tries the several shapes the global API has taken across Tauri versions. */
function getInvoke(): TauriInvoke | null {
  const w = window as unknown as {
    __TAURI__?: {
      core?: { invoke?: TauriInvoke };
      tauri?: { invoke?: TauriInvoke };
      invoke?: TauriInvoke;
    };
  };
  const t = w.__TAURI__;
  const found =
    t?.core?.invoke ??
    t?.tauri?.invoke ??
    t?.invoke ??
    null;
  console.log('[enhance] Tauri getInvoke →', found ? 'FOUND' : 'MISSING', '( __TAURI__ present:', !!t, ')');
  return found;
}

/**
 * Desktop backend: forwards enhancement to the Rust ONNX Runtime engine running
 * inside the Tauri host. No `@tauri-apps/api` import — we use the global injected
 * by `app.withGlobalTauri` so the web/debug build never hard-depends on Tauri.
 */
export class TauriRealEsrganBackend implements ScanEnhancementBackend {
  readonly id = 'tauri';

  isAvailable(): boolean {
    return getInvoke() !== null;
  }

  async getCapabilities(): Promise<EnhancementCapabilities> {
    const invoke = getInvoke();
    if (!invoke) {
      return { available: false, backend: 'none', models: [], maxDimension: 0 };
    }
    return invoke('get_capabilities') as Promise<EnhancementCapabilities>;
  }

  async enhancePage(args: EnhancePageArgs): Promise<EnhancePageResult> {
    const invoke = getInvoke();
    if (!invoke) {
      throw new Error('Tauri enhancement backend is not available.');
    }
    const result = await invoke('enhance_page', {
      sourceUri: args.sourceUri,
      destinationUri: args.destinationUri,
      scale: args.scale,
      model: args.model as EnhancementModelId,
      tileSize: args.tileSize,
      denoise: args.denoise,
      jobId: args.jobId,
    });
    return result as EnhancePageResult;
  }

  async cancelPage(jobId: string): Promise<{ cancelled: boolean }> {
    const invoke = getInvoke();
    if (!invoke) {
      return { cancelled: false };
    }
    return invoke('cancel_page', { jobId }) as Promise<{ cancelled: boolean }>;
  }
}
