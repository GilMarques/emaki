import { TestBed } from '@angular/core/testing';

import { ComicKConnector } from './comick.connector';
import { ConnectorRequestService } from './connector-request.service';

const MANGA_ID = '1J46csio';
const CHAPTER_ID = 'alQjK3WH';

describe('ComicKConnector', () => {
  let requests: jasmine.SpyObj<ConnectorRequestService>;
  let connector: ComicKConnector;

  beforeEach(() => {
    requests = jasmine.createSpyObj<ConnectorRequestService>('ConnectorRequestService', [
      'fetchText',
      'fetchJson',
      'fetchImage',
    ]);
    TestBed.configureTestingModule({
      providers: [{ provide: ConnectorRequestService, useValue: requests }],
    });
    connector = TestBed.inject(ComicKConnector);
  });

  it('maps the search results', async () => {
    requests.fetchJson.and.callFake(() =>
      Promise.resolve(
        requests.fetchJson.calls.count() === 1
          ? ([{ hid: MANGA_ID, title: 'Naruto ' }] as never)
          : ([] as never),
      ),
    );
    const mangas = await connector.search('naruto');
    expect(mangas).toEqual([{ id: MANGA_ID, title: 'Naruto' }]);
    const url = requests.fetchJson.calls.mostRecent().args[0] as string;
    expect(url).toContain('https://api.comick.dev/v1.0/search');
    expect(url).toContain('q=naruto');
  });

  it('maps chapters with their group names', async () => {
    requests.fetchJson.and.callFake(() =>
      Promise.resolve(
        requests.fetchJson.calls.count() === 1
          ? ({
              chapters: [
                { hid: CHAPTER_ID, chap: '700.5', title: null, vol: null, lang: 'en', group_name: ['Team X'] },
              ],
            } as never)
          : ({ chapters: [] } as never),
      ),
    );
    const chapters = await connector.getChapters({ id: MANGA_ID, title: 'Naruto' });
    expect(chapters).toEqual([
      { id: CHAPTER_ID, title: 'Ch. 700.5 (en) [Team X]', language: 'en' },
    ]);
    const url = requests.fetchJson.calls.mostRecent().args[0] as string;
    expect(url).toContain(`/v1.0/comic/${MANGA_ID}/chapters`);
  });

  it('turns image keys into CDN urls', async () => {
    requests.fetchJson.and.resolveTo({
      chapter: { md_images: [{ b2key: '0-abc.png', gpurl: null, url: null }] },
    } as never);
    const pages = await connector.getPages({ id: CHAPTER_ID, title: 'Ch. 1' });
    expect(pages).toEqual([{ url: 'https://meo.comick.pictures/0-abc.png' }]);
    const url = requests.fetchJson.calls.mostRecent().args[0] as string;
    expect(url).toContain(`https://api.comick.dev/chapter/${CHAPTER_ID}`);
  });

  it('prefers an absolute image url over the key', async () => {
    requests.fetchJson.and.resolveTo({
      chapter: {
        md_images: [{ b2key: '0-abc.png', gpurl: 'https://tmp2.comick.pictures/x/0.png', url: null }],
      },
    } as never);
    const pages = await connector.getPages({ id: CHAPTER_ID, title: 'Ch. 1' });
    expect(pages).toEqual([{ url: 'https://tmp2.comick.pictures/x/0.png' }]);
  });
});
