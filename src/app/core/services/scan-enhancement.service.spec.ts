import { TestBed } from '@angular/core/testing';

import { ScanEnhancementService } from './scan-enhancement.service';
import { BookstoreService } from './bookstore.service';
import { PageAssetService } from './page-asset.service';
import { FilePageService } from './file-page.service';
import { RealEsrganPluginService, type EnhancePageArgs } from '../native/real-esrgan.plugin';
import { SettingsService } from './settings.service';
import { FILE_SYSTEM_BROWSER } from '../native/file-system-browser.port';
import type { Book, Page } from '../models/book.model';
import type { EnhancementCapabilities, EnhancePageResult } from '../models/scan-enhancement.model';

class FakeFsBrowser {
  isAvailable(): boolean {
    return false;
  }
  async pickDirectory(): Promise<string | null> {
    return null;
  }
  async listDirectory(): Promise<unknown[]> {
    return [];
  }
  async readFile(): Promise<Blob> {
    return new Blob();
  }
  async openArchive(): Promise<unknown> {
    return { tempDir: '', entries: [] };
  }
  async cleanupArchive(): Promise<void> {}
}

function makeBook(id: string, n: number): Book {
  const pages: Page[] = Array.from({ length: n }, (_, i) => ({
    index: i,
    url: `book://${id}/page-${i}.png`,
  }));
  return { id, title: id, pages, source: { type: 'preset', basePath: '' } };
}

class FakePlugin {
  capabilities: EnhancementCapabilities = {
    available: true,
    backend: 'vulkan',
    models: ['realesrgan-v2-anime-x2', 'realesrgan-x4'],
    maxDimension: 4096,
  };
  calls: EnhancePageArgs[] = [];
  cancelCalls = 0;
  private resolvers: Array<(r: EnhancePageResult) => void> = [];
  private rejecters: Array<(e: Error) => void> = [];
  lastArgs: EnhancePageArgs | null = null;

  async getCapabilities(): Promise<EnhancementCapabilities> {
    return this.capabilities;
  }
  enhancePage(args: EnhancePageArgs): Promise<EnhancePageResult> {
    this.calls.push(args);
    this.lastArgs = args;
    return new Promise<EnhancePageResult>((resolve, reject) => {
      this.resolvers.push(resolve);
      this.rejecters.push(reject);
    });
  }
  async cancelPage(): Promise<{ cancelled: boolean }> {
    this.cancelCalls++;
    return { cancelled: true };
  }
  async startForeground(): Promise<void> {}
  async updateForeground(): Promise<void> {}
  async stopForeground(): Promise<void> {}

  resolveLast(uri?: string): void {
    const a = this.lastArgs!;
    const r = this.resolvers.pop();
    r?.({
      destinationUri: uri ?? a.destinationUri,
      width: 100,
      height: 200,
      model: a.model,
      scale: a.scale,
      bytes: 512 * 1024,
    });
  }
  resolveFirst(uri?: string): void {
    const a = this.calls[0];
    const r = this.resolvers.shift();
    r?.({
      destinationUri: uri ?? a.destinationUri,
      width: 100,
      height: 200,
      model: a.model,
      scale: a.scale,
      bytes: 512 * 1024,
    });
  }
  rejectLast(kind = 'unknown', message = 'boom'): void {
    const r = this.rejecters.pop();
    const e = new Error(message);
    (e as Error & { kind?: string }).kind = kind;
    r?.(e);
  }
}

