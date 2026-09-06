import { TestBed } from '@angular/core/testing';

import { Connector } from './connector.base';
import { ConnectorRequestService } from './connector-request.service';
import type { Chapter, Manga, PageRef } from './connector.model';

class ExposedConnector extends Connector {
  public override readonly id = 'test';
  public override readonly label = 'Test';
  public override readonly url = 'https://example.org';

  protected override async _getMangas(): Promise<Manga[]> {
    return [];
  }
  protected override async _getChapters(_manga: Manga): Promise<Chapter[]> {
    return [];
  }
  protected override async _getPages(_chapter: Chapter): Promise<PageRef[]> {
    return [];
  }

  public fetchDom(url: string, selector: string, headers?: Record<string, string>): Promise<Element[]> {
    return this.fetchDOM(url, selector, headers);
  }
  public fetchReg(url: string, regex: RegExp): Promise<string[]> {
    return this.fetchRegex(url, regex);
  }
  public absolute(reference: string | Element, base: string): string {
    return this.getAbsolutePath(reference, base);
  }
  public rootRelative(reference: string | Element, base: string): string {
    return this.getRootRelativeOrAbsoluteLink(reference, base);
  }
  public waitFor(ms: number): Promise<void> {
    return this.wait(ms);
  }
}

describe('Connector', () => {
  let requests: jasmine.SpyObj<ConnectorRequestService>;
  let connector: ExposedConnector;

  beforeEach(() => {
    requests = jasmine.createSpyObj<ConnectorRequestService>('ConnectorRequestService', [
      'fetchText',
      'fetchJson',
      'fetchImage',
    ]);
    TestBed.configureTestingModule({
      providers: [{ provide: ConnectorRequestService, useValue: requests }],
    });
    connector = TestBed.runInInjectionContext(() => new ExposedConnector());
  });

  it('parses HTML and selects elements with fetchDOM', async () => {
    requests.fetchText.and.resolveTo('<html><body><ul><li class="manga">A</li><li class="manga">B</li></ul></body></html>');
    const items = await connector.fetchDom('https://example.org/list', 'li.manga');
    expect(items.map((el) => el.textContent)).toEqual(['A', 'B']);
  });

  it('extracts capturing-group matches with fetchRegex', async () => {
    requests.fetchText.and.resolveTo('aX1b aX22c aX333d');
    const result = await connector.fetchReg('https://example.org', /a(X\d+)/g);
    expect(result).toEqual(['X1', 'X22', 'X333']);
  });

  it('rejects fetchRegex without the global flag', async () => {
    await expectAsync(connector.fetchReg('https://example.org', /a(X\d+)/)).toBeRejectedWithError(
      'The provided RegExp must contain the global "g" modifier!',
    );
  });

  it('resolves absolute paths against the base URL', () => {
    expect(connector.absolute('/manga/1', 'https://example.org/dir/page')).toBe(
      'https://example.org/manga/1',
    );
    expect(connector.absolute('https://cdn.example.org/img.png', 'https://example.org')).toBe(
      'https://cdn.example.org/img.png',
    );
  });

  it('returns root-relative links for same-domain and absolute for cross-domain', () => {
    expect(connector.rootRelative('/manga/1', 'https://example.org')).toBe('/manga/1');
    expect(connector.rootRelative('https://cdn.example.org/img.png', 'https://example.org')).toBe(
      'https://cdn.example.org/img.png',
    );
  });

  it('waits for the requested duration', async () => {
    const start = Date.now();
    await connector.waitFor(10);
    expect(Date.now() - start).toBeGreaterThanOrEqual(10);
  });

  it('merges per-request headers over the connector defaults', async () => {
    requests.fetchText.and.resolveTo('<html></html>');
    await connector.fetchDom('https://example.org', 'a', { 'x-custom': '1' });
    const url = requests.fetchText.calls.mostRecent().args[0];
    const headers = requests.fetchText.calls.mostRecent().args[1];
    expect(url).toBe('https://example.org');
    expect(headers?.['x-custom']).toBe('1');
    expect(headers?.['accept']).toBeDefined();
  });
});