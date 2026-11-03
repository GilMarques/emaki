import { TestBed } from '@angular/core/testing';

import type { Book } from '../models/book.model';
import type { FileSystemBrowser } from '../native/file-system-browser.port';
import { FILE_SYSTEM_BROWSER } from '../native/file-system-browser.port';
import { BlobNotFoundError } from './blob-store.port';
import type { BlobDownloadOptions, BlobEntry, BlobSink, BlobStore } from './blob-store.port';
import { parsePackIndexJson } from './pack-index.model';
import { PackPublisherService } from './pack-publisher.service';

class FakeStore implements BlobStore {
  public readonly id = 'fake';
  public readonly files = new Map<string, Uint8Array>();

  public list(prefix = ''): Promise<readonly BlobEntry[]> {
    const keys = [...this.files.keys()].filter((key) => key.startsWith(prefix));
    return Promise.resolve(keys.map((key) => ({ key, size: this.files.get(key)?.length ?? 0, folder: false })));
  }

  public async open(key: string, sink: BlobSink, _options?: BlobDownloadOptions): Promise<void> {
    const bytes = this.files.get(key);
    if (bytes === undefined) throw new BlobNotFoundError(key);
    await sink.write(bytes);
  }

  public put(key: string, data: Uint8Array): Promise<void> {
    this.files.set(key, data);
    return Promise.resolve();
  }

  public remove(key: string): Promise<void> {
    this.files.delete(key);
    return Promise.resolve();
  }
}

function browserWith(files: Readonly<Record<string, Uint8Array>>): FileSystemBrowser {
  return {
    isAvailable: () => true,
    pickDirectory: () => Promise.resolve(null),
    listDirectory: () => Promise.resolve([]),
    readFile: (path) => {
      const bytes = files[path];
      if (bytes === undefined) return Promise.reject(new Error(`Not a file: ${path}`));
      return Promise.resolve(new Blob([bytes as unknown as BlobPart], { type: 'image/webp' }));
    },
    stat: () => Promise.resolve(null),
    openArchive: () => Promise.reject(new Error('Archives are not supported')),
    cleanupArchive: () => Promise.resolve(),
  };
}

function folderBook(id: string, title: string, pages: readonly string[]): Book {
  return {
    id,
    title,
    source: { type: 'folder', uri: `/Library/${title}` },
    pages: pages.map((url, index) => ({ index, url })),
  };
}

function presetBook(): Book {
  return {
    id: 'preset-1',
    title: 'Sample',
    source: { type: 'preset', basePath: '' },
    pages: [{ index: 0, url: 'sample/001.jpg' }],
  };
}

function publisherWith(files: Readonly<Record<string, Uint8Array>>): PackPublisherService {
  TestBed.configureTestingModule({
    providers: [{ provide: FILE_SYSTEM_BROWSER, useValue: browserWith(files) }],
  });
  return TestBed.inject(PackPublisherService);
}

describe('PackPublisherService', () => {
  const pages = {
    '/lib/001.webp': new TextEncoder().encode('one'),
    '/lib/002.webp': new TextEncoder().encode('two'),
  };

  it('writes the pack first and the index second', async () => {
    const publisher = publisherWith(pages);
    const store = new FakeStore();

    await publisher.publish([folderBook('bk:a', 'Akira', ['/lib/001.webp', '/lib/002.webp'])], store);

    const index = store.files.get('bk-a/index.json');
    expect(index).toBeDefined();
    expect(store.files.get('bk-a/pages.pack')?.length).toBe(6);
    const parsed = parsePackIndexJson(new TextDecoder().decode(index));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.index.pages.length).toBe(2);
    expect(parsed.index.bookId).toBe('bk:a');
  });

  it('skips books whose pages are not on disk', async () => {
    const publisher = publisherWith(pages);
    const store = new FakeStore();

    await publisher.publish([presetBook()], store);

    expect(store.files.size).toBe(0);
    expect(publisher.published()).toBe(0);
  });

  it('counts what it published and leaves no progress behind', async () => {
    const publisher = publisherWith(pages);
    const store = new FakeStore();

    await publisher.publish([folderBook('bk:a', 'Akira', ['/lib/001.webp'])], store);

    expect(publisher.published()).toBe(1);
    expect(publisher.progress()).toBeNull();
    expect(publisher.publishing()).toBe(false);
  });

  it('reports a store failure instead of throwing at the caller', async () => {
    const publisher = publisherWith(pages);
    const store = new FakeStore();
    store.put = () => Promise.reject(new Error('MEGA’s transfer quota is exhausted.'));

    await publisher.publish([folderBook('bk:a', 'Akira', ['/lib/001.webp'])], store);

    expect(publisher.error()).toContain('quota');
    expect(publisher.publishing()).toBe(false);
  });

  it('publishes only folder-backed books when the shelf is mixed', () => {
    const publisher = publisherWith(pages);

    const publishable = publisher.publishable([
      folderBook('bk:a', 'Akira', ['/lib/001.webp']),
      presetBook(),
    ]);

    expect(publishable.map((b) => b.id)).toEqual(['bk:a']);
  });
});
