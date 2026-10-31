import { TestBed } from '@angular/core/testing';

import { ConnectorRequestService } from './connector-request.service';
import { NaverConnector } from './naver.connector';

const TITLE_ID = '651673';

describe('NaverConnector', () => {
  let requests: jasmine.SpyObj<ConnectorRequestService>;
  let connector: NaverConnector;

  beforeEach(() => {
    requests = jasmine.createSpyObj<ConnectorRequestService>('ConnectorRequestService', [
      'fetchText',
      'fetchJson',
      'fetchImage',
    ]);
    TestBed.configureTestingModule({
      providers: [{ provide: ConnectorRequestService, useValue: requests }],
    });
    connector = TestBed.inject(NaverConnector);
  });

  it('maps the search results', async () => {
    requests.fetchText.and.resolveTo(
      `<a href="/webtoon/list?titleId=${TITLE_ID}">
         <span class="im_br"><img src="https://image-comic.pstatic.net/webtoon/${TITLE_ID}/thumb.jpg"></span>
         <div class="toon_info"><h4><span class="toon_name"><strong>유미의 세포들</strong></span></h4></div>
       </a>`,
    );
    const mangas = await connector.search('유미의 세포들');
    expect(mangas).toEqual([
      {
        id: TITLE_ID,
        title: '유미의 세포들',
        coverUrl: `https://image-comic.pstatic.net/webtoon/${TITLE_ID}/thumb.jpg`,
      },
    ]);
    const url = requests.fetchText.calls.mostRecent().args[0] as string;
    expect(url).toContain('https://m.comic.naver.com/search/result?');
    expect(url).toContain('searchType=WEBTOON');
  });

  it('maps the episode list', async () => {
    requests.fetchText.and.resolveTo(
      `<a class="link" href="/webtoon/detail?titleId=${TITLE_ID}&no=1&week=sat">
         <div class="info"><strong class="title"><span class="name"><strong>오프닝</strong></span></strong></div>
       </a>`,
    );
    const chapters = await connector.getChapters({ id: TITLE_ID, title: '유미의 세포들' });
    expect(chapters).toEqual([{ id: `${TITLE_ID}:1`, title: '오프닝' }]);
  });

  it('maps the page images', async () => {
    requests.fetchText.and.resolveTo(
      `<img data-src="https://image-comic.pstatic.net/mobilewebimg/${TITLE_ID}/1/a_001.jpg">
       <img data-src="https://image-comic.pstatic.net/mobilewebimg/${TITLE_ID}/1/a_002.jpg">`,
    );
    const pages = await connector.getPages({ id: `${TITLE_ID}:1`, title: '오프닝' });
    expect(pages).toEqual([
      { url: `https://image-comic.pstatic.net/mobilewebimg/${TITLE_ID}/1/a_001.jpg` },
      { url: `https://image-comic.pstatic.net/mobilewebimg/${TITLE_ID}/1/a_002.jpg` },
    ]);
  });
});
