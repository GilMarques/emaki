import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ViewDidEnter } from '@ionic/angular';
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonImg,
  IonItem,
  IonLabel,
  IonList,
  IonRefresher,
  IonRefresherContent,
  IonSearchbar,
  IonSpinner,
  IonText,
  IonThumbnail,
  IonTitle,
  IonToast,
  IonToolbar,
  type RefresherCustomEvent,
} from '@ionic/angular/standalone';

import type { Manga } from '../../../core/connectors/connector.model';
import { ProviderBrowseService } from '../../../core/connectors/provider-browse.service';

/**
 * Browse a provider's catalogue: searchbar + results list.
 *
 * Searching is ENTER-triggered (each search is a network round-trip; no
 * per-keystroke autocomplete). While a request is in flight a centered
 * spinner replaces the content. Results cache in ProviderBrowseService so
 * the chapter page can resolve a Manga without re-searching.
 */
@Component({
  selector: 'ov-provider-browse',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonBackButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonImg,
    IonItem,
    IonLabel,
    IonList,
    IonRefresher,
    IonRefresherContent,
    IonSearchbar,
    IonSpinner,
    IonText,
    IonThumbnail,
    IonTitle,
    IonToast,
    IonToolbar,
  ],
  templateUrl: './browse.page.html',
  styleUrls: ['./browse.page.scss'],
})
export class ProviderBrowsePage implements ViewDidEnter {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly browse = inject(ProviderBrowseService);

  private readonly searchbar = viewChild.required(IonSearchbar);

  /** Focus the search input each time the page is entered. */
  public ionViewDidEnter(): void {
    void this.searchbar()?.setFocus();
  }

  /** Provider being browsed, resolved from the route id. */
  public readonly provider = computed(() => this.browse.provider());

  public readonly loading = signal(false);
  public readonly results = signal<readonly Manga[]>([]);
  /** Live text in the searchbar (not submitted yet). */
  public readonly query = signal('');
  /** Last submitted term — used by pull-to-refresh to re-run the search. */
  private lastQuery = '';
  /** True once a search has run; gates the pull-to-refresh presence. */
  public readonly hasSearched = signal(false);
  /** Toast message, or null when hidden. */
  public readonly toastMessage = signal<string | null>(null);

  public onInput(event: Event): void {
    this.query.set((event.target as HTMLIonSearchbarElement).value ?? '');
  }

  /** True when nothing has been searched yet in this session. */
  public readonly idle = computed(
    () => this.results().length === 0 && !this.loading() && this.toastMessage() === null,
  );

  constructor() {
    const id = this.route.snapshot.paramMap.get('providerId');
    if (id) this.browse.selectProvider(id);
  }

  /** Run a search for the given term. */
  public async search(term: string): Promise<void> {
    const provider = this.provider();
    const query = term?.trim();
    if (!provider || !query) return;

    this.lastQuery = query;
    this.hasSearched.set(true);
    this.loading.set(true);
    this.results.set([]);
    try {
      const mangas = await provider.search(query);
      this.results.set(mangas);
      this.browse.cacheMangas(mangas);
    } catch (err) {
      this.toastMessage.set(err instanceof Error ? err.message : 'Search failed');
    } finally {
      this.loading.set(false);
    }
  }

  /** Pull-to-refresh: re-run the last submitted search, then settle the refresher. */
  public async onRefresh(event: RefresherCustomEvent): Promise<void> {
    try {
      if (this.lastQuery) {
        await this.search(this.lastQuery);
      }
    } finally {
      await event.target.complete();
    }
  }

  /** Close the page when the provider id in the URL is unknown. */
  public onMangaClick(manga: Manga): void {
    this.browse.cacheOne(this.provider()!.id, manga);
    void this.router.navigate(['/provider', this.provider()!.id, 'manga', manga.id]);
  }
}