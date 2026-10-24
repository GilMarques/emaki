import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
  IonAlert,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonImg,
  IonLabel,
  IonModal,
  IonSearchbar,
  IonSegment,
  IonSegmentButton,
  IonSpinner,
  IonText,
  IonTitle,
  IonToast,
  IonToolbar,
} from '@ionic/angular/standalone';

import { DisplaySettingsComponent } from '../viewer/display-settings.component';
import { FiltersSettingsComponent } from '../viewer/filters-settings.component';
import { MenuButtonComponent } from '../../shared/menu-button.component';
import type { FsFolder } from '../../core/native/library-scanner.port';
import type { Book } from '../../core/models/book.model';
import { FILE_SYSTEM_BROWSER, type FileSystemBrowser } from '../../core/native/file-system-browser.port';
import { BookstoreService } from '../../core/services/bookstore.service';
import { FilePageService } from '../../core/services/file-page.service';
import { LibraryRootService } from '../../core/services/library-root.service';
import { ScannerService } from '../../core/services/scanner.service';
import { ScanEnhancementService } from '../../core/services/scan-enhancement.service';
import { ShelfService } from '../../core/services/shelf.service';

/**
 * Multiplier applied to the source page bytes to estimate the size of the
 * enhanced derivatives. Measured on real scans: a capped WebP derivative
 * lands at about twice the source JPEG's size (up to 4× the pixels, but ~0.44×
 * the bytes per pixel).
 */
const DERIVATIVE_SIZE_RATIO = 2;

@Component({
  selector: 'ov-bookshelf',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonAlert,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonImg,
    IonLabel,
      IonModal,
    IonSearchbar,
    IonSegment,
    IonSegmentButton,
    IonSpinner,
    IonText,
    IonTitle,
    IonToast,
    IonToolbar,
    DisplaySettingsComponent,
    FiltersSettingsComponent,
    MenuButtonComponent,
  ],
  templateUrl: './bookshelf.page.html',
  styleUrls: ['./bookshelf.page.scss'],
})
export class BookshelfPage {
  private readonly scanner = inject(ScannerService);
  private readonly bookshelf = inject(BookstoreService);
  private readonly shelf = inject(ShelfService);
  private readonly fs = inject<FileSystemBrowser>(FILE_SYSTEM_BROWSER);
  private readonly root = inject(LibraryRootService);
  private readonly filePages = inject(FilePageService);
  private readonly enhance = inject(ScanEnhancementService);

  /** The folder-pick entry point only appears when a fs backend is present. */
  public readonly showFiles = computed(() => this.fs.isAvailable());

  public readonly tree = this.scanner.tree;
  public readonly scanning = this.scanner.scanning;
  public readonly booksFound = this.scanner.booksFound;

  /** Combined Display + Filters sheet ("options" in the top bar). */
  public readonly settingsOpen = signal(false);
  /** Which half of the sheet is showing. */
  public readonly settingsTab = signal<'display' | 'filters'>('display');

  /** Whether the search field is showing, and the current library query. */
  public readonly searchOpen = signal(false);
  public readonly query = signal('');

  /** Ids of the folder chain from the root to the current folder. */
  public readonly currentPath = signal<readonly string[]>([]);

  /** Folder whose enhance confirmation alert is open, or null. */
  public readonly alertFor = signal<FsFolder | null>(null);
  public readonly alertOpen = computed(() => this.alertFor() !== null);

  /** Formatted storage estimate for the pending enhancement, or null while unknown. */
  public readonly alertSize = signal<string | null>(null);

  /** Alert header: distinguishes a single book from a whole series. */
  public readonly alertHeader = computed(() => {
    const f = this.alertFor();
    if (f === null) return '';
    return this.alertIsRemove() ? 'Remove enhancement?' : this.isBookFolder(f) ? 'Enhance scans?' : 'Enhance series?';
  });

  /** Alert body text, including the book count for a series and a space estimate. */
  public readonly alertMessage = computed(() => {
    const f = this.alertFor();
    if (f === null) return '';
    if (this.alertIsRemove()) {
      return this.isBookFolder(f)
        ? 'The enhanced scans will be removed. Files are kept until they are no longer in use, so re-enhancing later is free.'
        : 'All enhanced scans in this series will be removed. Files are kept until they are no longer in use, so re-enhancing later is free.';
    }
    let base: string;
    if (this.isBookFolder(f)) {
      base = 'This book will be enhanced in the background.';
    } else {
      const n = this.collectBooks(f).length;
      base = `${n} book${n === 1 ? '' : 's'} in this series will be enhanced in the background.`;
    }
    const size = this.alertSize();
    if (size === null) return this.alertEstimating() ? `${base}\nEstimating space…` : base;
    return `${base}\nEstimated space: ~${size}`;
  });

