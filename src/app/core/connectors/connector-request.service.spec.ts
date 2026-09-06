import { ConnectorRequestService } from './connector-request.service';

describe('ConnectorRequestService', () => {
  let service: ConnectorRequestService;
  let fetchSpy: jasmine.Spy;

  beforeEach(() => {
    service = new ConnectorRequestService();
    fetchSpy = spyOn(window, 'fetch');
  });

  it('fetches text on 2xx', async () => {
    fetchSpy.and.resolveTo(new Response('hello', { status: 200 }));
    await expectAsync(service.fetchText('https://example.org/a')).toBeResolvedTo('hello');
    expect(fetchSpy).toHaveBeenCalledWith('https://example.org/a', jasmine.any(Object));
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

  it('sniffs the real mime type of a binary body', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    fetchSpy.and.resolveTo(new Response(png, { status: 200, headers: { 'content-type': 'application/octet-stream' } }));
    const blob = await service.fetchImage('https://example.org/page.png');
    expect(blob.type).toBe('image/png');
  });

  it('falls back to octet-stream when the signature is unknown', async () => {
    fetchSpy.and.resolveTo(new Response(new Uint8Array([0x00, 0x01, 0x02]), { status: 200 }));
    const blob = await service.fetchImage('https://example.org/page.bin');
    expect(blob.type).toBe('application/octet-stream');
  });
});