import { InjectionToken } from '@angular/core';

import type {
  EnhancementCapabilities,
  EnhancePageResult,
  EnhancementModelId,
} from '../models/scan-enhancement.model';

/** Arguments for a single native enhancement call. URIs are the bridge:
 *  the backend resolves a content/SAF/asset URI to a path before processing. */
export interface EnhancePageArgs {
  readonly sourceUri: string;
  readonly destinationUri: string;
  readonly scale: 2 | 4;
  readonly model: EnhancementModelId;
  readonly tileSize: number;
  readonly denoise: number;
  /** Opaque id so the caller can cancel an in-flight job. */
  readonly jobId: string;
}

/** Progress snapshot for the optional foreground notification. */
export interface ForegroundState {
  readonly done: number;
  readonly total: number;
}

/**
 * Backend-agnostic contract for on-device (or in-browser) scan enhancement.
 *
 * Every concrete backend — Android/ncnn (Capacitor), desktop ONNX Runtime
 * (Tauri), or an in-browser WebGPU backend (onnxruntime-web) — implements this
 * same interface. The Angular service depends ONLY on this interface, never
 * on a specific runtime, so a new backend is added by registering an adapter,
 * not by editing the service.
 */
export interface ScanEnhancementBackend {
  /** Stable id, e.g. `'capacitor'`, `'tauri'`, `'webgpu'`. */
  readonly id: string;
  /** Cheap check for whether this backend can run in the current environment. */
  isAvailable(): boolean | Promise<boolean>;
  getCapabilities(): Promise<EnhancementCapabilities>;
  enhancePage(args: EnhancePageArgs): Promise<EnhancePageResult>;
  cancelPage(jobId: string): Promise<{ cancelled: boolean }>;
  /**
   * Optional: keep the app foregrounded (notification + wake lock) while a
   * batch is enhancing, so screen-off / Doze doesn't stall the queue. Only
   * Android backends implement these; the service calls them defensively.
   */
  startForeground?(state: ForegroundState): Promise<void>;
  updateForeground?(state: ForegroundState): Promise<void>;
  stopForeground?(): Promise<void>;
}

/**
 * Multi-provider token for registering enhancement backends. Register an adapter
 * with `{ provide: SCAN_ENHANCEMENT_BACKENDS, useClass: MyBackend, multi: true }`
 * in `main.ts` (or an NgModule). If nothing is registered, the service falls
 * back to its built-in defaults (Capacitor + a web fallback). Registered
 * backends take precedence and are de-duplicated by `id`.
 */
export const SCAN_ENHANCEMENT_BACKENDS = new InjectionToken<ScanEnhancementBackend[]>(
  'SCAN_ENHANCEMENT_BACKENDS',
);
