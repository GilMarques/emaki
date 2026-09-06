import { Injectable } from '@angular/core';

import { Connector } from './connector.base';
import type { Chapter, Manga, PageRef } from './connector.model';

const API = 'https://api.comick.io';
const IMAGE_ORIGIN = 'https://meo.comick.pictures';
const PAGE_LIMIT = 49;
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

interface ComicKChapterDetail {
  readonly chapter?: { readonly md_images?: readonly { readonly b2key: string }[] };
}

/**
 * ComicK provider — plain REST client for the `api.comick.io` catalogue.
 *
 * Adapted from HakuNeko's `ComicK.mjs` (public domain). Endpoints list
 * mangas and chapters in fixed-size pages; an empty page or an HTTP error
 * marks the end of the listing, mirroring the original's `fetchJSONEx`
 * fallback (which turns the API's 400 "not found" into an empty page).
 */
@Injectable({ providedIn: 'root' })
export class ComicKConnector extends Connector {
  public override readonly id = 'comick';
  public override readonly label = 'ComicK';
  public override readonly url = 'https://comick.io';
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
    const images = data.chapter?.md_images;
    return (images ?? []).map((image) => ({ url: `${IMAGE_ORIGIN}/${image.b2key}` }));
  }

  // ─────────────────────────── Internals ───────────────────────────

  private async getMangaPage(page: number): Promise<Manga[]> {
    if (page > 1) {
      await this.wait(PAGE_DELAY_MS);
    }
    const params = this.page(page);
    try {
      const items = await this.fetchJson<ComicKSearchItem[]>(this.api('/v1.0/search', params));
      return items.map((item) => this.toManga(item));
    } catch {
      return [];
    }
  }

  private async getChapterPage(mangaId: string, page: number): Promise<ComicKChapterList | undefined> {
    if (page > 1) {
      await this.wait(PAGE_DELAY_MS);
    }
    const params = this.page(page);
    try {
      return await this.fetchJson<ComicKChapterList>(this.api(`/comic/${mangaId}/chapters`, params));
    } catch {
      return undefined;
    }
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
