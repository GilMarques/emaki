import { TestBed } from '@angular/core/testing';

import { ConnectorRequestService } from './connector-request.service';
import { MangaDexConnector } from './mangadex.connector';

const MANGA_ID = '11111111-1111-4111-8111-111111111111';
const COVER_ID = '22222222-2222-4222-8222-222222222222';
const CHAPTER_ID = '33333333-3333-4333-8333-333333333333';

function mangaResponse(title: string, fileName?: string): string {
  return JSON.stringify({
    data: [
      {
        id: MANGA_ID,
        attributes: { title: { en: title } },
        relationships: fileName ? [{ id: COVER_ID, type: 'cover_art', attributes: { fileName } }] : [],
      },
    ],
    limit: 100,
    offset: 0,
    total: 1,
  });
}

function chapterResponse(count: number, total = count): string {
  return JSON.stringify({
    data: Array.from({ length: count }, (_, i) => ({
      id: `${CHAPTER_ID.slice(0, -1)}${i}`,
      attributes: {
        chapter: String(i + 1),
        title: `Chapter title ${i + 1}`,
        translatedLanguage: 'en',
      },
      relationships: [{ id: 'gg', type: 'scanlation_group', attributes: { name: 'Team X' } }],
    })),
    total,
  });
}

describe('MangaDexConnector', () => {
  let requests: jasmine.SpyObj<ConnectorRequestService>;
  let connector: MangaDexConnector;

  beforeEach(() => {
    requests = jasmine.createSpyObj<ConnectorRequestService>('ConnectorRequestService', [
      'fetchText',
      'fetchJson',
      'fetchImage',
    ]);
    TestBed.configureTestingModule({
      providers: [{ provide: ConnectorRequestService, useValue: requests }],
    });
    connector = TestBed.inject(MangaDexConnector);
  });

  it('maps the manga list including cover thumbnails', async () => {
    requests.fetchJson.and.resolveTo(JSON.parse(mangaResponse('Berserk', 'cover.jpg')) as never);
    const mangas = await connector.getMangas();
    expect(mangas).toEqual([
      {
        id: MANGA_ID,
        title: 'Berserk',
        coverUrl: `https://uploads.mangadex.org/covers/${MANGA_ID}/cover.jpg.256.jpg`,
      },
    ]);
  });

  it('maps manga without a cover to a bare record', async () => {
    requests.fetchJson.and.resolveTo(JSON.parse(mangaResponse('No Cover')) as never);
    const [manga] = await connector.getMangas();
    expect(manga.coverUrl).toBeUndefined();
  });

  it('sends the title filter when searching', async () => {
    requests.fetchJson.and.resolveTo(JSON.parse(mangaResponse('Vagabond')) as never);
    await connector.search('vag');
    const url = requests.fetchJson.calls.mostRecent().args[0] as string;
    expect(url).toContain('/manga?');
    expect(url).toContain('title=vag');
  });

  it('maps chapters with scanlation group annotations', async () => {
    requests.fetchJson.and.resolveTo(JSON.parse(chapterResponse(1)) as never);
    const chapters = await connector.getChapters({ id: MANGA_ID, title: 'Berserk' });
    expect(chapters).toEqual([
      {
        id: CHAPTER_ID.slice(0, -1) + '0',
        title: 'Ch. 1 - Chapter title 1 - [Team X]',
        language: 'en',
      },
    ]);
  });

  it('paginates the feed until the last page', async () => {
    const calls: string[] = [];
    requests.fetchJson.and.callFake((url: string) => {
      calls.push(url);
      return Promise.resolve(JSON.parse(chapterResponse(calls.length === 1 ? 100 : 5, 105)) as never);
    });
    const chapters = await connector.getChapters({ id: MANGA_ID, title: 'Berserk' });
    expect(calls).toHaveSize(2);
    expect(chapters).toHaveSize(105);
  });

  it('maps at-home image URLs from the page list', async () => {
    requests.fetchJson.and.resolveTo(
      JSON.parse(
        JSON.stringify({
          baseUrl: 'https://uploads.mangadex.org',
          chapter: { hash: 'abc123', data: ['p1.png', 'p2.png'] },
        }),
      ) as never,
    );
    const pages = await connector.getPages({ id: CHAPTER_ID, title: 'Ch. 1' });
    expect(pages).toEqual([
      { url: 'https://uploads.mangadex.org/data/abc123/p1.png' },
      { url: 'https://uploads.mangadex.org/data/abc123/p2.png' },
    ]);
  });
});