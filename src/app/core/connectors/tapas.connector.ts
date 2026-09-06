import { Injectable } from '@angular/core';

import { Connector } from './connector.base';
import type { Chapter, Manga, PageRef } from './connector.model';

const API = 'https://story-api.tapas.io/cosmos/api/v1/landing';
const SITE = 'https://tapas.io';
const PAGE_SIZE = 200;
const JSON_ACCEPT = 'application/json, text/javascript, */*;';
const COOKIE_HEADERS: Record<string, string> = { 'x-cookie': 'adjustedBirthDate=1990-01-01' };

interface TapasResponse<T> {
  readonly data: T;
}

interface TapasGenreItem {
  readonly seriesId: string | number;
  readonly title: string;
}

interface TapasGenreData {
  readonly items: readonly TapasGenreItem[];
}

interface TapasEpisodeItem {
  readonly id: string | number;
  readonly title: string;
}

interface TapasEpisodeData {
  readonly episodes: readonly TapasEpisodeItem[];
}

/**
 * Tapas provider — legal webtoon/novel platform.
 *
 * Series come from the story API's genre feed, chapters from the series'
 * episodes JSON, and pages are scraped from each episode's viewer markup.
 * Only the image (manga/webtoon) path is ported; HakuNeko's html2canvas novel
 * rendering is dropped, so novel episodes resolve to an empty page list.
 */
@Injectable({ providedIn: 'root' })
export class TapasConnector extends Connector {
  public override readonly id = 'tapas';
  public override readonly label = 'Tapas';
  public override readonly url = 'https://tapas.io';
  public override readonly tags = ['webtoon', 'english'] as const;

  protected override async _getMangas(): Promise<Manga[]> {
    const mangas: Manga[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.getMangasPage(page);
      if (batch.length === 0) {
        return mangas;
      }
      mangas.push(...batch);
    }
  }

  protected override async _getChapters(manga: Manga): Promise<Chapter[]> {
    const chapters: Chapter[] = [];
    for (let page = 1; ; page++) {
      const data = await this.fetchJson<TapasResponse<TapasEpisodeData>>(
        `${SITE}/series/${manga.id}/episodes?page=${page}`,
        this.headers(COOKIE_HEADERS),
      );
      const episodes = data.data.episodes;
      if (episodes.length === 0) {
        return chapters;
      }
      chapters.push(...episodes.map((episode) => this.toChapter(episode)));
    }
  }

  protected override async _getPages(chapter: Chapter): Promise<PageRef[]> {
    const url = `${SITE}${chapter.id}`;
    const images = await this.fetchDOM(
      url,
      'div.viewer > article > source.content__img',
      this.headers(COOKIE_HEADERS),
    );
    return images
      .map((image) => image.getAttribute('data-src'))
      .filter((src): src is string => Boolean(src))
      .map((src) => ({ url: this.getAbsolutePath(src, url) }));
  }

  // ─────────────────────────── Internals ───────────────────────────

  private async getMangasPage(page: number): Promise<Manga[]> {
    const data = await this.fetchJson<TapasResponse<TapasGenreData>>(
      `${API}/genre?category_type=COMIC&size=${PAGE_SIZE}&page=${page}`,
      this.headers({ ...COOKIE_HEADERS, accept: JSON_ACCEPT }),
    );
    return data.data.items.map((item) => ({ id: String(item.seriesId), title: item.title }));
  }

  private toChapter(episode: TapasEpisodeItem): Chapter {
    return { id: `/episode/${episode.id}`, title: episode.title };
  }
}
