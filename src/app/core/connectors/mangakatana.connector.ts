import { Injectable } from '@angular/core';

import { Connector } from './connector.base';
import type { Chapter, Manga, PageRef } from './connector.model';

const ROOT = 'https://mangakatana.com';
const PAGE_DELAY_MS = 1000;

/**
 * Matches the inline script that holds the chapter's image list:
 * `var <name> = ['https://i1.mangakatana.com/...', ...];`
 *
 * The page renders `<img data-src="#">` placeholders and lets its own script
 * fill them in, so the real URLs only exist in that array. The variable name
 * changes between pages, hence the generic capture.
 */
const IMAGE_ARRAY = /var\s+\w+\s*=\s*\[([^\]]*)\]/;

/**
 * MangaKatana provider — plain HTML scrape of the public manga list,
 * chapter tables and the inline page-image list. Adapted from HakuNeko's
 * `MangaKatana.mjs` (public domain).
 *
 * HakuNeko needed a headless browser to read the lazily-filled `data-src`
 * images; here the URLs are read straight out of the inline script that
 * fills them, which is the same data without the browser round trip.
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

  /**
   * The site filters server-side: `GET https://mangakatana.com?search=…`
   * with `search_by=m_name`. Scanning the catalogue page by page would take
   * over twenty minutes for the full list.
   */
  protected override async _search(query: string): Promise<Manga[]> {
    const term = query.trim();
    if (!term) return this._getMangas();
    const url = new URL(ROOT);
    url.searchParams.set('search', term);
    url.searchParams.set('search_by', 'm_name');
    const data = await this.fetchDOM(url.href, 'div#book_list div.item div.text h3.title a');
    return data.map((element) => ({
      id: this.getRootRelativeOrAbsoluteLink(element, ROOT),
      title: element.textContent?.trim() ?? '',
    }));
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
    const html = await this.requests.fetchText(this.getAbsolutePath(chapter.id, ROOT), this.headers());
    return this.parsePageImages(html).map((url) => ({ url }));
  }

  // ─────────────────────────── Internals ───────────────────────────

  /**
   * Pull the chapter's image URLs out of the inline script.
   *
   * The page holds two such arrays: a single-URL preview and the full page
   * list. The longer one is the page list, and its length matches the
   * `data-pages` attribute of the page container.
   */
  private parsePageImages(html: string): string[] {
    let best: string[] = [];
    const arrayPattern = new RegExp(IMAGE_ARRAY.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = arrayPattern.exec(html)) !== null) {
      const urls = this.parseUrlList(match[1]);
      if (urls.length === 0) continue;
      if (!urls[0].includes('mangakatana.com')) continue;
      if (urls.length > best.length) {
        best = urls;
      }
    }
    return best;
  }

  /** Pull the quoted URLs out of a JS array literal. */
  private parseUrlList(body: string): string[] {
    const urls: string[] = [];
    const urlPattern = /'([^']+)'/g;
    let match: RegExpExecArray | null;
    while ((match = urlPattern.exec(body)) !== null) {
      urls.push(match[1]);
    }
    return urls;
  }

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
