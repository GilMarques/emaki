import { Injectable, computed, inject, signal } from '@angular/core';

import { Connector } from './connector.base';
import { ConnectorRegistryService } from './connector-registry.service';
import type { Manga } from './connector.model';

/**
 * Holds the provider currently being browsed and caches the last manga
 * results per provider, so the chapter page can reconstruct a Manga object
 * from a route param without re-running a network search.
 *
 * The selected provider id lives in the route (`/provider/:id`); this store
 * is a convenience for lookups that need the live Connector instance, plus
 * an in-memory cache keyed by `providerId -> mangaId -> Manga`.
 */
@Injectable({ providedIn: 'root' })
export class ProviderBrowseService {
  private readonly registry = inject(ConnectorRegistryService);

  private readonly _providerId = signal<string | null>(null);
  private readonly _mangas = signal<ReadonlyMap<string, Manga>>(new Map());

  /** The provider currently being browsed, resolved from its id. */
  public readonly provider = computed<Connector | null>(() => {
    const id = this._providerId();
    return id === null ? null : this.registry.byId(id) ?? null;
  });

  public selectProvider(id: string): void {
    this._providerId.set(id);
  }

  public cacheMangas(mangas: readonly Manga[]): void {
    const next = new Map(this._mangas());
    for (const manga of mangas) {
      next.set(`${this._providerId()}::${manga.id}`, manga);
    }
    this._mangas.set(next);
  }

  /** Reconstruct a Manga from a cached search result, if available. */
  public mangaFor(providerId: string, mangaId: string): Manga | undefined {
    return this._mangas().get(`${providerId}::${mangaId}`);
  }

  /** A Manga the caller already has in hand (e.g. freshly fetched). */
  public cacheOne(providerId: string, manga: Manga): void {
    const next = new Map(this._mangas());
    next.set(`${providerId}::${manga.id}`, manga);
    this._mangas.set(next);
  }
}