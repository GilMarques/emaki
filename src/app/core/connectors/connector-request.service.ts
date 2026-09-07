import { Injectable } from '@angular/core';
import { Capacitor, CapacitorHttp } from '@capacitor/core';

/**
 * Transport for connector requests.
 *
 * On native platforms it goes through `CapacitorHttp`, which bypasses the
 * WebView's CORS sandbox — required because most manga sites don't send
 * `Access-Control-Allow-Origin`. In the browser it falls back to plain
 * `fetch` (fine for CORS-friendly APIs like MangaDex; scraping sites that
 * block CORS will fail there — run the app on a device for those).
 *
 * All methods throw on non-2xx responses. Binary downloads are returned as
 * Blobs with a mime type corrected from the file signature (sites frequently
 * lie or omit the `Content-Type` header).
 */
@Injectable({ providedIn: 'root' })
export class ConnectorRequestService {
  private readonly native = Capacitor.isNativePlatform();

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
      const response = await CapacitorHttp.get({ url, headers, responseType });
      const data =
        responseType === 'arraybuffer'
          ? this.toArrayBuffer(response.data)
          : this.toText(response.data);
      return { status: response.status, data: data as T };
    }
    const response = await fetch(url, { headers });
    const data = responseType === 'arraybuffer' ? await response.arrayBuffer() : await response.text();
    return { status: response.status, data: data as T };
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