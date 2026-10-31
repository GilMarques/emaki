import { Injectable } from '@angular/core';
import { Capacitor, CapacitorHttp } from '@capacitor/core';

/**
 * Transport for connector requests.
 *
 * Native platforms have two ways out of the WebView:
 *
 *  - `CapacitorHttp` runs outside the WebView sandbox, so it ignores CORS
 *    entirely. That is what most manga sites need, because they send no
 *    `Access-Control-Allow-Origin`.
 *  - the WebView's own `fetch()`, which is a real browser request: it passes
 *    bot checks that fingerprint the TLS handshake (ComicK answers a native
 *    client with a 403 challenge) and it can read the providers that do send
 *    CORS headers.
 *
 * So the WebView is tried first and the native client is the fallback. Which
 * one works is remembered per host, because the answer only depends on the
 * provider.
 *
 * In a browser the same CORS wall applies to `fetch()`, so web builds route
 * every request through the local provider proxy (`scripts/provider-proxy.mjs`),
 * which fetches the target server-side and returns the bytes with permissive
 * CORS headers. The proxy base can be overridden at runtime by setting
 * `window.__EMAKI_PROXY__` before the app boots, which is how a packaged
 * desktop build points at its own bundled proxy.
 *
 * All methods throw on non-2xx responses. Binary downloads are returned as
 * Blobs with a mime type corrected from the file signature (sites frequently
 * lie or omit the `Content-Type` header).
 */
@Injectable({ providedIn: 'root' })
export class ConnectorRequestService {
  private readonly native = Capacitor.isNativePlatform();

  /** Base URL of the provider proxy; empty when the proxy is unavailable. */
  private readonly proxyBase = this.readProxyBase();

  /**
   * Per host: can the WebView read the provider's responses?
   *
   * `true` — yes, use the WebView. `false` — no, use the native client.
   * Unset means "not tried yet".
   */
  private readonly webReadable = new Map<string, boolean>();

