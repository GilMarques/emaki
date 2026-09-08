import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  IonAlert,
  IonButton,
  IonButtons,
  IonCol,
  IonContent,
  IonFab,
  IonFabButton,
  IonFabList,
  IonGrid,
  IonHeader,
  IonIcon,
  IonImg,
  IonModal,
  IonMenuButton,
  IonRow,
  IonSpinner,
  IonText,
  IonTitle,
  IonToast,
  IonToolbar,
} from '@ionic/angular/standalone';

import { DisplaySettingsComponent } from '../viewer/display-settings.component';
import { FiltersSettingsComponent } from '../viewer/filters-settings.component';
import type { FsFolder } from '../../core/native/library-scanner.port';
import type { Book } from '../../core/models/book.model';
import { FILE_SYSTEM_BROWSER, type FileSystemBrowser } from '../../core/native/file-system-browser.port';
import { BookstoreService } from '../../core/services/bookstore.service';
import { FilePageService } from '../../core/services/file-page.service';
import { LibraryRootService } from '../../core/services/library-root.service';
import { ScannerService } from '../../core/services/scanner.service';
import { ScanEnhancementService } from '../../core/services/scan-enhancement.service';
import { ShelfService } from '../../core/services/shelf.service';

@Component({
  selector: 'ov-bookshelf',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonAlert,
    IonButton,
    IonButtons,
    IonCol,
    IonContent,
    IonFab,
    IonFabButton,
    IonFabList,
    IonGrid,
    IonHeader,
    IonIcon,
    IonImg,
    IonModal,
    IonMenuButton,
    IonRow,
    IonSpinner,
    IonText,
    IonTitle,
    IonToast,
    IonToolbar,
    DisplaySettingsComponent,
    FiltersSettingsComponent,
  ],
  templateUrl: './bookshelf.page.html',
  styleUrls: ['./bookshelf.page.scss'],
})
export class BookshelfPage {
  private readonly router = inject(Router);
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

  /** Filters sheet (moved here from the reader's quick-actions). */
  public readonly filtersOpen = signal(false);
  /** Display sheet (reading direction, layout, zoom, theme, …). */
  public readonly displayOpen = signal(false);
  /** Whether the action FAB's list is expanded. */
  public readonly fabOpen = signal(false);

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

  /** Toast "View" button — navigates to the manager and dismisses. */
  public readonly toastButtons = computed(() => [
    {
      text: 'View',
      side: 'end',
      handler: () => {
        void this.router.navigate(['/manager']);
        return true; // dismiss the toast
      },
    },
  ]);

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

  /** Breadcrumb trail from the root to the current folder. */
  public readonly crumbs = computed(() => {
    const root = this.tree();
    if (!root) return [];
    const out: { readonly id: string; readonly name: string }[] = [
      { id: root.id, name: root.name },
    ];
    let node: FsFolder = root;
    for (const id of this.currentPath()) {
      const next = node.children.find((c) => c.id === id);
      if (!next) break;
      out.push({ id: next.id, name: next.name });
      node = next;
    }
    return out;
  });

  /** Header title: current folder path joined with "/", e.g. "Downloads/Hunter x Hunter". */
  public readonly titlePath = computed(() => this.crumbs().map((c) => c.name).join('/'));

  /** Child folders of the current folder. */
  public readonly children = computed<readonly FsFolder[]>(
    () => this.currentFolder()?.children ?? [],
  );

  constructor() {
    // Populate the tree immediately so the explorer shows structure without a scan.
    void this.scanner.discover();
  }

  /** True if a folder should render as a book cover (scanned book leaf). */
  public showCover(folder: FsFolder): boolean {
    return folder.isBook && this.scanner.isScanned(folder.id) && !!folder.imageUrls?.length;
  }

  /** Cover URL, resolved through the fs resolver for real-disk books. */
  public coverFor(folder: FsFolder): string | undefined {
    const raw = this.scanner.coverFor(folder);
    if (!raw) return undefined;
    if (folder.id.startsWith('fs:')) {
      // Track the resolver revision so the cover re-renders once the blob/asset
      // URL is ready (fast path via convertFileSrc is synchronous anyway).
      this.filePages.revision();
      return this.filePages.displayUrl(raw);
    }
    return raw;
  }

  /**
   * Cover thumbnails to render for a tile:
   * - a scanned book → its single cover;
   * - a container folder → a stack of up to 4 covers of the books inside it.
   * Empty for unscanned books / empty folders (renders a folder icon instead).
   */
  public coversFor(folder: FsFolder): readonly string[] {
    if (folder.isBook) {
      const c = this.scanner.coverFor(folder);
      return c ? [c] : [];
    }
    const out: string[] = [];
    const walk = (f: FsFolder): void => {
      if (out.length >= 4) return;
      if (f.isBook) {
        const c = this.scanner.coverFor(f);
        if (c && !out.includes(c)) out.push(c);
        return;
      }
      f.children.forEach(walk);
    };
    folder.children.forEach(walk);
    return out;
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
      if (node.id.startsWith('fs:') && node.imageUrls && node.imageUrls.length > 0) {
        covers.push(node.imageUrls[0]);
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
   * Roughly predict how much disk the enhanced derivatives will take: the sum
   * of the source page sizes grown by the output pixel ratio (scale²). PNG
   * output is lossless, so real sizes land in that ballpark. The estimate is
   * omitted when page sizes can't be stat'ed (e.g. preset books).
   */
  private async predictAlertSize(folder: FsFolder): Promise<void> {
    this.alertEstimating.set(true);
    const scale = this.enhance.settings().scale;
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
    this.alertSize.set(bytes <= 0 ? null : formatBytes(bytes * scale * scale));
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
