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
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonSpinner,
  IonText,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';

import type { Chapter } from '../../../core/connectors/connector.model';
import { ProviderBrowseService } from '../../../core/connectors/provider-browse.service';
import { DownloadService } from '../../../core/services/download.service';

/**
 * Chapter list for a selected manga. Tapping a chapter adds it to the
 * download queue; a header button queues every chapter at once. Rendered
 * newest-first (providers usually return oldest-first, so we reverse).
 */
@Component({
  selector: 'ov-provider-chapters',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonBackButton,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonItem,
    IonLabel,
    IonList,
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
  private readonly downloads = inject(DownloadService);

  /** True while the "download all" header action is running. */
  public readonly downloadingAll = signal(false);

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
  public readonly sortedChapters = computed(() => [...this.chapters()].reverse());

  /** True when every listed chapter is already downloaded (or queued). */
  public readonly allDownloaded = computed(() => {
    const providerId = this.provider()?.id;
    if (!providerId || this.chapters().length === 0) return false;
    return this.chapters().every((c) => this.downloads.isDownloaded(providerId, c.id));
  });

  constructor() {
    void this.load();
  }

  public isDownloaded(chapter: Chapter): boolean {
    const providerId = this.provider()?.id;
    return providerId !== undefined && this.downloads.isDownloaded(providerId, chapter.id);
  }

  /** True while the chapter is queued or being downloaded. */
  public isActive(chapter: Chapter): boolean {
    const providerId = this.provider()?.id;
    return providerId !== undefined && this.downloads.active().has(`${providerId}:${chapter.id}`);
  }

  /** Queue a single chapter for download. */
  public enqueueChapter(chapter: Chapter): void {
    const provider = this.provider();
    const manga = this.manga();
    if (!provider || !manga) return;
    this.downloads.enqueue(provider, chapter, manga.title, `${manga.title} — ${chapter.title}`);
  }

  /** Queue every chapter for download. */
  public async downloadAll(): Promise<void> {
    const provider = this.provider();
    const manga = this.manga();
    if (!provider || !manga) return;
    this.downloadingAll.set(true);
    try {
      this.downloads.enqueueMany(provider, this.chapters(), manga.title, (c) => `${manga.title} — ${c.title}`);
    } finally {
      this.downloadingAll.set(false);
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
      // Re-queue any chapters that were still downloading when the app last closed.
      await this.downloads.restorePending(provider, chapters, manga.title, (c) => `${manga.title} — ${c.title}`);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Failed to load chapters');
    } finally {
      this.loading.set(false);
    }
  }
}