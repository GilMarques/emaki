import { Injectable } from '@angular/core';

import { Connector } from './connector.base';
import type { Chapter, Manga, PageRef } from './connector.model';

interface CoreViewPage {
  readonly type: string;
  readonly src: string;
}

interface CoreViewPageStructure {
  readonly choJuGiga?: string;
  readonly pages: readonly CoreViewPage[];
}

interface CoreViewReadableProduct {
  readonly isPublic?: boolean;
  readonly hasPurchased?: boolean;
  readonly pageStructure: CoreViewPageStructure;
}

interface CoreViewData {
  readonly readableProduct: CoreViewReadableProduct;
}

/**
 * Tonari no Young Jump provider — a CoreView (Shueisha's GigaViewer) site.
 *
 * Mangas are scraped from the series/oneshot/trial index pages, chapters from
 * each series' Atom feed, and page URLs from the `#episode-json` payload.
 * The GigaViewer 'baku' scrambling (canvas descramble) needs a headless
 * browser, so only the unscrambled 'usagi' chapters resolve to pages.
 */
@Injectable({ providedIn: 'root' })
export class TonariNoYoungJumpConnector extends Connector {
  public override readonly id = 'tonarinoyoungjump';
  public override readonly label = 'Tonari no Young Jump';
  public override readonly url = 'https://tonarinoyj.jp';
  public override readonly tags = ['manga', 'japanese'] as const;

  private readonly paths = ['/series', '/series/oneshot', '/series/trial'];

  protected override async _getMangas(): Promise<Manga[]> {
    const mangas: Manga[] = [];
    const seen = new Set<string>();
    for (const path of this.paths) {
      const pageUrl = `${this.url}${path}`;
      const anchors = await this.fetchDOM(
        pageUrl,
        'div.serial-contents ul.series-table-list > li.subpage-table-list-item > a',
      );
      for (const anchor of anchors) {
        const id = this.getRootRelativeOrAbsoluteLink(anchor, pageUrl);
        if (seen.has(id)) {
          continue;
        }
        seen.add(id);
        mangas.push({
          id,
          title: anchor.querySelector('h4.title')?.textContent?.trim() ?? '',
        });
      }
    }
    return mangas;
  }

  protected override async _getChapters(manga: Manga): Promise<Chapter[]> {
    const mangaUrl = `${this.url}${manga.id}`;
    const feed = await this.fetchDOM(mangaUrl, 'head link[type*="atom+xml"]');
    const feedUrl = new URL(this.getAbsolutePath(feed[0], mangaUrl));
    feedUrl.searchParams.set('free_only', '0');
    const entries = await this.fetchDOM(feedUrl.href, 'feed entry');
    return entries.map((entry) => {
      const title = entry
        .querySelector('title')
        ?.textContent?.replace(manga.title, '')
        .trim();
      return {
        id: this.getRootRelativeOrAbsoluteLink(entry.querySelector('link') ?? '', feedUrl.href),
        title: title || manga.title,
        language: '',
      };
    });
  }

  protected override async _getPages(chapter: Chapter): Promise<PageRef[]> {
    const chapterUrl = `${this.url}${chapter.id}`;
    const dataEl = await this.fetchDOM(chapterUrl, '#episode-json');
    const data = JSON.parse(dataEl[0].getAttribute('data-value') ?? '{}') as CoreViewData;
    const product = data.readableProduct;
    if (!product.isPublic && !product.hasPurchased) {
      throw new Error(`The chapter '${chapter.title}' is neither public, nor purchased!`);
    }
    if (product.pageStructure.choJuGiga === 'baku') {
      throw new Error('Scrambled (baku) chapters are not supported');
    }
    return product.pageStructure.pages
      .filter((page) => page.type === 'main')
      .map((page) => ({ url: this.getAbsolutePath(page.src, chapterUrl) }));
  }
}
