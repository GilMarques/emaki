import {
  PACK_INDEX_VERSION,
  indexPathFor,
  packFolderFor,
  packPathFor,
  parsePackIndexJson,
  validatePackIndex,
  type PackIndex,
} from './pack-index.model';

/** A well-formed index with the given page sizes, laid end to end. */
function indexJson(sizes: readonly number[]): string {
  let offset = 0;
  const pages = sizes.map((length) => {
    const page = { offset, length, sha256: 'a'.repeat(64), mime: 'image/webp' };
    offset += length;
    return page;
  });
  return JSON.stringify({
    v: PACK_INDEX_VERSION,
    bookId: 'bk:9f2c',
    title: 'One Piece v01',
    pages,
    packSize: offset,
    createdAt: 1,
  });
}

describe('parsePackIndexJson', () => {
  it('reads a well-formed index', () => {
    const result = parsePackIndexJson(indexJson([4, 6]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.index.bookId).toBe('bk:9f2c');
    expect(result.index.pages.length).toBe(2);
    expect(result.index.pages[1]).toEqual({
      offset: 4,
      length: 6,
      sha256: 'a'.repeat(64),
      mime: 'image/webp',
    });
    expect(result.index.packSize).toBe(10);
  });

  it('keeps the derivative fields when the pages were enhanced', () => {
    const raw = { ...JSON.parse(indexJson([3])), model: 'real-esrgan-anime', scale: 2 };

    const result = validatePackIndex(raw);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.index.model).toBe('real-esrgan-anime');
    expect(result.index.scale).toBe(2);
  });

  it('rejects an index written by a newer version', () => {
    const raw = { ...JSON.parse(indexJson([3])), v: 2 };

    const result = validatePackIndex(raw);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('version');
  });

  it('rejects pages that do not continue where the previous one ended', () => {
    const raw = JSON.parse(indexJson([4, 6])) as PackIndex & { pages: { offset: number }[] };
    raw.pages[1].offset = 5;

    const result = validatePackIndex(raw);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('Page 2 starts at 5 but page 1 ends at 4');
  });

  it('rejects a pack shorter than its pages', () => {
    const raw = { ...JSON.parse(indexJson([4, 6])), packSize: 8 };

    const result = validatePackIndex(raw);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('8 bytes but its pages add up to 10');
  });

  it('rejects a page without a hex digest', () => {
    const raw = JSON.parse(indexJson([4])) as { pages: { sha256: string }[] };
    raw.pages[0].sha256 = 'not-a-digest';

    const result = validatePackIndex(raw);

    expect(result.ok).toBe(false);
  });

  it('rejects an index with no pages', () => {
    const result = parsePackIndexJson(indexJson([]));

    expect(result.ok).toBe(false);
  });

  it('rejects text that is not JSON', () => {
    const result = parsePackIndexJson('<html>');

    expect(result.ok).toBe(false);
  });
});

describe('pack layout', () => {
  it('sanitises a book id into a folder name', () => {
    expect(packFolderFor('bk:9f2c1a')).toBe('bk-9f2c1a');
    expect(packFolderFor('dl:mangadex:abc-123')).toBe('dl-mangadex-abc-123');
  });

  it('builds the pack and index paths under that folder', () => {
    expect(packPathFor('bk:9f2c')).toBe('bk-9f2c/pages.pack');
    expect(indexPathFor('bk:9f2c')).toBe('bk-9f2c/index.json');
  });

  it('refuses an id with nothing usable in it', () => {
    expect(() => packFolderFor(':::')).toThrowError(/at least one letter or digit/);
  });
});
