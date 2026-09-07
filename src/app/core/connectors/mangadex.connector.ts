import { Injectable } from '@angular/core';

import { Connector } from './connector.base';
import type { Chapter, Manga, PageRef } from './connector.model';

const API = 'https://api.mangadex.org';
const UPLOADS = 'https://uploads.mangadex.org';
const PAGE_SIZE = 100;
const PAGE_DELAY_MS = 750;
const CONTENT_RATINGS = ['safe', 'suggestive', 'erotica'] as const;

interface MangaDexResponse<T> {
  readonly data: T[];
  readonly limit?: number;
  readonly offset?: number;
  readonly total?: number;
  readonly result?: string;
}

interface MangaDexRelationship {
  readonly id: string;
  readonly type: string;
  readonly attributes?: { readonly fileName?: string; readonly name?: string };
}

interface MangaDexManga {
  readonly id: string;
  readonly attributes: { readonly title: Record<string, string>; readonly contentRating?: string };
  readonly relationships: readonly MangaDexRelationship[];
}

interface MangaDexChapter {
  readonly id: string;
  readonly attributes: {
    readonly volume?: string | null;
    readonly chapter?: string | number | null;
    readonly title?: string | null;
    readonly translatedLanguage?: string;
  };
  readonly relationships: readonly MangaDexRelationship[];
}

interface MangaDexAtHome {
  readonly baseUrl: string;
  readonly chapter: { readonly hash: string; readonly data: readonly string[] };
}

/**
 * MangaDex provider — the reference implementation for the connector engine.
 *
 * Uses the official REST API (`api.mangadex.org`) plus the at-home image
 * network, so it needs no scraping and survives site redesigns. Adapted from
 * HakuNeko's `MangaDex.mjs` (public domain); the Electron plumbing and the
 * third-party cache seeds are dropped in favour of the plain at-home node.
 */
@Injectable({ providedIn: 'root' })
export class MangaDexConnector extends Connector {
  public override readonly id = 'mangadex';
  public override readonly label = 'MangaDex';
  public override readonly url = 'https://mangadex.org';
  public override readonly tags = ['manga', 'official', 'multi-lingual'] as const;

  /** Languages to pull chapters for. MangaDex requires a language filter. */
  public translatedLanguages: readonly string[] = ['en'];

  protected override async _getMangas(): Promise<Manga[]> {
    return this.getMangaPage(this.mangaParams(), 0);
  }

  protected override async _search(query: string): Promise<Manga[]> {
    const params = this.mangaParams();
    params.set('title', query.trim());
    return this.getMangaPage(params, 0);
  }

  protected override async _getChapters(manga: Manga): Promise<Chapter[]> {
    const chapters: Chapter[] = [];
    let offset = 0;
    for (;;) {
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(offset));
      params.set('order[chapter]', 'asc');
      for (const language of this.translatedLanguages) {
        params.append('translatedLanguage[]', language);
      }
      for (const rating of CONTENT_RATINGS) {
        params.append('contentRating[]', rating);
      }
      const data = await this.fetchJson<MangaDexResponse<MangaDexChapter>>(
        this.api(`/manga/${manga.id}/feed`, params),
      );
      chapters.push(...data.data.map((item) => this.toChapter(item)));
      offset += PAGE_SIZE;
      if (data.data.length < PAGE_SIZE || (data.total !== undefined && offset >= data.total)) {
        break;
      }
      await this.wait(PAGE_DELAY_MS);
    }
    return chapters;
  }

  protected override async _getPages(chapter: Chapter): Promise<PageRef[]> {
    const data = await this.fetchJson<MangaDexAtHome>(this.api(`/at-home/server/${chapter.id}`));
    const base = data.baseUrl.replace(/\/+$/, '');
    return data.chapter.data.map((file) => ({
      url: `${base}/data/${data.chapter.hash}/${file}`,
    }));
  }

  // ─────────────────────────── Internals ───────────────────────────

  private mangaParams(): URLSearchParams {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    params.set('includes[]', 'cover_art');
    params.set('hasAvailableChapters', 'true');
    params.set('order[latestUploadedChapter]', 'desc');
    for (const rating of CONTENT_RATINGS) {
      params.append('contentRating[]', rating);
    }
    return params;
  }

  private async getMangaPage(params: URLSearchParams, offset: number): Promise<Manga[]> {
    const page = new URLSearchParams(params);
    page.set('offset', String(offset));
    const data = await this.fetchJson<MangaDexResponse<MangaDexManga>>(this.api('/manga', page));
    return data.data.map((item) => this.toManga(item));
  }

  private toManga(item: MangaDexManga): Manga {
    const title = item.attributes.title['en'] ?? Object.values(item.attributes.title)[0] ?? 'Unknown';
    const cover = item.relationships.find((r) => r.type === 'cover_art');
    const fileName = cover?.attributes?.fileName;
    return {
      id: item.id,
      title,
      coverUrl: fileName ? `${UPLOADS}/covers/${item.id}/${fileName}.256.jpg` : undefined,
    };
  }

  private toChapter(item: MangaDexChapter): Chapter {
    const parts: string[] = [];
    const raw = item.attributes.chapter;
    const number = raw === null || raw === undefined || raw === 'none' ? '' : String(raw);
    if (number) {
      parts.push(`Ch. ${number}`);
    }
    if (item.attributes.title) {
      parts.push(item.attributes.title);
    }
    const groups = item.relationships
      .filter((r) => r.type === 'scanlation_group')
      .map((r) => r.attributes?.name)
      .filter((name): name is string => Boolean(name));
    if (groups.length > 0) {
      parts.push(`[${groups.join(', ')}]`);
    }
    return {
      id: item.id,
      title: parts.join(' - ') || 'Untitled chapter',
      language: item.attributes.translatedLanguage,
    };
  }

  private api(path: string, params: URLSearchParams = new URLSearchParams()): string {
    const url = new URL(API + path);
    url.search = params.toString();
    return url.href;
  }
}