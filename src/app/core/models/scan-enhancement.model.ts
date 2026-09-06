/**
 * Types for the opt-in, fully-local scan enhancement feature.
 *
 * Enhancement never touches the original page bytes: every enhanced page is a
 * separate derivative keyed by a stable cache key (book + page + source hash +
 * model + settings). A source, model, or setting change invalidates the
 * derivative and forces regeneration.
 */

/** Model identifiers the adapter can load. The adapter stays model-agnostic:
 *  add new ids here without changing the viewer. Native weights are bundled
 *  separately and never assumed to exist at compile time. */
export type EnhancementModelId =
  | 'realesrgan-v2-anime-x2'
  | 'realesrgan-x4'
  | (string & {});

/** User-visible enhancement settings. Kept out of global {@link SettingsService}
 *  so enhancement is never an always-on, battery-heavy global preference — it
 *  starts only after an explicit reader action. */
export interface EnhancementSettings {
  /** Whether enhancement is active for the current book. */
  readonly enabled: boolean;
  /** Selected model id. */
  readonly model: EnhancementModelId;
  /** Target output scale (2 or 4). */
  readonly scale: 2 | 4;
  /** Denoise strength passed to the native model (0 = none). */
  readonly denoise: number;
  /** Output encode quality (0..100) for lossy formats. */
  readonly outputQuality: number;
}

/** Lifecycle status of a single page's enhancement. */
export type EnhancementStatus =
  | 'idle'
  | 'pending'
  | 'queued'
  | 'processing'
  | 'complete'
  | 'paused'
  | 'cancelled'
  | 'error';

/** Typed, actionable failure causes surfaced from the native bridge. */
export type EnhancementErrorKind =
  | 'unsupported-format'
  | 'insufficient-storage'
  | 'out-of-memory'
  | 'cancelled'
  | 'invalid-source'
  | 'model-unavailable'
  | 'backend-unavailable'
  | 'unknown';

export interface EnhancementError {
  readonly kind: EnhancementErrorKind;
  readonly message: string;
}

/** Per-page runtime state held in memory and mirrored to durable storage. */
export interface EnhancementPageState {
  readonly index: number;
  readonly status: EnhancementStatus;
  /** URI of the enhanced derivative, present only when `status === 'complete'`. */
  readonly enhancedUri: string | null;
  /** Source identity (url or hash) used to invalidate the derivative. */
  readonly sourceHash: string;
  /** Cache key that produced `enhancedUri`. Stale completions are rejected. */
  readonly cacheKey: string;
  readonly error: EnhancementError | null;
}

/** Stable key that uniquely identifies a derivative. Any field change must
 *  invalidate a previously produced derivative. */
export interface EnhancementCacheKey {
  readonly bookId: string;
  readonly pageIndex: number;
  readonly sourceHash: string;
  readonly model: EnhancementModelId;
  readonly scale: 2 | 4;
  readonly denoise: number;
  readonly outputQuality: number;
}

/** Backend reported by the native bridge. */
export type EnhancementBackend = 'vulkan' | 'cpu' | 'none';

/** What the device can actually do, reported once at enable time. */
export interface EnhancementCapabilities {
  readonly available: boolean;
  readonly backend: EnhancementBackend;
  /** Bundled model ids the native side can load. */
  readonly models: readonly EnhancementModelId[];
  /** Maximum pixel dimension the model accepts on a side. */
  readonly maxDimension: number;
}

/** Result returned by a successful native `enhancePage` call. */
export interface EnhancePageResult {
  readonly destinationUri: string;
  readonly width: number;
  readonly height: number;
  readonly model: EnhancementModelId;
  readonly scale: 2 | 4;
}

/** Serialized shape persisted across sessions (per book). */
export interface PersistedBookEnhancement {
  readonly bookId: string;
  readonly settings: EnhancementSettings;
  readonly pages: readonly EnhancementPageState[];
}

export const DEFAULT_ENHANCEMENT_SETTINGS: EnhancementSettings = {
  enabled: false,
  model: 'realesrgan-v2-anime-x2',
  scale: 2,
  denoise: 0,
  outputQuality: 90,
};

export function isComplete(state: EnhancementPageState | undefined): boolean {
  return state?.status === 'complete' && state.enhancedUri !== null;
}
