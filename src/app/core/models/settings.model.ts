/**
 * Display + Filters settings shape.
 *
 * Single source of truth — both the Viewer's Quick Actions modal and the
 * Preferences page read from / write to this. Keep enums flat and small;
 * discriminated unions only when a setting has genuinely different shapes.
 *
 * When a setting gets a "per-book" override later, swap `ReadingDirection`
 * from a plain alias to a `{ global, perBook? }` discriminated union.
 * Don't preempt — the issue scope locks it as global-only for v1.
 */

export type ReadingDirection = 'ltr' | 'rtl';

export type ScreenOrientation =
  | 'auto'
  | 'portrait'
  | 'landscape'
  | 'portrait-inverted'
  | 'landscape-inverted';

export type PageLayout = 'auto' | 'single' | 'dual';

/**
 * Accept the current values and the names this control used to store.
 * `default` and `auto-switch` were the unimplemented "pick for me" entries.
 */
export function normalizePageLayout(value: unknown): PageLayout | null {
  switch (value) {
    case 'auto':
    case 'auto-switch':
    case 'default':
      return 'auto';
    case 'single':
    case 'auto-single':
      return 'single';
    case 'dual':
    case 'auto-dual':
      return 'dual';
    default:
      return null;
  }
}

export type InterfaceTheme = 'auto' | 'light' | 'dark';

export type ViewerMode = 'paged' | 'vertical-scroll' | 'horizontal-scroll';

export type PageTransition = 'page-curl' | 'slide-horizontal' | 'slide-vertical';

/** Page mode curls, vertical scroll slides up and down, horizontal scroll slides sideways. */
export function transitionForMode(mode: ViewerMode): PageTransition {
  switch (mode) {
    case 'vertical-scroll':
      return 'slide-vertical';
    case 'horizontal-scroll':
      return 'slide-horizontal';
    case 'paged':
      return 'page-curl';
  }
}

/** How the page image is sized to the viewport. Persisted across sessions. */
export type ZoomMode = 'fit-screen' | 'fit-width' | 'fit-height';

/** Old zoom values that are no longer offered. They load as fit to screen. */
export function normalizeZoom(value: unknown): ZoomMode | null {
  switch (value) {
    case 'fit-screen':
    case 'fit-width':
    case 'fit-height':
      return value;
    case 'actual-size':
    case 'fixed-size':
    case 'stretch-to-fill':
    case 'cover':
      return 'fit-screen';
    default:
      return null;
  }
}

/**
 * Sampling method for image upscaling/downscaling.
 *
 * Only the two methods CSS can actually express are offered: 'none' (the
 * browser's own resampling) and 'nearest-neighbor' (`image-rendering:
 * pixelated`, useful for pixel art and hi-res scans). Averaging / bilinear /
 * bicubic / lanczos3 were listed here but rendered identically to 'none',
 * because `image-rendering` has no kernel selector — only pixelated vs
 * smooth. They can come back as a real choice once the reader draws through
 * a canvas/WebGL resampler (Mitchell-Netravali as the default, Lanczos3 as an
 * explicit "sharp" option, since Lanczos rings around hard black lines).
 */
export type ImageSmoothMethod = 'none' | 'nearest-neighbor';

/** A numeric setting + an enabled flag. Used for all slider Filters. */
export interface FilterSlider {
  readonly enabled: boolean;
  /** Value in the setting's natural unit (%, multiplier, etc.). */
  readonly value: number;
}

/** On/off filter with no value. Grayscale is the only one of these today. */
export interface FilterToggle {
  readonly enabled: boolean;
}

/** Discrete-method setting. Image smooth is the only filter that takes an
 *  enum (sampling method) instead of a number; 'none' disables it. */
export interface FilterMethod {
  readonly method: ImageSmoothMethod;
}

export interface DisplaySettings {
  readonly readingDirection: ReadingDirection;
  readonly screenOrientation: ScreenOrientation;
  readonly pageLayout: PageLayout;
  readonly interfaceTheme: InterfaceTheme;
  readonly viewerMode: ViewerMode;
  readonly zoom: ZoomMode;
  /** Magnifier loupe zoom factor. 1 = no magnification. Default 2.5.
   *  Edited from the Preferences page; the viewer reads it live. */
  readonly magnifierZoom: number;
  /** Keep the screen on while reading (Screen Wake Lock API). */
  readonly keepAwake: boolean;
}

export interface FilterSettings {
  readonly brightness: FilterSlider;
  readonly blueLight: FilterSlider;
  readonly contrast: FilterSlider;
  readonly sepia: FilterSlider;
  readonly grain: FilterSlider;
  readonly grayscale: FilterToggle;
  readonly imageSmooth: FilterMethod;
}

export interface AppSettings {
  readonly display: DisplaySettings;
  readonly filters: FilterSettings;
}

/** Defaults — keep in one place so the service, tests, and reset share them. */
export const DEFAULT_SETTINGS: AppSettings = {
  display: {
    readingDirection: 'ltr',
    screenOrientation: 'auto',
    pageLayout: 'auto',
    interfaceTheme: 'light',
    viewerMode: 'paged',
    zoom: 'fit-screen',
    magnifierZoom: 2.5,
    keepAwake: false,
  },
  filters: {
    brightness: { enabled: false, value: 100 },
    blueLight: { enabled: false, value: 0 },
    contrast: { enabled: false, value: 100 },
    grayscale: { enabled: false },
    sepia: { enabled: false, value: 0 },
    grain: { enabled: false, value: 0 },
    imageSmooth: { method: 'none' },
  },
};

/** Bounds for Filters sliders — used by the UI and by SettingsService setters. */
export const FILTER_BOUNDS = {
  brightness: { min: 25, max: 200, step: 5 },
  blueLight: { min: 0, max: 80, step: 5 },
  contrast: { min: 25, max: 200, step: 5 },
  sepia: { min: 0, max: 100, step: 5 },
  grain: { min: 0, max: 100, step: 5 },
} as const satisfies Record<
  Exclude<keyof FilterSettings, 'imageSmooth' | 'grayscale'>,
  { min: number; max: number; step: number }
>;

/** Bounds for the magnifier zoom slider in Preferences. */
export const MAGNIFIER_BOUNDS = {
  min: 1.5,
  max: 6,
  step: 0.5,
} as const;
