import { Injectable, inject, signal } from '@angular/core';

import { Connector } from './connector.base';
import { MangaDexConnector } from './mangadex.connector';

/**
 * Registry of all registered manga providers.
 *
 * Providers are Angular services (for DI of the request transport), so they
 * can't be enumerated by import scanning — list them explicitly here when
 * adding a new connector. Consumers get a readonly signal list and an
 * id-based lookup.
 */
@Injectable({ providedIn: 'root' })
export class ConnectorRegistryService {
  private readonly mangadex = inject(MangaDexConnector);

  private readonly _list = signal<readonly Connector[]>([this.mangadex]);

  /** All registered providers, sorted by label. */
  public readonly list = this._list.asReadonly();

  /** Look up a provider by its stable id (e.g. `mangadex`). */
  public byId(id: string): Connector | undefined {
    return this._list().find((connector) => connector.id === id);
  }
}