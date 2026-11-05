import { ConnectorRequestService } from './connector-request.service';

describe('ConnectorRequestService', () => {
  let service: ConnectorRequestService;
  let fetchSpy: jasmine.Spy;

  /** The URL the service is expected to hand to `fetch` for a target. */
  function proxied(target: string): string {
    return `http://127.0.0.1:4300/?url=${encodeURIComponent(target)}`;
  }

  beforeEach(() => {
    service = new ConnectorRequestService();
    fetchSpy = spyOn(window, 'fetch');
  });

  it('fetches text on 2xx', async () => {
    fetchSpy.and.resolveTo(new Response('hello', { status: 200 }));
    await expectAsync(service.fetchText('https://example.org/a')).toBeResolvedTo('hello');
    expect(fetchSpy).toHaveBeenCalledWith(proxied('https://example.org/a'), jasmine.any(Object));
  });

  it('rejects on non-2xx status', async () => {
    fetchSpy.and.resolveTo(new Response('nope', { status: 404 }));
    await expectAsync(service.fetchText('https://example.org/a')).toBeRejectedWithError(
      'Failed to fetch "https://example.org/a" (status: 404)',
    );
  });

  it('parses JSON bodies', async () => {
    fetchSpy.and.resolveTo(new Response('{"ok":true}', { status: 200 }));
    await expectAsync(service.fetchJson<{ ok: boolean }>('https://example.org/a')).toBeResolvedTo({
      ok: true,
    });
  });

  it('drops the user-agent header the browser would refuse to send', async () => {
    fetchSpy.and.resolveTo(new Response('hello', { status: 200 }));
    await service.fetchText('https://example.org/a', {
      'user-agent': 'Mozilla/5.0',
      accept: 'text/html',
    });
    const headers = fetchSpy.calls.mostRecent().args[1]?.headers as Record<string, string>;
    expect(headers['user-agent']).toBeUndefined();
    expect(headers['accept']).toBe('text/html');
  });

  it('sniffs the real mime type of a binary body', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    fetchSpy.and.resolveTo(new Response(png, { status: 200, headers: { 'content-type': 'application/octet-stream' } }));
    const blob = await service.fetchImage('https://example.org/page.png');
    expect(blob.type).toBe('image/png');
  });

  it('routes MangaDex cover images through the proxy', () => {
    const cover =
      'https://uploads.mangadex.org/covers/4a973243-952e-44d7-a50f-883b4b7c9cc2/9adafa19-0424-4677-aab4-93a07a01a591.jpg.256.jpg';
    expect(service.imageSrc(cover)).toBe(proxied(cover));
    expect(service.imageSrc('https://uploads.mangadex.org/data/abc/p1.png')).toBe(
      proxied('https://uploads.mangadex.org/data/abc/p1.png'),
    );
    expect(service.imageSrc('https://cmdxd98sb0x3yprd.mangadex.network/data/abc/p1.png')).toBe(
      proxied('https://cmdxd98sb0x3yprd.mangadex.network/data/abc/p1.png'),
    );
  });

  it('leaves non-MangaDex image URLs untouched', () => {
    expect(service.imageSrc('https://example.org/cover.jpg')).toBe('https://example.org/cover.jpg');
    expect(service.imageSrc('blob:http://localhost/abc')).toBe('blob:http://localhost/abc');
  });

  it('falls back to octet-stream when the signature is unknown', async () => {
    fetchSpy.and.resolveTo(new Response(new Uint8Array([0x00, 0x01, 0x02]), { status: 200 }));
    const blob = await service.fetchImage('https://example.org/page.bin');
    expect(blob.type).toBe('application/octet-stream');
  });
});