  /** Fetch a URL as a UTF-8 string. */
  public async fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
    const { status, data } = await this.raw<string>(url, 'text', headers);
    if (status < 200 || status >= 300) {
      throw new Error(`Failed to fetch "${url}" (status: ${status})`);
    }
    return data;
  }

  /** Fetch a URL and parse the body as JSON. */
  public async fetchJson<T = unknown>(url: string, headers: Record<string, string> = {}): Promise<T> {
    return JSON.parse(await this.fetchText(url, headers)) as T;
  }

  /** Fetch a URL as a Blob, sniffing the real image mime from the bytes. */
  public async fetchImage(url: string, headers: Record<string, string> = {}): Promise<Blob> {
    const { status, data } = await this.raw<ArrayBuffer>(url, 'arraybuffer', headers);
    if (status < 200 || status >= 300) {
      throw new Error(`Failed to fetch "${url}" (status: ${status})`);
    }
    const bytes = new Uint8Array(data);
    return new Blob([bytes], { type: this.sniffMimeType(bytes) });
  }

  private async raw<T extends string | ArrayBuffer>(
    url: string,
    responseType: 'text' | 'arraybuffer',
    headers: Record<string, string>,
  ): Promise<{ status: number; data: T }> {
    if (this.native) {
      return this.nativeRaw<T>(url, responseType, headers);
    }

    const target = this.proxyUrl(url);
    const response = await fetch(target, { headers: this.browserHeaders(headers) });
    const data = responseType === 'arraybuffer' ? await response.arrayBuffer() : await response.text();
    return { status: response.status, data: data as T };
  }

  /**
   * Native transport: the WebView first, the platform HTTP client second.
   *
   * The WebView is a real browser, so it survives providers that challenge
   * non-browser clients (ComicK) and can read the ones that send CORS
   * headers. The platform client is the fallback for the scraping sites
   * that send no CORS headers at all.
   */
  private async nativeRaw<T extends string | ArrayBuffer>(
    url: string,
    responseType: 'text' | 'arraybuffer',
    headers: Record<string, string>,
  ): Promise<{ status: number; data: T }> {
    const host = this.hostOf(url);
    if (this.webReadable.get(host) !== false) {
      try {
        const result = await this.webRaw<T>(url, responseType, headers);
        this.webReadable.set(host, true);
        return result;
      } catch {
        // The WebView could not read the response — fall through.
      }
    }

    const response = await CapacitorHttp.get({
      url,
      headers: this.nativeHeaders(headers),
      responseType,
    });
    const data =
      responseType === 'arraybuffer'
        ? this.toArrayBuffer(response.data)
        : this.toText(response.data);
    // The native client answered, so the WebView cannot read this provider.
    if (this.webReadable.get(host) !== true) {
      this.webReadable.set(host, false);
    }
    return { status: response.status, data: data as T };
  }

  /** A plain `fetch()` from inside the WebView. */
  private async webRaw<T extends string | ArrayBuffer>(
    url: string,
    responseType: 'text' | 'arraybuffer',
    headers: Record<string, string>,
  ): Promise<{ status: number; data: T }> {
    const response = await fetch(url, { headers: this.webHeaders(headers) });
    const data = responseType === 'arraybuffer' ? await response.arrayBuffer() : await response.text();
    return { status: response.status, data: data as T };
  }

  /** The host of a URL, used as the key for the per-provider decision. */
  private hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  /**
   * Route a URL through the provider proxy.
   *
   * The target travels as a query parameter so the proxy sees a plain
   * same-origin-ish GET and can answer with permissive CORS headers.
   */
  private proxyUrl(url: string): string {
    if (!this.proxyBase) {
      throw new Error(
        `Cannot reach "${url}": no provider proxy is configured. ` +
          'Start the dev server with "npm start" (it runs scripts/provider-proxy.mjs) ' +
          'or set window.__EMAKI_PROXY__ to a proxy base URL.',
      );
    }
    return `${this.proxyBase}/?url=${encodeURIComponent(url)}`;
  }

  /**
   * Headers for the proxy path.
   *
   * `user-agent` and `referer` are forbidden header names — the browser
   * drops them — so the proxy supplies its own user agent, and a referer
   * travels as `x-referer` (which the proxy maps back to `Referer`).
   */
  private browserHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      if (lower === 'user-agent' || lower === 'referer') continue;
      out[name] = value;
    }
    return out;
  }

  /**
   * Headers for a WebView request.
   *
   * Same as the proxy path minus `x-referer`: a browser cannot set a
   * referer at all, and a custom header would only trigger a preflight the
   * providers do not answer.
   */
  private webHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      if (lower === 'user-agent' || lower === 'referer' || lower === 'x-referer') continue;
      out[name] = value;
    }
    return out;
  }

  /** Map `x-referer` onto the real `Referer` header for the native transport. */
  private nativeHeaders(headers: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      if (lower === 'x-referer') {
        out['Referer'] = value;
        continue;
      }
      out[name] = value;
    }
    return out;
  }

  /** Read the proxy base URL from the global override, or fall back to the dev default. */
  private readProxyBase(): string {
    const injected = (globalThis as { __EMAKI_PROXY__?: unknown }).__EMAKI_PROXY__;
    if (typeof injected === 'string' && injected.length > 0) {
      return injected.replace(/\/+$/, '');
    }
    return 'http://127.0.0.1:4300';
  }

  /**
   * Capacitor's Android HTTP layer can hand back an already-parsed object for
   * JSON bodies even when `responseType: 'text'` was requested. Normalise to a
   * string so `fetchText`/`fetchJson` always get raw text: strings pass through,
   * objects are re-serialised.
   */
  private toText(data: unknown): string {
    if (typeof data === 'string') return data;
    return data === null || data === undefined ? '' : JSON.stringify(data);
  }

  /** Capacitor returns binary bodies as base64 — normalise to ArrayBuffer. */
  private toArrayBuffer(data: unknown): ArrayBuffer {
    let base64 = typeof data === 'string' ? data : '';
    if (base64.includes(',')) {
      base64 = base64.slice(base64.indexOf(',') + 1);
    }
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  /**
   * Correct a mime type from the file signature when the server's
   * `Content-Type` is wrong or absent (common on image hosts).
   */
  private sniffMimeType(bytes: Uint8Array): string {
    if (bytes.length >= 12 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
      return 'image/webp';
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return 'image/jpeg';
    }
    if (bytes.length >= 4 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      return 'image/png';
    }
    if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
      return 'image/gif';
    }
    if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
      return 'image/bmp';
    }
    return 'application/octet-stream';
  }
}
