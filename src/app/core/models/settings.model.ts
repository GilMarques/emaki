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
  | 'landscape-inverted'
  | 'default';

export type PageLayout =
  | 'default'
  | 'auto-single'
  | 'auto-dual'
  | 'auto-switch';

export type InterfaceTheme = 'auto' | 'light' | 'dark';

export type ViewerMode = 'paged' | 'vertical-scroll' | 'horizontal-scroll';

/**
 * How the page image is sized to the viewport. Persisted across sessions.
 * 'fixed-size' is stored but the numeric picker is out of v1 scope (the
 * page-flip v1 renderer can't honor a custom px size without remounting
 * around the page's natural dimensions) — falls back to fit-screen.
 */
export type ZoomMode =
  | 'actual-size'
  | 'fit-screen'
  | 'fit-width'
  | 'fit-height'
  | 'fixed-size'
  | 'stretch-to-fill'
  | 'cover';

export type PageTransition = 'none' | 'slide-horizontal' | 'slide-vertical' | 'page-curl';

/**
 * Sampling method for image upscaling/downscaling. Mapped to CSS
 * `image-rendering` where the browser supports it; higher-quality
 * entries (bicubic, lanczos3) are stored but inert until a WebGL
 * filter lands — only nearest-neighbor visibly differs today.
 */
export type ImageSmoothMethod =
  | 'none'
  | 'nearest-neighbor'
  | 'averaging'
  | 'bilinear'
  | 'bicubic'
  | 'lanczos3';

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
  readonly pageTransition: PageTransition;
  readonly zoom: ZoomMode;
  /** Magnifier loupe zoom factor. 1 = no magnification. Default 2.5.
   *  Edited from the Preferences page; the viewer reads it live. */
  readonly magnifierZoom: number;
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
    pageLayout: 'default',
    interfaceTheme: 'light',
    viewerMode: 'paged',
    pageTransition: 'none',
    zoom: 'fit-screen',
    magnifierZoom: 2.5,
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
