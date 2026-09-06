import type {
  EnhancementCapabilities,
  EnhancePageResult,
} from '../models/scan-enhancement.model';
import type { EnhancePageArgs, ScanEnhancementBackend } from './scan-enhancement-backend';

const UNAVAILABLE: EnhancementCapabilities = {
  available: false,
  backend: 'none',
  models: [],
  maxDimension: 0,
};

/**
 * Always-unavailable backend used as the lowest-priority default in browser/debug
 * builds where no native or WebGPU backend is registered.
 *
 * This is the slot the future in-browser upscaler drops into: a `WebGpuBackend`
 * using `onnxruntime-web` (WebGPU) will implement the same `ScanEnhancementBackend`
 * interface, report `isAvailable()` based on `navigator.gpu`, and run the Real-ESRGAN
 * Compact ONNX models directly in the debug web app — no native toolchain required.
 */
export class WebFallbackBackend implements ScanEnhancementBackend {
  public readonly id = 'web-fallback';

  public isAvailable(): boolean {
    return false;
  }

  public getCapabilities(): Promise<EnhancementCapabilities> {
    return Promise.resolve(UNAVAILABLE);
  }

  public enhancePage(): Promise<EnhancePageResult> {
    return Promise.reject(
      Object.assign(new Error('Enhancement requires a backend (native, desktop, or WebGPU).'), {
        kind: 'backend-unavailable',
      }),
    );
  }

  public cancelPage(): Promise<{ cancelled: boolean }> {
    return Promise.resolve({ cancelled: false });
  }
}
