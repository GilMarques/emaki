import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonSpinner,
  IonText,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';

import type { Chapter } from '../../../core/connectors/connector.model';
import { ProviderBrowseService } from '../../../core/connectors/provider-browse.service';
import type { Book, Page } from '../../../core/models/book.model';
import { BookstoreService } from '../../../core/services/bookstore.service';

/**
 * Chapter list for a selected manga. Fetches chapters from the provider and
 * renders them newest-first (providers usually return oldest-first, so we
 * reverse for a reading-friendly order). Tapping a chapter builds a Book
 * from its pages and hands it to the viewer.
 */
@Component({
  selector: 'ov-provider-chapters',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonBackButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonItem,
    IonLabel,
    IonList,
    IonNote,
    IonSpinner,
    IonText,
    IonTitle,
    IonToolbar,
  ],
  templateUrl: './chapters.page.html',
  styleUrls: ['./chapters.page.scss'],
})
export class ProviderChaptersPage {
  private readonly route = inject(ActivatedRoute);
  private readonly browse = inject(ProviderBrowseService);
  private readonly bookstore = inject(BookstoreService);

  public readonly opening = signal<string | null>(null);

  public readonly provider = computed(() => this.browse.provider());
  public readonly manga = computed(() => {
    const providerId = this.route.snapshot.paramMap.get('providerId');
    const mangaId = this.route.snapshot.paramMap.get('mangaId');
    return providerId && mangaId ? this.browse.mangaFor(providerId, mangaId) : undefined;
  });

  public readonly loading = signal(true);
  public readonly error = signal<string | null>(null);
  public readonly chapters = signal<readonly Chapter[]>([]);

  /** Chapters ordered newest-first for easy access to the latest release. */
  public readonly sortedChapters = computed(() =>
    [...this.chapters()].reverse(),
  );

  constructor() {
    void this.load();
  }

  /** Build a Book from the chapter's page refs and open it in the viewer. */
  public async openChapter(chapter: Chapter): Promise<void> {
    const provider = this.provider();
    const manga = this.manga();
    if (!provider || !manga) return;

    this.opening.set(chapter.id);
    try {
      const pageRefs = await provider.getPages(chapter);
      const pages: Page[] = pageRefs.map((ref, index) => ({
        index,
        url: ref.url,
        label: `${manga.title} — ${chapter.title} (p.${index + 1})`,
      }));
      const book: Book = {
        id: `${provider.id}:${chapter.id}`,
        title: chapter.title || manga.title,
        pages,
        coverUrl: pageRefs[0]?.url,
        source: { type: 'online', providerId: provider.id, chapterId: chapter.id },
      };
      this.bookstore.openBook(book);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to open chapter');
    } finally {
      this.opening.set(null);
    }
  }

  private async load(): Promise<void> {
    const provider = this.provider();
    const manga = this.manga();
    if (!provider || !manga) {
      this.error.set('This manga is no longer available.');
      this.loading.set(false);
      return;
    }
    try {
      const chapters = await provider.getChapters(manga);
      this.chapters.set(chapters);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load chapters');
    } finally {
      this.loading.set(false);
    }
  }
}