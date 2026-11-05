import { TestBed } from '@angular/core/testing';

import { LibrarySeriesService } from './library-series.service';

describe('LibrarySeriesService', () => {
  let service: LibrarySeriesService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({});
    service = TestBed.inject(LibrarySeriesService);
  });

  it('adds a folder and ignores a second pick of the same path', () => {
    service.add({ path: '/series/a', name: 'A' });
    service.add({ path: '/series/a', name: 'A again' });
    service.add({ path: '/series/b', name: 'B' });

    expect(service.series()).toEqual([
      { path: '/series/a', name: 'A' },
      { path: '/series/b', name: 'B' },
    ]);
  });

  it('removes one series and leaves the rest', () => {
    service.add({ path: '/series/a', name: 'A' });
    service.add({ path: '/series/b', name: 'B' });
    service.remove('/series/a');

    expect(service.series()).toEqual([{ path: '/series/b', name: 'B' }]);
  });

  it('adopts a legacy content URI as the first series', () => {
    localStorage.setItem('openviewer:library-root', 'content://tree/primary%3AComics');
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({});
    const adopted = TestBed.inject(LibrarySeriesService);

    expect(adopted.series()).toEqual([{ path: 'content://tree/primary%3AComics', name: 'Comics' }]);
    expect(localStorage.getItem('openviewer:library-root')).toBeNull();
    expect(JSON.parse(localStorage.getItem('openviewer:library-series') ?? '[]')).toEqual([
      { path: 'content://tree/primary%3AComics', name: 'Comics' },
    ]);
  });
});
