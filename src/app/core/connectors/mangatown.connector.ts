import { Injectable } from '@angular/core';

import { Connector } from './connector.base';
import type { Chapter, Manga, PageRef } from './connector.model';

const DIRECTORY = '/directory';
const PAGE_DELAY_MS = 500;

/**
 * MangaTown provider.
 *
 * Scrapes the site's HTML directory, chapter list and page selector. The page
 * selector's `<option>` values point straight at the chapter images, so no
 * headless-browser round trip (as in HakuNeko) is needed.
 */
@Injectable({ providedIn: 'root' })
export class MangaTownConnector extends Connector {
  public override readonly id = 'mangatown';
  public override readonly label = 'MangaTown';
  public override readonly url = 'https://www.mangatown.com';
  public override readonly tags = ['manga', 'english'] as const;

  protected override async _getMangas(): Promise<Manga[]> {
    const root = await this.fetchDOM(this.url + DIRECTORY + '/', 'div.next-page a:nth-last-child(3)');
    const pageCount = parseInt(root[0]?.textContent?.trim() ?? '', 10);
    if (Number.isNaN(pageCount) || pageCount <= 0) {
      throw new Error('MangaTown: could not determine directory page count');
    }
    const mangas: Manga[] = [];
    for (let page = 1; page <= pageCount; page++) {
      mangas.push(...(await this.getMangaPage(page)));
      await this.wait(PAGE_DELAY_MS);
    }
    return mangas;
  }

  protected override async _getChapters(manga: Manga): Promise<Chapter[]> {
    const url = this.url + manga.id;
    const items = await this.fetchDOM(url, 'ul.chapter_list li');
    return items.map((item) => this.toChapter(item, manga.title, url));
  }

  protected override async _getPages(chapter: Chapter): Promise<PageRef[]> {
    const url = this.getAbsolutePath(chapter.id, this.url);
    const options = await this.fetchDOM(
      url,
      'div.manga_read_footer div.page_select select option',
    );
    return options
      .filter((option) => !option.getAttribute('value')?.endsWith('featured.html'))
      .map((option) => ({
        url: this.getAbsolutePath(option.getAttribute('value') ?? '', url),
      }));
  }

  // ─────────────────────────── Internals ───────────────────────────

  private async getMangaPage(page: number): Promise<Manga[]> {
    const url = `${this.url}${DIRECTORY}/0-0-0-0-0-0/${page}.htm`;
    const links = await this.fetchDOM(url, 'ul.manga_pic_list li p.title a');
    return links.map((link) => ({
      id: this.getRootRelativeOrAbsoluteLink(link, url),
      title: link.getAttribute('title')?.trim() ?? link.textContent?.trim() ?? '',
    }));
  }

  private toChapter(item: Element, mangaTitle: string, baseUrl: string): Chapter {
    const link = item.querySelector('a');
    if (!link) {
      throw new Error('MangaTown: chapter entry is missing its link');
    }
    let title = (link.textContent ?? '').replace(mangaTitle, '').trim();
    const texts = Array.from(item.querySelectorAll('span'));
    for (const span of texts) {
      if (span.getAttribute('class') === 'time') {
        continue;
      }
      const text = span.textContent ?? '';
      if (/^Vol \d+/i.test(text)) {
        title = `[${text}] ${title}`;
      } else {
        title = `${title} ${text}`;
      }
    }
    return {
      id: this.getRootRelativeOrAbsoluteLink(link, baseUrl),
      title,
      language: '',
    };
  }
}
