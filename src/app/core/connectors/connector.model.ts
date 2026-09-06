/**
 * Data shapes exchanged between a Connector and the rest of the app.
 *
 * Mirrors HakuNeko's Manga/Chapter/page list concepts, but stripped of the
 * Electron coupling: these are plain serializable records a feature page can
 * render directly.
 */

/** A single series as advertised by a provider. */
export interface Manga {
  /** Provider-local stable identifier (usually a URL path or API GUID). */
  readonly id: string;
  readonly title: string;
  /** Absolute cover thumbnail URL, when the provider exposes one. */
  readonly coverUrl?: string;
}

/** One downloadable chapter of a series. */
export interface Chapter {
  /** Provider-local stable identifier (usually a URL path or API GUID). */
  readonly id: string;
  readonly title: string;
  /** BCP-47 tag of the translation, e.g. `en`. Optional. */
  readonly language?: string;
}

/**
 * One page of a chapter. `url` is the primary source; `alternates` are
 * fallback mirrors tried in order when the primary download fails.
 */
export interface PageRef {
  readonly url: string;
  readonly alternates?: readonly string[];
}

/** Shape of the response `@capacitor/core` returns for native requests. */
export interface NativeHttpResponse {
  readonly status: number;
  /** String body for `text`, JSON-decoded object for `json`, base64 for `arraybuffer`. */
  readonly data: unknown;
  readonly headers: Record<string, string>;
}