  /** Whether the space estimate is still being computed. */
  public readonly alertEstimating = signal(false);

  /** True when the open alert is a removal (tile already enhanced) vs enhance. */
  public readonly alertIsRemove = computed(() => {
    const f = this.alertFor();
    return f !== null && this.hasEnhancedIn(f);
  });

  /** Alert buttons (Cancel / Enhance, or Cancel / Remove). */
  public readonly alertButtons = computed(() =>
    this.alertIsRemove()
      ? [
          { text: 'Cancel', role: 'cancel' },
          { text: 'Remove', role: 'remove' },
        ]
      : [
          { text: 'Cancel', role: 'cancel' },
          { text: 'Enhance', role: 'enhance' },
        ],
  );

  /** Confirmation toast message, or null when hidden. */
  public readonly toastMessage = signal<string | null>(null);

  private isBookFolder(f: FsFolder): boolean {
    return f.isBook && this.scanner.isScanned(f.id);
  }

  /** The folder currently being listed, or null before discovery. */
  public readonly currentFolder = computed<FsFolder | null>(() => {
    const root = this.tree();
    if (!root) return null;
    let node: FsFolder = root;
    for (const id of this.currentPath()) {
      const next = node.children.find((c) => c.id === id);
      if (!next) return root;
      node = next;
    }
    return node;
  });

  /** Header title: the current folder's name ("Library" at the root). */
  public readonly titleText = computed(() => this.currentFolder()?.name ?? 'Library');

  /** Child folders of the current folder. */
  public readonly children = computed<readonly FsFolder[]>(
    () => this.currentFolder()?.children ?? [],
  );

  /** Tiles to render: the current folder's children, narrowed by the query. */
  public readonly visibleChildren = computed<readonly FsFolder[]>(() => {
    const q = this.query().trim().toLowerCase();
    const list = this.children();
    return q.length === 0 ? list : list.filter((c) => c.name.toLowerCase().includes(q));
  });

  /** Books and pages under each folder, computed once per tree change. */
  private readonly stats = computed(() => {
    const map = new Map<string, { books: number; pages: number }>();
    const root = this.tree();
    if (root === null) return map;
    const walk = (node: FsFolder): { books: number; pages: number } => {
      if (node.isBook) {
        const pages = this.shelf.byId(node.id)?.pages.length ?? node.imageUrls?.length ?? 0;
        const value = { books: 1, pages };
        map.set(node.id, value);
        return value;
      }
      let books = 0;
      let pages = 0;
      for (const child of node.children) {
        const s = walk(child);
        books += s.books;
        pages += s.pages;
      }
      const value = { books, pages };
      map.set(node.id, value);
      return value;
    };
    walk(root);
    return map;
  });

  constructor() {
    // Populate the tree immediately so the explorer shows structure without a scan.
    void this.scanner.discover();
  }

  /** Cover art URL for a tile, resolved for real-disk books. */
  public coverUrlFor(folder: FsFolder): string | undefined {
    const raw = folder.isBook
      ? this.scanner.coverFor(folder)
      : this.firstCoverBelow(folder);
    if (raw === undefined) return undefined;
    if (folder.id.startsWith('fs:')) {
      // Track the resolver revision so the cover re-renders once the blob/asset
      // URL is ready (fast path via convertFileSrc is synchronous anyway).
      this.filePages.revision();
      return this.filePages.displayUrl(raw);
    }
    return raw;
  }

  /** First cover found under a container folder, so series still show art. */
  private firstCoverBelow(folder: FsFolder): string | undefined {
    for (const child of folder.children) {
      if (child.isBook) {
        const cover = this.scanner.coverFor(child);
        if (cover !== undefined) return cover;
      } else {
        const cover = this.firstCoverBelow(child);
        if (cover !== undefined) return cover;
      }
    }
    return undefined;
  }

