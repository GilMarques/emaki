import { parsePackIndexJson } from './pack-index.model';
import {
  buildPack,
  serializePackIndex,
  sha256Hex,
  type PackSource,
} from './pack-writer';

const encoder = new TextEncoder();

/** A source whose pages are the given strings, one page each. */
function sourceOf(pages: readonly string[], overrides: Partial<PackSource> = {}): PackSource {
  return {
    bookId: 'bk:9f2c',
    title: 'One Piece v01',
    pageCount: pages.length,
    readPage: (index) =>
      Promise.resolve({ bytes: encoder.encode(pages[index]), mime: 'image/webp' }),
    ...overrides,
  };
}

/** SHA-256 of "abc", which every implementation agrees on. */
const SHA_OF_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

describe('buildPack', () => {
  it('lays pages end to end and records where each one starts', async () => {
    const pack = await buildPack(sourceOf(['abc', 'de']), { now: 1_000 });

    expect(pack.index.pages.map((p) => [p.offset, p.length])).toEqual([
      [0, 3],
      [3, 2],
    ]);
    expect(pack.index.packSize).toBe(5);
    expect(pack.index.createdAt).toBe(1_000);
    expect(Array.from(pack.bytes)).toEqual([...encoder.encode('abcde')]);
  });

  it('keeps the first page as the preview file', async () => {
    const pack = await buildPack(sourceOf(['abc', 'de']));

    expect(pack.cover?.file).toBe('cover.webp');
    expect(pack.index.cover).toEqual({ file: 'cover.webp', mime: 'image/webp' });
    expect(new TextDecoder().decode(pack.cover?.bytes)).toBe('abc');
  });

  it('hashes every page so a download can be verified page by page', async () => {
    const pack = await buildPack(sourceOf(['abc']));

    expect(pack.index.pages[0].sha256).toBe(SHA_OF_ABC);
  });

  it('carries the pipeline that produced derivative pages', async () => {
    const pack = await buildPack(sourceOf(['abc']), { model: 'real-esrgan-anime', scale: 2 });

    expect(pack.index.model).toBe('real-esrgan-anime');
    expect(pack.index.scale).toBe(2);
  });

  it('reports progress once per page', async () => {
    const seen: number[] = [];

    await buildPack(sourceOf(['a', 'b', 'c']), { onProgress: (done) => seen.push(done) });

    expect(seen).toEqual([1, 2, 3]);
  });

  it('refuses an empty page instead of writing a zero-length slice', async () => {
    await expectAsync(buildPack(sourceOf(['abc', '']))).toBeRejectedWithError(/Page 2 .* is empty/);
  });

  it('refuses a book larger than the caller allowed', async () => {
    await expectAsync(buildPack(sourceOf(['abcd']), { maxBytes: 3 })).toBeRejectedWithError(
      /larger than 3 bytes/,
    );
  });

  it('stops when the caller aborts', async () => {
    const controller = new AbortController();
    controller.abort();

    await expectAsync(buildPack(sourceOf(['abc']), { signal: controller.signal })).toBeRejected();
  });

  it('refuses a book with no pages', async () => {
    await expectAsync(buildPack(sourceOf([]))).toBeRejectedWithError(/has no pages/);
  });
});

describe('serializePackIndex', () => {
  it('writes an index the reader accepts', async () => {
    const pack = await buildPack(sourceOf(['abc', 'de']), { now: 5 });

    const parsed = parsePackIndexJson(serializePackIndex(pack.index));

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.index.packSize).toBe(5);
    expect(parsed.index.pages.length).toBe(2);
  });
});

describe('sha256Hex', () => {
  it('hashes only the bytes in the view', async () => {
    const backing = encoder.encode('xxabc');
    const view = backing.subarray(2);

    expect(await sha256Hex(view)).toBe(SHA_OF_ABC);
  });
});
