import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
  IonBreadcrumb,
  IonBreadcrumbs,
  IonButton,
  IonButtons,
  IonCol,
  IonContent,
  IonGrid,
  IonHeader,
  IonIcon,
  IonImg,
  IonModal,
  IonRow,
  IonSpinner,
  IonText,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';

import { DisplaySettingsComponent } from '../viewer/display-settings.component';
import { FiltersSettingsComponent } from '../viewer/filters-settings.component';
import type { FsFolder } from '../../core/native/library-scanner.port';
import { BookstoreService } from '../../core/services/bookstore.service';
import { ScannerService } from '../../core/services/scanner.service';

@Component({
  selector: 'ov-bookshelf',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonBreadcrumb,
    IonBreadcrumbs,
    IonButton,
    IonButtons,
    IonCol,
    IonContent,
    IonGrid,
    IonHeader,
    IonIcon,
    IonImg,
    IonModal,
    IonRow,
    IonSpinner,
    IonText,
    IonTitle,
    IonToolbar,
    DisplaySettingsComponent,
    FiltersSettingsComponent,
  ],
  templateUrl: './bookshelf.page.html',
  styleUrls: ['./bookshelf.page.scss'],
})
export class BookshelfPage {
  private readonly scanner = inject(ScannerService);
  private readonly bookstore = inject(BookstoreService);

  public readonly tree = this.scanner.tree;
  public readonly scanning = this.scanner.scanning;
  public readonly booksFound = this.scanner.booksFound;

  /** Filters sheet (moved here from the reader's quick-actions). */
  public readonly filtersOpen = signal(false);
  /** Display sheet (reading direction, layout, zoom, theme, …). */
  public readonly displayOpen = signal(false);

  /** Ids of the folder chain from the root to the current folder. */
  public readonly currentPath = signal<readonly string[]>([]);

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

  public coverFor(folder: FsFolder): string | undefined {
    return this.scanner.coverFor(folder);
  }

  /** Tap a tile: open a scanned book, otherwise descend into the folder. */
  public onTileClick(child: FsFolder): void {
    if (child.isBook && this.scanner.isScanned(child.id)) {
      this.bookstore.openById(child.id);
    } else {
      this.navigate(child.id);
    }
  }

  /** Descend into a subfolder. */
  public navigate(id: string): void {
    this.currentPath.update((p) => [...p, id]);
  }

  /** Jump to a breadcrumb depth (0 = library root). */
  public goToCrumb(depth: number): void {
    this.currentPath.set(this.currentPath().slice(0, depth));
  }

  /** True when the current folder has a parent (i.e. not at the library root). */
  public readonly canGoUp = computed(() => this.currentPath().length > 0);

  /** Navigate up one level to the parent folder. */
  public goUp(): void {
    this.currentPath.update((p) => p.slice(0, -1));
  }

  public async scan(): Promise<void> {
    await this.scanner.scan();
  }
}