  /** Caption under a tile's name: page count for a book, book count for a series. */
  public metaFor(folder: FsFolder): string {
    const stat = this.stats().get(folder.id);
    if (stat === undefined || stat.books === 0) {
      return folder.isBook ? 'Not scanned' : 'Empty';
    }
    if (!folder.isBook) {
      return `${stat.books} book${stat.books === 1 ? '' : 's'}`;
    }
    const pages = `${stat.pages} page${stat.pages === 1 ? '' : 's'}`;
    const progress = this.progressFor(folder);
    return progress === null ? pages : `${pages} · ${Math.round(progress * 100)}%`;
  }

  /** Toggle the search field; closing it clears the query. */
  public toggleSearch(): void {
    const open = !this.searchOpen();
    this.searchOpen.set(open);
    if (!open) this.query.set('');
  }

  /** Live-filter the tiles as the user types. */
  public onSearchInput(event: Event): void {
    const detail = (event as CustomEvent<{ value?: string | null }>).detail;
    this.query.set(detail?.value ?? '');
  }

  /** Switch the sheet between Display and Filters. */
  public onSettingsTabChange(event: Event): void {
    const detail = (event as CustomEvent<{ value?: string | number | undefined }>).detail;
    this.settingsTab.set(detail?.value === 'filters' ? 'filters' : 'display');
  }

  /** Read progress as a 0..1 fraction for a book tile, or null when not started. */
  public progressFor(folder: FsFolder): number | null {
    if (!folder.isBook) return null;
    const book = this.shelf.byId(folder.id);
    if (!book || book.pages.length === 0) return null;
    const idx = this.shelf.progressFor(folder.id);
    if (idx <= 0) return null;
    return Math.min(1, idx / book.pages.length);
  }

  /** Tap a tile: open a scanned book, otherwise descend into the folder. */
  public async onTileClick(child: FsFolder): Promise<void> {
    if (child.isBook && this.scanner.isScanned(child.id)) {
      const book = this.shelf.byId(child.id);
      if (book && book.source.type === 'folder') {
        await this.filePages.preload(book);
      }
      this.bookshelf.openById(child.id);
    } else {
      this.navigate(child.id);
    }
  }

  /** Descend into a subfolder (a series → its books). */
  public navigate(id: string): void {
    this.currentPath.update((p) => [...p, id]);
  }

  /** True when the current folder has a parent (i.e. not at the library root). */
  public readonly canGoUp = computed(() => this.currentPath().length > 0);

  /** Navigate up one level to the parent folder. */
  public goUp(): void {
    this.currentPath.update((p) => p.slice(0, -1));
  }

  /** Scan the library. With a fs backend and no root yet, pick a folder first. */
  public async scan(): Promise<void> {
    if (this.fs.isAvailable() && this.root.root() === null) {
      await this.openFolder();
      return;
    }
    await this.scanner.scan();
    this.preloadCovers();
  }

  /** Pick a folder on disk; it becomes the library root and is scanned. */
  public async openFolder(): Promise<void> {
    console.log('[shelf] openFolder() start');
    const dir = await this.fs.pickDirectory();
    console.log('[shelf] openFolder() picked:', dir);
    if (!dir) return;
    this.root.setRoot(dir);
    console.log('[shelf] openFolder() root set');
    await this.scanner.discover();
    console.log('[shelf] openFolder() discovered, tree:', this.scanner.tree());
    await this.scanner.scan();
    console.log('[shelf] openFolder() scanned, books:', this.scanner.booksFound());
    this.preloadCovers();
  }

  /** Warm the blob cache for every fs book's cover so tiles render with real
   *  thumbnails (revision bumps re-render the shelf once each is ready). */
  private preloadCovers(): void {
    const root = this.tree();
    if (!root) return;
    const covers: string[] = [];
    const walk = (node: FsFolder): void => {
      if (node.id.startsWith('fs:')) {
        const cover = this.scanner.coverFor(node);
        if (cover !== undefined) covers.push(cover);
      }
      node.children.forEach(walk);
    };
    walk(root);
    void Promise.all(covers.map((c) => this.filePages.ensure(c).catch(() => null)));
  }

  /** True when a book has at least one enhanced derivative (badge on the tile). */
  public isEnhanced(folder: FsFolder): boolean {
    return this.enhance.hasEnhanced(folder.id);
  }

  /** True while a book's enhancement is still in progress (spinner on tile). */
  public isEnhancing(folder: FsFolder): boolean {
    return this.enhance.isEnhancing(folder.id);
  }

