import { Injectable } from '@angular/core';

import { Connector } from './connector.base';
import type { Chapter, Manga, PageRef } from './connector.model';

const ROOT = 'https://mangakatana.com';
const PAGE_DELAY_MS = 1000;

/**
 * MangaKatana provider — plain HTML scrape of the public manga list,
 * chapter tables and lazy-loaded page images. Adapted from HakuNeko's
 * `MangaKatana.mjs` (public domain); the headless-browser wait for the lazy
 * `data-src` images is replaced by reading the attribute straight from the
 * raw HTML.
 */
@Injectable({ providedIn: 'root' })
export class MangaKatanaConnector extends Connector {
  public override readonly id = 'mangakatana';
  public override readonly label = 'MangaKatana';
  public override readonly url = ROOT;
  public override readonly tags = ['manga', 'english'] as const;

  protected override async _getMangas(): Promise<Manga[]> {
    const pages = await this.fetchDOM(
      `${ROOT}/manga`,
      'div#book_list ul.uk-pagination li:nth-last-of-type(2) a',
    );
    const match = pages[0]?.getAttribute('href')?.match(/\/(\d+)$/);
    if (!match) {
      return [];
    }
    const mangas: Manga[] = [];
    for (let page = 1; page <= Number(match[1]); page++) {
      mangas.push(...(await this.getMangaPage(page)));
      if (page < Number(match[1])) {
        await this.wait(PAGE_DELAY_MS);
      }
    }
    return mangas;
  }

  protected override async _getChapters(manga: Manga): Promise<Chapter[]> {
    const data = await this.fetchDOM(
      this.getAbsolutePath(manga.id, ROOT),
      'div.chapters table tbody tr td div.chapter a',
    );
    return data.map((element) => ({
      id: this.getRootRelativeOrAbsoluteLink(element, ROOT),
      title: element.textContent?.trim() ?? '',
    }));
  }

  protected override async _getPages(chapter: Chapter): Promise<PageRef[]> {
    const imgs = await this.fetchDOM(
      this.getAbsolutePath(chapter.id, ROOT),
      '#imgs .wrap_img img[data-src]',
    );
    return imgs.map((img) => ({
      url: this.getAbsolutePath(img.getAttribute('data-src') ?? '', ROOT),
    }));
  }

  // ─────────────────────────── Internals ───────────────────────────

  private async getMangaPage(page: number): Promise<Manga[]> {
    const data = await this.fetchDOM(
      `${ROOT}/manga/page/${page}?filter=1`,
      'div#book_list div.item div.text h3.title a',
    );
    return data.map((element) => ({
      id: this.getRootRelativeOrAbsoluteLink(element, ROOT),
      title: element.textContent?.trim() ?? '',
    }));
  }
}
