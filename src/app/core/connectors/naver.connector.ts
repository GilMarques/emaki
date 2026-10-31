import { Injectable } from '@angular/core';

import { Connector } from './connector.base';
import type { Chapter, Manga, PageRef } from './connector.model';

const ROOT = 'https://m.comic.naver.com';

/**
 * Naver Webtoon provider (Korean).
 *
 * Naver replaced its old `comic.naver.com/api/article/list` JSON API with a
 * server-rendered mobile site, so the connector reads the rendered pages
 * instead: the search result page lists series, the series page lists the
 * episodes, and the episode page carries the page images as `img[data-src]`.
 *
 * The mobile site only exposes the first 30 episodes of a series; the rest
 * live behind the mobile app.
 */
@Injectable({ providedIn: 'root' })
export class NaverConnector extends Connector {
  public override readonly id = 'naver';
  public override readonly label = 'Naver Webtoon';
  public override readonly url = 'https://comic.naver.com';
  public override readonly tags = ['webtoon', 'korean'] as const;

  /** Naver has no browsable catalogue on the web — search is the entry point. */
  protected override async _getMangas(): Promise<Manga[]> {
    return [];
  }

  protected override async _search(query: string): Promise<Manga[]> {
    const term = query.trim();
    if (!term) return [];
    const params = new URLSearchParams();
    params.set('keyword', term);
    params.set('searchType', 'WEBTOON');
    const url = new URL('/search/result', ROOT);
    url.search = params.toString();

    const results = await this.fetchDOM(url.href, 'a[href^="/webtoon/list?titleId="]');
    const mangas: Manga[] = [];
    const seen = new Set<string>();
    for (const element of results) {
      const id = this.titleIdOf(element.getAttribute('href'));
      if (!id || seen.has(id)) continue;
      seen.add(id);
      mangas.push({
        id,
        title: this.textOf(element, '.toon_name strong') ?? element.querySelector('img')?.getAttribute('alt') ?? '',
        coverUrl: element.querySelector('img')?.getAttribute('src') ?? undefined,
      });
    }
    return mangas;
  }

  protected override async _getChapters(manga: Manga): Promise<Chapter[]> {
    const url = new URL(`/webtoon/list?titleId=${manga.id}`, ROOT);
    const items = await this.fetchDOM(url.href, 'a.link[href*="/webtoon/detail?"]');
    return items.map((element) => {
      const no = this.noOf(element.getAttribute('href'));
      return {
        id: `${manga.id}:${no}`,
        title:
          this.textOf(element, '.info .title .name strong') ??
          element.querySelector('img')?.getAttribute('alt') ??
          `Episode ${no}`,
      };
    });
  }

  protected override async _getPages(chapter: Chapter): Promise<PageRef[]> {
    const [titleId, no] = chapter.id.split(':');
    const url = new URL(`/webtoon/detail?titleId=${titleId}&no=${no}`, ROOT);
    const nodes = await this.fetchDOM(url.href, 'img[data-src]');
    return nodes
      .map((node) => node.getAttribute('data-src'))
      .filter((src): src is string => Boolean(src))
      .map((src) => ({ url: this.getAbsolutePath(src, url.href) }));
  }

  // ─────────────────────────── Internals ───────────────────────────

  private titleIdOf(href: string | null): string | null {
    if (!href) return null;
    return /titleId=(\d+)/.exec(href)?.[1] ?? null;
  }

  private noOf(href: string | null): string {
    if (!href) return '';
    return /no=(\d+)/.exec(href)?.[1] ?? '';
  }

  private textOf(element: Element, selector: string): string | undefined {
    const text = element.querySelector(selector)?.textContent?.trim();
    return text && text.length > 0 ? text : undefined;
  }
}