class FakeAssets {
  existsMap = new Set<string>();
  async markExists(uri: string): Promise<void> {
    this.existsMap.add(uri);
  }
  async exists(uri: string): Promise<boolean> {
    return this.existsMap.has(uri);
  }
  async delete(): Promise<void> {}
  async sizeOf(uri: string): Promise<number> {
    return this.existsMap.has(uri) ? 512 * 1024 : 0;
  }
  buildDestinationUri(_key: unknown, _source?: string): string {
    return `enhanced://${JSON.stringify(_key)}`;
  }
  async enforceBudget(): Promise<number> {
    return 0;
  }
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('ScanEnhancementService', () => {
  let service: ScanEnhancementService;
  let bookstore: BookstoreService;
  let plugin: FakePlugin;
  let assets: FakeAssets;

  beforeEach(() => {
    localStorage.clear();
    plugin = new FakePlugin();
    assets = new FakeAssets();
    TestBed.configureTestingModule({
      providers: [
        ScanEnhancementService,
        FilePageService,
        BookstoreService,
        { provide: RealEsrganPluginService, useValue: plugin },
        { provide: PageAssetService, useValue: assets },
        { provide: FILE_SYSTEM_BROWSER, useValue: new FakeFsBrowser() },
      ],
    });
    service = TestBed.inject(ScanEnhancementService);
    bookstore = TestBed.inject(BookstoreService);
  });

  it('seeds every page as pending and processes the current page first', async () => {
    const book = makeBook('b1', 4);
    bookstore.openBook(book);
    await service.enable(book);
    await flush();

    expect(service.statusFor(0)).toBe('processing');
    expect(plugin.calls.length).toBe(1);
    expect(plugin.calls[0].sourceUri).toBe('book://b1/page-0.png');

    // Resolve current page → next priority is the neighbor (index 1).
    plugin.resolveLast();
    await flush();
    expect(service.statusFor(0)).toBe('complete');
    expect(plugin.calls.length).toBe(2);
    expect(plugin.calls[1].sourceUri).toBe('book://b1/page-1.png');
  });

  it('does not reprocess a completed page (dedup / resume)', async () => {
    const book = makeBook('b2', 2);
    bookstore.openBook(book);
    await service.enable(book);
    await flush();
    plugin.resolveLast();
    await flush();
    plugin.resolveLast();
    await flush();
    expect(service.progress().done).toBe(2);
    const callsAfterFirstPass = plugin.calls.length;

    // Simulate reopen: persisted state is "complete", so no new work is queued.
    await service.enable(book);
    await flush();
    expect(plugin.calls.length).toBe(callsAfterFirstPass);
  });

  it('invalidates derivatives when the model setting changes', async () => {
    const book = makeBook('b3', 1);
    bookstore.openBook(book);
    await service.enable(book);
    await flush();
    plugin.resolveLast();
    await flush();
    expect(service.statusFor(0)).toBe('complete');

    await service.updateSettings({ model: 'realesrgan-x4' });
    await flush();
    expect(service.statusFor(0)).not.toBe('complete'); // invalidated, requeued
    expect(plugin.calls.length).toBe(2); // reprocessed with the new model
    expect(plugin.calls[1].model).toBe('realesrgan-x4');
  });

  it('cancels in-flight work and ignores its late completion', async () => {
    const book = makeBook('b4', 1);
    bookstore.openBook(book);
    await service.enable(book);
    await flush();
    expect(service.statusFor(0)).toBe('processing');

    await service.cancelPage(0);
    await flush();
    expect(plugin.cancelCalls).toBeGreaterThan(0);

    // The stale resolution must NOT mark the page complete.
    plugin.resolveLast();
    await flush();
    expect(service.statusFor(0)).not.toBe('complete');
    expect(service.statusFor(0)).toBe('cancelled');
  });

  it('rejects completions from a previous book after switching', async () => {
    const a = makeBook('A', 1);
    const b = makeBook('B', 1);
    bookstore.openBook(a);
    await service.enable(a);
    await flush();
    expect(plugin.calls.length).toBe(1);

    // Switch to a different book while the first job is still pending.
    bookstore.openBook(b);
    await service.enable(b);
    await flush();
    expect(service.displayedBookId()).toBe('B');

    // Resolve the FIRST book's (stale) job — must be ignored; B is untouched.
    plugin.resolveFirst();
    await flush();
    expect(service.statusFor(0)).not.toBe('idle');
    expect(plugin.calls.length).toBe(2);

    // Now resolve B's own job — it should complete.
    plugin.resolveFirst();
    await flush();
    expect(service.statusFor(0)).toBe('complete');
  });

  it('displayUrlFor returns the original until a derivative is ready', async () => {
    const book = makeBook('b5', 1);
    const page = book.pages[0];
    await service.disable();
    expect(service.displayUrlFor(page)).toBe(page.url);

    bookstore.openBook(book);
    await service.enable(book);
    await flush();
    expect(service.displayUrlFor(page)).toBe(page.url); // not complete yet

    plugin.resolveLast('enhanced://ready.png');
    await flush();
    expect(service.displayUrlFor(page)).toBe('enhanced://ready.png');
  });

  it('reports unsupported when capabilities are unavailable', async () => {
    plugin.capabilities = { available: false, backend: 'none', models: [], maxDimension: 0 };
    const book = makeBook('b6', 1);
    bookstore.openBook(book);
    await service.enable(book);
    await flush();
    expect(service.isSupported()).toBe(false);
    expect(plugin.calls.length).toBe(0); // nothing queued
  });

  describe('series window', () => {
    /** Resolve every pending page, one after another, until the queue idles. */
    async function drain(): Promise<void> {
      await flush();
      for (let i = 0; i < 60; i++) {
        const before = plugin.calls.length;
        if (before === 0) break;
        plugin.resolveLast();
        await flush();
        if (plugin.calls.length === before) break;
      }
    }

    /** Ids of the books the plugin was asked to enhance. */
    function enhancedBooks(): string[] {
      return [...new Set(plugin.calls.map((c) => c.sourceUri.split('/')[2]))];
    }

    it('keeps the series inside its budget', async () => {
      const settings = TestBed.inject(SettingsService);
      settings.setSeriesBudgetBytes(2 * 1024 * 1024);
      const books = [makeBook('s1', 2), makeBook('s2', 2), makeBook('s3', 2), makeBook('s4', 2)];
      bookstore.openBook(books[0]);

      await service.enhanceSeries('series-1', books);
      await drain();

      const state = service.seriesStates().get('series-1');
      expect(state).toBeDefined();
      expect(state!.usedBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
      // Some of the series is enhanced — the queue does not stall.
      expect(enhancedBooks().length).toBeGreaterThan(0);
    });

    it('books the next chapter once the reader moves on', async () => {
      const settings = TestBed.inject(SettingsService);
      settings.setSeriesBudgetBytes(2 * 1024 * 1024);
      const books = [makeBook('s1', 2), makeBook('s2', 2), makeBook('s3', 2), makeBook('s4', 2)];
      bookstore.openBook(books[0]);

      await service.enhanceSeries('series-1', books);
      await drain();
      const before = plugin.calls.length;

      // The reader finishes s1 and opens s2: the window rolls forward.
      bookstore.openBook(books[1]);
      TestBed.flushEffects();
      await flush();
      await drain();

      expect(plugin.calls.length).toBeGreaterThan(before);
      // The chapter just finished is kept — the reader may want to re-read it.
      expect(service.hasEnhanced('s1')).toBe(true);
    });

    it('drops the chapters that fall behind the reader', async () => {
      const settings = TestBed.inject(SettingsService);
      settings.setSeriesBudgetBytes(2 * 1024 * 1024);
      const books = [makeBook('s1', 2), makeBook('s2', 2), makeBook('s3', 2), makeBook('s4', 2)];
      bookstore.openBook(books[0]);

      await service.enhanceSeries('series-1', books);
      await drain();

      // Read through the series: the window rolls forward and the chapters
      // behind the reader are dropped to make room for the new ones.
      for (const book of books.slice(1)) {
        bookstore.openBook(book);
        TestBed.flushEffects();
        await flush();
        await drain();
      }

      expect(service.hasEnhanced('s1')).toBe(false);
      const state = service.seriesStates().get('series-1');
      expect(state!.usedBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    });
  });
});
