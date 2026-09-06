import { Injectable } from '@angular/core';

import { Connector } from './connector.base';
import type { Chapter, Manga, PageRef } from './connector.model';

const PATHS = ['/series', '/series/oneshot', '/series/finished'] as const;
const ISSUE_PATH = /^\/(magazine|volume)\/\d+$/;

const MANGA_LINK = 'article.series-list-wrapper ul.series-list > li.series-list-item > a';
const MANGA_TITLE = 'h2.series-list-title';
const ISSUE_TITLE = '.episode-header-title';
const ATOM_FEED = 'head link[type*="atom+xml"]';
const FEED_ENTRIES = 'feed entry';
const EPISODE_JSON = '#episode-json';

interface SjpPage {
  readonly src: string;
  readonly type: string;
}

interface SjpReadableProduct {
  readonly isPublic: boolean;
  readonly hasPurchased: boolean;
  readonly pageStructure: { readonly choJuGiga?: string; readonly pages: readonly SjpPage[] };
}

interface SjpEpisode {
  readonly readableProduct: SjpReadableProduct;
}

/**
 * Shonen Jump + provider — official Jump manga site.
 *
 * Scrapes the series index pages for mangas, the per-series Atom feed for
 * chapters, and the chapter page's `#episode-json` blob for page images.
 * Adapted from HakuNeko's `ShonenJumpPlus.mjs` + `CoreView.mjs` (public
 * domain); the Canvas 'baku' descrambler is deliberately not ported.
 */
@Injectable({ providedIn: 'root' })
export class ShonenJumpPlusConnector extends Connector {
  public override readonly id = 'shonenjumpplus';
  public override readonly label = 'Shonen Jump +';
  public override readonly url = 'https://shonenjumpplus.com';
  public override readonly tags = ['manga', 'japanese'] as const;

  protected override async _getMangas(): Promise<Manga[]> {
    const mangas: Manga[] = [];
    for (const path of PATHS) {
      const url = this.url + path;
      const links = await this.fetchDOM(url, MANGA_LINK);
      mangas.push(
        ...links.map((link) => ({
          id: this.getRootRelativeOrAbsoluteLink(link, url),
          title: link.querySelector(MANGA_TITLE)?.textContent?.trim() ?? '',
        })),
      );
    }
    return mangas;
  }

  protected override async _getChapters(manga: Manga): Promise<Chapter[]> {
    const url = this.url + manga.id;
    if (ISSUE_PATH.test(manga.id)) {
      const [header] = await this.fetchDOM(url, ISSUE_TITLE);
      if (!header) {
        throw new Error(`Shonen Jump +: no issue header found for ${manga.id}`);
      }
      return [
        {
          id: manga.id,
          title: (header.textContent ?? '').replace(manga.title, '').trim(),
          language: '',
        },
      ];
    }
    const [feed] = await this.fetchDOM(url, ATOM_FEED);
    if (!feed) {
      throw new Error(`Shonen Jump +: no Atom feed found for ${manga.title}`);
    }
    const feedUrl = new URL(feed.getAttribute('href') ?? '', url);
    feedUrl.searchParams.set('free_only', '0');
    const entries = await this.fetchDOM(feedUrl.href, FEED_ENTRIES);
    return entries.map((entry) => {
      const entryTitle = entry.querySelector('title');
      const title = (entryTitle?.textContent ?? '').replace(manga.title, '').trim();
      return {
        id: this.getRootRelativeOrAbsoluteLink(entry.querySelector('link') ?? entry, this.url),
        title: title || manga.title,
        language: '',
      };
    });
  }

  protected override async _getPages(chapter: Chapter): Promise<PageRef[]> {
    const url = this.url + chapter.id;
    const [episode] = await this.fetchDOM(url, EPISODE_JSON);
    if (!episode) {
      throw new Error(`Shonen Jump +: no episode data found for ${chapter.id}`);
    }
    const data = JSON.parse(episode.getAttribute('data-value') ?? '') as SjpEpisode;
    if (!data.readableProduct.isPublic && !data.readableProduct.hasPurchased) {
      throw new Error(`The chapter '${chapter.title}' is neither public, nor purchased!`);
    }
    if (data.readableProduct.pageStructure.choJuGiga === 'baku') {
      throw new Error('Scrambled (baku) chapters are not supported');
    }
    return data.readableProduct.pageStructure.pages
      .filter((page) => page.type === 'main')
      .map((page) => ({ url: this.getAbsolutePath(page.src, url) }));
  }
}
