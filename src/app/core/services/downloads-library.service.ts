import { Injectable, computed, inject } from '@angular/core';

import { Capacitor } from '@capacitor/core';

import type { FsFolder } from '../native/library-scanner.port';
import { DownloadStore } from '../native/download-store';
import type { Book, Page } from '../models/book.model';
import type { ChapterDownload } from './download.service';
import { DownloadService } from './download.service';

/**
 * Builds a virtual "Downloads" collection from the download manifest so
 * downloaded chapters appear in the bookshelf grouped by series.
 *
 * Downloads live in private app storage (`Directory.Data/emaki/<provider>/<chapter>`),
 * separate from the SAF library root. This service surfaces them as an
 * `FsFolder` tree that the Bookshelf already knows how to render:
 *
 *   Downloads
 *   └── Berserk              (series folder, grouped by manga title)
 *       └── Chapter 1        (book leaf; opening it reads files from disk)
 *
 * The tree is read-only to the shelf — removal is handled through
 * `DownloadService.remove`.
 */
@Injectable({ providedIn: 'root' })
export class DownloadsLibraryService {
  private readonly downloads = inject(DownloadService);
  private readonly store = inject(DownloadStore);

  /** Stable id of the synthetic Downloads root folder. */
  public static readonly ROOT_ID = '__downloads__';

  /** Stable id of a series folder (manga title). */
  public static seriesId(mangaTitle: string): string {
    return `__series__:${mangaTitle}`;
  }

  /** Stable id of a downloaded chapter book leaf. */
  public static chapterBookId(d: ChapterDownload): string {
    return `__chapter__:${d.providerId}:${d.chapterId}`;
  }

  /** Look up a downloaded chapter by its synthetic book-leaf id. */
  public downloadForBook(bookId: string): ChapterDownload | undefined {
    const prefix = '__chapter__:';
    if (!bookId.startsWith(prefix)) return undefined;
    const rest = bookId.slice(prefix.length);
    const i = rest.indexOf(':');
    if (i <= 0) return undefined;
    const providerId = rest.slice(0, i);
    const chapterId = rest.slice(i + 1);
    return this.downloads.get(providerId, chapterId);
  }

  /** The synthetic Downloads root node, or null when nothing is downloaded. */
  public readonly root = computed<FsFolder | null>(() => {
    const chapters = [...this.downloads.downloads().values()];
    if (chapters.length === 0) return null;

    const bySeries = new Map<string, ChapterDownload[]>();
    for (const c of chapters) {
      // Chapters persisted before the `mangaTitle` field existed can be
      // missing it — never assume it's set.
      const key = (c.mangaTitle ?? '').trim() || 'Unknown series';
      const list = bySeries.get(key);
      if (list) list.push(c);
      else bySeries.set(key, [c]);
    }

    const seriesFolders: FsFolder[] = [...bySeries.entries()]
      .map(([title, list]) => this.seriesFolder(title, list))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      id: DownloadsLibraryService.ROOT_ID,
      name: 'Downloads',
      isBook: false,
      children: seriesFolders,
    };
  });

  /** Build a Book from a downloaded chapter (page files resolve to disk). */
  public bookFor(d: ChapterDownload): Book {
    const pages: Page[] = d.files.map((_, i) => ({
      index: i,
      url: this.pageUrl(d, i),
      label: `${d.title} — p${i + 1}`,
    }));
    return {
      id: DownloadsLibraryService.chapterBookId(d),
      title: d.title,
      coverUrl: pages.length > 0 ? pages[0].url : undefined,
      pages,
      source: { type: 'folder', uri: this.store.chapterDir(d.providerId, d.chapterId) },
    };
  }

  /** Resolve a chapter page file to a renderable image URL. */
  private pageUrl(d: ChapterDownload, index: number): string {
    const fileName = d.files[index] ?? `${String(index).padStart(3, '0')}.jpg`;
    const path = this.store.filePath(d.providerId, d.chapterId, fileName);
    if (!Capacitor.isNativePlatform()) return path;
    return Capacitor.convertFileSrc(path);
  }

  private seriesFolder(title: string, list: ChapterDownload[]): FsFolder {
    // A downloaded chapter book = a folder-of-pages leaf, like a scanned book.
    const chapters: FsFolder[] = list
      .map((c) => ({
        id: DownloadsLibraryService.chapterBookId(c),
        name: c.title,
        isBook: true,
        children: [],
        imageUrls: c.files.map((_, i) => this.pageUrl(c, i)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      id: DownloadsLibraryService.seriesId(title),
      name: title,
      isBook: false,
      children: chapters,
    };
  }
}