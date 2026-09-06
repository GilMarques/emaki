import { Injectable, inject } from '@angular/core';

import type {
  EnhancementCapabilities,
  EnhancePageResult,
} from '../models/scan-enhancement.model';
import {
  SCAN_ENHANCEMENT_BACKENDS,
  type EnhancePageArgs,
  type ForegroundState,
  type ScanEnhancementBackend,
} from './scan-enhancement-backend';
import { CapacitorRealEsrganBackend } from './capacitor-real-esrgan.backend';
import { WebFallbackBackend } from './web-fallback.backend';

export type { EnhancePageArgs } from './scan-enhancement-backend';

const DEFAULT_BACKENDS: ScanEnhancementBackend[] = [
  new CapacitorRealEsrganBackend(),
  new WebFallbackBackend(),
];

async function isAvailable(b: ScanEnhancementBackend): Promise<boolean> {
  try {
    return await b.isAvailable();
  } catch {
    return false;
  }
}

/**
 * Backend-agnostic entry point for scan enhancement. Feature code (services,
 * components) injects THIS — never a concrete backend.
 *
 * It discovers available backends: built-in defaults (Capacitor, then a web
 * fallback) plus any registered via the `SCAN_ENHANCEMENT_BACKENDS` multi-token.
 * On first use it selects the first available backend (highest priority wins),
 * caches it, and delegates `getCapabilities` / `enhancePage` / `cancelPage`.
 *
 * Adding a new runtime (e.g. Tauri desktop ONNX Runtime, or an in-browser WebGPU
 * backend) is just registering another `ScanEnhancementBackend` adapter — this
 * service and the rest of the app need no changes.
 */
@Injectable({ providedIn: 'root' })
export class RealEsrganPluginService {
  /** Selected backend id, or null until first resolution. */
  private selectedId: string | null = null;

  private readonly backends: ScanEnhancementBackend[];

  constructor() {
    const injected = inject(SCAN_ENHANCEMENT_BACKENDS, { optional: true }) ?? [];
    this.backends = mergeBackendsById(DEFAULT_BACKENDS, injected);
  }

  public async getCapabilities(): Promise<EnhancementCapabilities> {
    const backend = await this.resolve();
    if (!backend) {
      return { available: false, backend: 'none', models: [], maxDimension: 0 };
    }
    return backend.getCapabilities();
  }

  public enhancePage(args: EnhancePageArgs): Promise<EnhancePageResult> {
    return this.resolve().then((backend) => {
      if (!backend) {
        return Promise.reject(
          Object.assign(new Error('No enhancement backend available.'), {
            kind: 'backend-unavailable',
          }),
        );
      }
      return backend.enhancePage(args);
    });
  }

  public cancelPage(jobId: string): Promise<{ cancelled: boolean }> {
    return this.resolve().then((backend) =>
      backend ? backend.cancelPage(jobId) : { cancelled: false },
    );
  }

  /** Keep the app foregrounded while a batch enhances (Android only). */
  public startForeground(state: ForegroundState): Promise<void> {
    return this.resolve().then((b) => b?.startForeground?.(state));
  }

  public updateForeground(state: ForegroundState): Promise<void> {
    return this.resolve().then((b) => b?.updateForeground?.(state));
  }

  public stopForeground(): Promise<void> {
    return this.resolve().then((b) => b?.stopForeground?.());
  }

  /** Pick (and cache) the first available backend in priority order. */
  private async resolve(): Promise<ScanEnhancementBackend | null> {
    if (this.selectedId !== null) {
      const cached = this.backends.find((b) => b.id === this.selectedId);
      if (cached && (await isAvailable(cached))) return cached;
      this.selectedId = null; // became unavailable; re-select below
    }
    for (const backend of this.backends) {
      const ok = await isAvailable(backend);
      if (ok) {
        this.selectedId = backend.id;
        return backend;
      }
    }
    return null;
  }
}

/** Merge defaults with injected backends, letting injected ids override defaults. */
function mergeBackendsById(
  defaults: ScanEnhancementBackend[],
  injected: ScanEnhancementBackend[],
): ScanEnhancementBackend[] {
  const byId = new Map<string, ScanEnhancementBackend>();
  for (const b of defaults) byId.set(b.id, b);
  for (const b of injected) byId.set(b.id, b); // injected wins on id collision
  return [...byId.values()];
}
