import { TestBed } from '@angular/core/testing';

import { ConnectorRequestService } from './connector-request.service';
import { MangaTownConnector } from './mangatown.connector';

const MANGA_ID = '/manga/jujutsu_kaisen/';

describe('MangaTownConnector', () => {
  let requests: jasmine.SpyObj<ConnectorRequestService>;
  let connector: MangaTownConnector;

  beforeEach(() => {
    requests = jasmine.createSpyObj<ConnectorRequestService>('ConnectorRequestService', [
      'fetchText',
      'fetchJson',
      'fetchImage',
    ]);
    TestBed.configureTestingModule({
      providers: [{ provide: ConnectorRequestService, useValue: requests }],
    });
    connector = TestBed.inject(MangaTownConnector);
  });

  it('searches through the site search', async () => {
    requests.fetchText.and.resolveTo(
      `<ul class="manga_pic_list"><li><p class="title">
        <a href="/manga/jujutsu_kaisen/" title="Jujutsu Kaisen">Jujutsu Kaisen</a>
       </p></li></ul>`,
    );
    const mangas = await connector.search('jujutsu');
    expect(mangas).toEqual([{ id: '/manga/jujutsu_kaisen/', title: 'Jujutsu Kaisen' }]);
    const url = requests.fetchText.calls.mostRecent().args[0] as string;
    expect(url).toContain('https://www.mangatown.com/search?');
    expect(url).toContain('name=jujutsu');
  });

  it('resolves the page images behind the page selector', async () => {
    const chapterPage = `<div class="manga_read_footer"><div class="page_select"><select>
        <option value="/manga/jujutsu_kaisen/c119/">1</option>
        <option value="/manga/jujutsu_kaisen/c119/2.html">2</option>
        <option value="/manga/jujutsu_kaisen/c119/featured.html">featured</option>
      </select></div></div>
      <img id="image" src="//zjcdn.mangahere.org/store/manga/29763/119.0/compressed/r000.jpg">`;
    requests.fetchText.and.callFake((url: string) => {
      if (url.includes('/c119/2.html')) {
        return Promise.resolve('<img id="image" src="//zjcdn.mangahere.org/store/manga/29763/119.0/compressed/r001.jpg">');
      }
      return Promise.resolve(chapterPage);
    });

    const pages = await connector.getPages({ id: '/manga/jujutsu_kaisen/c119/', title: 'Chapter 119' });
    expect(pages).toEqual([
      { url: 'https://zjcdn.mangahere.org/store/manga/29763/119.0/compressed/r000.jpg' },
      { url: 'https://zjcdn.mangahere.org/store/manga/29763/119.0/compressed/r001.jpg' },
    ]);
  });
});
