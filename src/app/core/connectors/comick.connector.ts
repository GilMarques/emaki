import { Injectable } from '@angular/core';

import { Connector } from './connector.base';
import type { Chapter, Manga, PageRef } from './connector.model';

const API = 'https://api.comick.dev';
const IMAGE_ORIGIN = 'https://meo.comick.pictures';
const PAGE_LIMIT = 49;
const CHAPTER_LIMIT = 100;
const PAGE_DELAY_MS = 500;

interface ComicKSearchItem {
  readonly hid: string;
  readonly title: string;
}

interface ComicKChapter {
  readonly hid: string;
  readonly vol?: number | string | null;
  readonly chap?: number | string | null;
  readonly title?: string | null;
  readonly lang: string;
  readonly group_name?: readonly string[];
}

interface ComicKChapterList {
  readonly chapters?: readonly ComicKChapter[];
}

interface ComicKImage {
  readonly b2key?: string | null;
  readonly gpurl?: string | null;
  readonly url?: string | null;
}

interface ComicKChapterDetail {
  readonly chapter?: { readonly md_images?: readonly ComicKImage[] };
}

/**
 * ComicK provider — plain REST client for the `api.comick.dev` catalogue.
 *
 * Adapted from HakuNeko's `ComicK.mjs` (public domain). The API host moved
 * from `api.comick.io` to `api.comick.dev`, and the chapter endpoint lost
 * its `/v1.0` prefix, so both are pinned to the current paths here.
 *
 * Endpoints list mangas and chapters in fixed-size pages; an empty page or
 * an HTTP error marks the end of the listing, mirroring the original's
 * `fetchJSONEx` fallback (which turns the API's 400 "not found" into an
 * empty page).
 */
@Injectable({ providedIn: 'root' })
export class ComicKConnector extends Connector {
  public override readonly id = 'comick';
  public override readonly label = 'ComicK';
  public override readonly url = 'https://comick.dev';
  public override readonly tags = ['manga', 'english'] as const;

  protected override async _getMangas(): Promise<Manga[]> {
    const mangas: Manga[] = [];
    for (let page = 1, run = true; run; page++) {
      const items = await this.getMangaPage(page);
      if (items.length === 0) {
        run = false;
      } else {
        mangas.push(...items);
      }
    }
    return mangas;
  }

  /** The API filters server-side on `q`, so search never walks the catalogue. */
  protected override async _search(query: string): Promise<Manga[]> {
    const term = query.trim();
    if (!term) return this._getMangas();
    const mangas: Manga[] = [];
    for (let page = 1, run = true; run; page++) {
      const items = await this.getMangaPage(page, term);
      if (items.length === 0) {
        run = false;
      } else {
        mangas.push(...items);
      }
    }
    return mangas;
  }

  protected override async _getChapters(manga: Manga): Promise<Chapter[]> {
    const chapters: Chapter[] = [];
    for (let page = 1, run = true; run; page++) {
      const data = await this.getChapterPage(manga.id, page);
      const items = data?.chapters;
      if (!items || items.length === 0) {
        run = false;
      } else {
        chapters.push(...items.map((item) => this.toChapter(item)));
      }
    }
    return chapters;
  }

  protected override async _getPages(chapter: Chapter): Promise<PageRef[]> {
    const data = await this.fetchJson<ComicKChapterDetail>(
      this.api(`/chapter/${chapter.id}`, new URLSearchParams()),
    );
    const images = data.chapter?.md_images ?? [];
    return images
      .map((image) => this.toPageUrl(image))
      .filter((url): url is string => url !== undefined)
      .map((url) => ({ url }));
  }

  // ─────────────────────────── Internals ───────────────────────────

  private async getMangaPage(page: number, query?: string): Promise<Manga[]> {
    if (page > 1) {
      await this.wait(PAGE_DELAY_MS);
    }
    const params = this.page(page);
    if (query) {
      params.set('q', query);
    }
    try {
      const items = await this.fetchJson<ComicKSearchItem[]>(this.api('/v1.0/search', params));
      return items.map((item) => this.toManga(item));
    } catch (error) {
      this.reportFailure('manga page', error);
      return [];
    }
  }

  private async getChapterPage(mangaId: string, page: number): Promise<ComicKChapterList | undefined> {
    if (page > 1) {
      await this.wait(PAGE_DELAY_MS);
    }
    const params = this.page(page);
    params.set('limit', String(CHAPTER_LIMIT));
    try {
      return await this.fetchJson<ComicKChapterList>(this.api(`/v1.0/comic/${mangaId}/chapters`, params));
    } catch (error) {
      this.reportFailure('chapter page', error);
      return undefined;
    }
  }

  /** An image key resolves to a CDN path; `gpurl`/`url` are absolute already. */
  private toPageUrl(image: ComicKImage): string | undefined {
    if (image.gpurl) return image.gpurl;
    if (image.url) return image.url;
    if (image.b2key) return `${IMAGE_ORIGIN}/${image.b2key}`;
    return undefined;
  }

  private toManga(item: ComicKSearchItem): Manga {
    return { id: item.hid, title: item.title.trim() };
  }

  private toChapter(item: ComicKChapter): Chapter {
    let title = '';
    if (item.vol) {
      title += `Vol. ${item.vol} `;
    }
    if (item.chap !== undefined && item.chap !== null) {
      title += `Ch. ${item.chap}`;
    }
    if (item.title) {
      title += ` - ${item.title}`;
    }
    title += ` (${item.lang})`;
    if (item.group_name && item.group_name.length) {
      title += ` [${item.group_name.join(', ')}]`;
    }
    return { id: item.hid, title, language: item.lang };
  }

  private page(page: number): URLSearchParams {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_LIMIT));
    params.set('page', String(page));
    return params;
  }

  private api(path: string, params: URLSearchParams = new URLSearchParams()): string {
    const url = new URL(API + path);
    url.search = params.toString();
    return url.href;
  }
}
