import { Injectable } from '@angular/core';

import { Connector } from './connector.base';
import type { Chapter, Manga, PageRef } from './connector.model';

interface NaverArticleListResponse {
  readonly articleList: readonly {
    readonly no: number;
    readonly subtitle: string;
  }[];
}

/**
 * Naver Webtoon provider (Korean).
 *
 * Naver does not expose a searchable catalogue API, so manga discovery is
 * limited to direct URLs — the browse page will return nothing until a
 * "paste manga URL" flow exists. Chapters and pages come from the public
 * webtoon API + page DOM.
 */
@Injectable({ providedIn: 'root' })
export class NaverConnector extends Connector {
  public override readonly id = 'naver';
  public override readonly label = 'Naver Webtoon';
  public override readonly url = 'https://comic.naver.com';
  public override readonly tags = ['webtoon', 'korean'] as const;

  protected override async _getMangas(): Promise<Manga[]> {
    return [];
  }

  protected override async _getChapters(manga: Manga): Promise<Chapter[]> {
    const chapters: Chapter[] = [];
    let page = 1;
    for (;;) {
      const url = new URL(`/api/article/list?titleId=${manga.id}&page=${page}`, this.url);
      const data = await this.fetchJson<NaverArticleListResponse>(url.href);
      if (!data.articleList.length) break;
      chapters.push(
        ...data.articleList.map((item) => ({
          id: `${manga.id}:${item.no}`,
          title: item.subtitle,
        })),
      );
      page += 1;
    }
    return chapters;
  }

  protected override async _getPages(chapter: Chapter): Promise<PageRef[]> {
    const [titleId, no] = chapter.id.split(':');
    const url = new URL(`/webtoon/detail?titleId=${titleId}&no=${no}`, this.url);
    const nodes = await this.fetchDOM(url.href, 'div#comic_view_area div.wt_viewer source[id^="content_image"]');
    return nodes
      .map((node) => this.getAbsolutePath(node, url.href))
      .filter((url) => Boolean(url))
      .map((url) => ({ url }));
  }
}