  /** True when the tile (a book, or any book inside a series) is enhanced. */
  private hasEnhancedIn(folder: FsFolder): boolean {
    if (folder.isBook) return this.isEnhanced(folder);
    return this.collectBooks(folder).some((b) => this.enhance.hasEnhanced(b.id));
  }

  /** Open the enhance (or removal) confirmation alert for a tile. */
  public openEnhanceAlert(child: FsFolder): void {
    this.alertFor.set(child);
    if (this.hasEnhancedIn(child)) return; // removal alert needs no size estimate
    void this.predictAlertSize(child);
  }

  /**
   * Roughly predict how much disk the enhanced derivatives will take.
   *
   * The pipeline writes a WebP derivative capped at `maxOutputWidth` pixels
   * wide. Measured on real scans, the capped WebP derivative lands at roughly
   * twice the source JPEG's size: it carries up to 4× the pixels (the model's
   * 2× upscale) but WebP q82 needs only ~0.44× the bytes per pixel that the
   * source JPEG did. Sources whose 2× output exceeds the cap land lower.
   * The estimate is omitted when page sizes can't be stat'ed (e.g. preset
   * books).
   */
  private async predictAlertSize(folder: FsFolder): Promise<void> {
    this.alertEstimating.set(true);
    const books = this.isBookFolder(folder)
      ? (this.shelf.byId(folder.id) === undefined ? [] : [this.shelf.byId(folder.id)!])
      : this.collectBooks(folder);
    const stats: Promise<number | null>[] = [];
    for (const book of books) {
      for (const page of book.pages) {
        stats.push(this.fs.stat(page.url).catch(() => null));
      }
    }
    const sizes = await Promise.all(stats);
    let bytes = 0;
    for (const size of sizes) {
      if (size !== null && size > 0) bytes += size;
    }
    this.alertSize.set(bytes <= 0 ? null : formatBytes(bytes * DERIVATIVE_SIZE_RATIO));
    this.alertEstimating.set(false);
  }

  /** Alert dismissed: run enhancement (or removal) if the user confirmed. */
  public onAlertDismiss(role: string | undefined): void {
    const folder = this.alertFor();
    this.alertFor.set(null);
    if (folder === null) return;
    if (role === 'remove') {
      this.removeEnhancementTile(folder);
      return;
    }
    if (role !== 'enhance') return;
    if (this.isBookFolder(folder)) {
      void this.enhanceBookTile(folder);
    } else {
      void this.enhanceSeriesTile(folder);
    }
  }

  /** Remove enhancements from a single book, or from every book in a series. */
  private removeEnhancementTile(folder: FsFolder): void {
    if (folder.isBook) {
      this.enhance.removeEnhancement(folder.id);
      return;
    }
    const books = this.collectBooks(folder);
    for (const book of books) {
      if (this.enhance.hasEnhanced(book.id)) this.enhance.removeEnhancement(book.id);
    }
  }

  /** Background-enhance a single book without opening it. */
  public async enhanceBookTile(child: FsFolder): Promise<void> {
    const book = this.shelf.byId(child.id);
    if (book === undefined) return;
    await this.enhance.enhanceBook(book);
    this.toastMessage.set(`Enhancing "${book.title}"`);
  }

  /** Background-enhance every book inside a series folder, without opening any. */
  public async enhanceSeriesTile(folder: FsFolder): Promise<void> {
    const books = this.collectBooks(folder);
    if (books.length === 0) return;
    await this.enhance.enhanceSeries(books);
    this.toastMessage.set(`Enhancing ${books.length} book${books.length === 1 ? '' : 's'}`);
  }

  /** Recursively gather every scanned book folder under `node`. */
  private collectBooks(node: FsFolder): Book[] {
    const out: Book[] = [];
    const walk = (n: FsFolder): void => {
      if (n.isBook && this.scanner.isScanned(n.id)) {
        const book = this.shelf.byId(n.id);
        if (book !== undefined) out.push(book);
      }
      n.children.forEach(walk);
    };
    walk(node);
    return out;
  }
}

/** Human-readable byte size (e.g. "12.4 MB"). */
export function formatBytes(bytes: number): string {
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes;
  let unit = 'B';
  for (const u of units) {
    value /= 1024;
    unit = u;
    if (value < 1024) break;
  }
  if (unit === 'B') return `${Math.round(bytes)} B`;
  const rendered = value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1);
  return `${rendered} ${unit}`;
}
