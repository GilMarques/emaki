import { inject } from '@angular/core';

import { ConnectorRequestService } from './connector-request.service';
import type { Chapter, Manga, PageRef } from './connector.model';

/**
 * Base class for manga providers.
 *
 * This is the open-viewer port of HakuNeko's `Connector` (public-domain
 * UNLICENSE, so reuse is clean). The Electron-specific engine — headless
 * BrowserWindow anti-bot bypass, `Engine.Storage`, Node `Buffer` — is
 * replaced by a thin fetch layer (see `ConnectorRequestService`). Connectors
 * that depend on those Electron tricks (Cloudflare/DDOS-Guard solvers) will
 * not port; the vast majority are plain HTML/JSON scrapers and drop in
 * unchanged apart from this base class.
 *
 * A connector exposes three capabilities, all implemented by subclasses via
 * the `_get*` hooks:
 *   - `getMangas()` / `search()`  — series list
 *   - `getChapters(manga)`        — chapter list
 *   - `getPages(chapter)`         — image URLs to feed the reader
 */
export abstract class Connector {
  /** Stable identifier, e.g. `mangadex`. Used by the registry and storage. */
  public abstract readonly id: string;
  /** Human-readable name shown in the UI. */
  public abstract readonly label: string;
  /** Provider home page. */
  public abstract readonly url: string;
  /** Advertised characteristics, e.g. `manga`, `official`, `multi-lingual`. */
  public readonly tags: readonly string[] = [];

  /** Base request headers sent with every provider request. */
  protected readonly requestHeaders: Record<string, string> = {
    accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'user-agent':
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  };

  protected readonly requests: ConnectorRequestService = inject(ConnectorRequestService);

  // ─────────────────────────── Public API ───────────────────────────

  /** All series known to the provider. May be paginated or cached upstream. */
  public async getMangas(): Promise<Manga[]> {
    return this._getMangas();
  }

  /** Search the provider's catalogue. Defaults to a title filter on `getMangas()`. */
  public async search(query: string): Promise<Manga[]> {
    return this._search(query);
  }

  /** Chapters of a series, oldest-first where the provider orders them. */
  public async getChapters(manga: Manga): Promise<Chapter[]> {
    return this._getChapters(manga);
  }

  /** Image sources for a chapter. The reader tries `alternates` after `url`. */
  public async getPages(chapter: Chapter): Promise<PageRef[]> {
    return this._getPages(chapter);
  }

  // ───────────────────────── Subclass hooks ─────────────────────────

  protected abstract _getMangas(): Promise<Manga[]>;
  protected abstract _getChapters(manga: Manga): Promise<Chapter[]>;
  protected abstract _getPages(chapter: Chapter): Promise<PageRef[]>;

  /** Default search: case-insensitive title filter over the full catalogue. */
  protected async _search(query: string): Promise<Manga[]> {
    const needle = query.trim().toLowerCase();
    const mangas = await this._getMangas();
    if (!needle) return mangas;
    return mangas.filter((manga) => manga.title.toLowerCase().includes(needle));
  }

  // ───────────────────────────── Helpers ─────────────────────────────

  /** Request headers merged with per-request overrides. */
  protected headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...this.requestHeaders, ...extra };
  }

  /**
   * Fetch a URL and return all elements matching `selector`.
   * The base class that every HTML-scrape connector is built on.
   */
  protected async fetchDOM(url: string, selector: string, extraHeaders?: Record<string, string>): Promise<Element[]> {
    const html = await this.requests.fetchText(url, this.headers(extraHeaders));
    return Array.from(this.createDOM(html).querySelectorAll(selector));
  }

  /** Fetch a URL and parse the body as JSON. */
  protected async fetchJson<T = unknown>(url: string, extraHeaders?: Record<string, string>): Promise<T> {
    return this.requests.fetchJson<T>(url, this.headers(extraHeaders));
  }

  /**
   * Fetch a URL and extract every capturing-group match of `regex`.
   * The regex must include the global `g` flag.
   */
  protected async fetchRegex(url: string, regex: RegExp, extraHeaders?: Record<string, string>): Promise<string[]> {
    if (!regex.global) {
      throw new Error('The provided RegExp must contain the global "g" modifier!');
    }
    const text = await this.requests.fetchText(url, this.headers(extraHeaders));
    const result: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      result.push(match[1]);
    }
    return result;
  }

  /** Parse an HTML string into a detached Document (no image loading). */
  protected createDOM(html: string): Document {
    return new DOMParser().parseFromString(html, 'text/html');
  }

  /** Resolve a relative href/src (or string) against `base` into an absolute URL. */
  protected getAbsolutePath(reference: string | Element, base: string): string {
    const baseURI = new URL(base);
    const href =
      typeof reference === 'string'
        ? reference
        : (reference.getAttribute('href') ?? reference.getAttribute('src') ?? '');
    return new URL(href, baseURI).href;
  }

  /**
   * Root-relative link for same-domain references, absolute for cross-domain
   * ones — matches how HakuNeko connectors hand links to `fetchDOM`.
   */
  protected getRootRelativeOrAbsoluteLink(reference: string | Element, base: string): string {
    const uri = new URL(this.getAbsolutePath(reference, base));
    return uri.hostname === new URL(base).hostname
      ? uri.pathname + uri.search + uri.hash
      : uri.href;
  }

  /** Resolve a promise after `ms` milliseconds (rate limiting, retry backoff). */
  protected wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}