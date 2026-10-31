import { TestBed } from '@angular/core/testing';

import { ConnectorRequestService } from './connector-request.service';
import { MangaKatanaConnector } from './mangakatana.connector';

const CHAPTER_ID = '/manga/naruto.1205/c1';

/** A chapter page as MangaKatana serves it: the images live in an inline script. */
function chapterPage(images: readonly string[], preview: string[] = []): string {
  const list = (urls: readonly string[]) => `[${urls.map((u) => `'${u}'`).join(',')}]`;
  return `<html><body>
    <script>var ytaw=${list(preview)};var thzq=${list(images)};var cds=["1240x1754"];</script>
  </body></html>`;
}

describe('MangaKatanaConnector', () => {
  let requests: jasmine.SpyObj<ConnectorRequestService>;
  let connector: MangaKatanaConnector;

  beforeEach(() => {
    requests = jasmine.createSpyObj<ConnectorRequestService>('ConnectorRequestService', [
      'fetchText',
      'fetchJson',
      'fetchImage',
    ]);
    TestBed.configureTestingModule({
      providers: [{ provide: ConnectorRequestService, useValue: requests }],
    });
    connector = TestBed.inject(MangaKatanaConnector);
  });

  it('reads the page images out of the inline script', async () => {
    requests.fetchText.and.resolveTo(
      chapterPage(['https://i1.mangakatana.com/token/a/0.jpg', 'https://i1.mangakatana.com/token/b/1.jpg']),
    );
    const pages = await connector.getPages({ id: CHAPTER_ID, title: 'Chapter 1' });
    expect(pages).toEqual([
      { url: 'https://i1.mangakatana.com/token/a/0.jpg' },
      { url: 'https://i1.mangakatana.com/token/b/1.jpg' },
    ]);
  });

  it('prefers the full image list over the single-image preview', async () => {
    requests.fetchText.and.resolveTo(
      chapterPage(
        ['https://i1.mangakatana.com/token/a/0.jpg', 'https://i1.mangakatana.com/token/b/1.jpg'],
        ['https://i1.mangakatana.com/token/a/0.jpg'],
      ),
    );
    const pages = await connector.getPages({ id: CHAPTER_ID, title: 'Chapter 1' });
    expect(pages).toHaveSize(2);
  });

  it('ignores script arrays that hold no page images', async () => {
    requests.fetchText.and.resolveTo(chapterPage(['https://i1.mangakatana.com/token/a/0.jpg']));
    const pages = await connector.getPages({ id: CHAPTER_ID, title: 'Chapter 1' });
    expect(pages).toEqual([{ url: 'https://i1.mangakatana.com/token/a/0.jpg' }]);
  });

  it('searches through the site instead of walking the catalogue', async () => {
    requests.fetchText.and.resolveTo(
      `<div id="book_list"><div class="item"><div class="text"><h3 class="title">
        <a href="https://mangakatana.com/manga/naruto.1205">Naruto</a></h3></div></div></div>`,
    );
    const mangas = await connector.search('naruto');
    expect(mangas).toEqual([{ id: '/manga/naruto.1205', title: 'Naruto' }]);
    const url = requests.fetchText.calls.mostRecent().args[0] as string;
    expect(url).toContain('search=naruto');
    expect(url).toContain('search_by=m_name');
  });
});
