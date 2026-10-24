import { HistoryService } from './history.service';
import type { Book } from '../models/book.model';

function makeBook(id: string, pageCount: number): Book {
  return {
    id,
    title: `Book ${id}`,
    coverUrl: `${id}/cover.jpg`,
    source: { type: 'preset', basePath: '' },
    pages: Array.from({ length: pageCount }, (_, index) => ({
      index,
      url: `${id}/page-${index}.jpg`,
    })),
  };
}

describe('HistoryService', () => {
  let service: HistoryService;

  beforeEach(() => {
    localStorage.removeItem('openviewer:history:v1');
    service = new HistoryService();
  });

  afterEach(() => {
    service.clear();
    service.flush();
    localStorage.removeItem('openviewer:history:v1');
  });

  it('records an open with the page it stopped on', () => {
    service.record(makeBook('a', 10), 4);

    const [entry] = service.entries();
    expect(entry.bookId).toBe('a');
    expect(entry.title).toBe('Book a');
    expect(entry.coverUrl).toBe('a/cover.jpg');
    expect(entry.pageIndex).toBe(4);
    expect(entry.pageCount).toBe(10);
  });

  it('clamps an out-of-range page index', () => {
    service.record(makeBook('a', 3), 99);
    expect(service.entries()[0].pageIndex).toBe(2);
  });

  it('moves a reopened book to the top instead of duplicating it', () => {
    service.record(makeBook('a', 5), 1);
    service.record(makeBook('b', 5), 2);
    service.record(makeBook('a', 5), 3);

    expect(service.entries().map((e) => e.bookId)).toEqual(['a', 'b']);
    expect(service.entryFor('a')?.pageIndex).toBe(3);
  });

  it('caps the list at 100 entries, dropping the oldest', () => {
    for (let i = 0; i < 105; i++) service.record(makeBook(`b${i}`, 2), 0);

    expect(service.entries().length).toBe(100);
    expect(service.entries()[0].bookId).toBe('b104');
    expect(service.entryFor('b0')).toBeUndefined();
  });

  it('removes one book and clears the rest', () => {
    service.record(makeBook('a', 2), 0);
    service.record(makeBook('b', 2), 0);

    service.remove('a');
    expect(service.entries().map((e) => e.bookId)).toEqual(['b']);

    service.clear();
    expect(service.entries()).toEqual([]);
  });

  it('survives a reload from storage', () => {
    service.record(makeBook('a', 8), 5);
    service.flush();

    const reloaded = new HistoryService();
    expect(reloaded.entries().length).toBe(1);
    expect(reloaded.entries()[0].pageIndex).toBe(5);
  });

  it('ignores corrupt or malformed stored entries', () => {
    localStorage.setItem(
      'openviewer:history:v1',
      JSON.stringify([{ bookId: 'ok', title: 'Ok', pageIndex: 1, pageCount: 4, readAt: 1 }, { nope: true }]),
    );

    const reloaded = new HistoryService();
    expect(reloaded.entries().length).toBe(1);
    expect(reloaded.entries()[0].bookId).toBe('ok');
  });
});
