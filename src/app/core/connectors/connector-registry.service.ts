import { Injectable, inject, signal } from '@angular/core';

import { ComicKConnector } from './comick.connector';
import { Connector } from './connector.base';
import { MangaDexConnector } from './mangadex.connector';
import { MangaKatanaConnector } from './mangakatana.connector';
import { MangaTownConnector } from './mangatown.connector';
import { NaverConnector } from './naver.connector';
import { ShonenJumpPlusConnector } from './shonenjumpplus.connector';
import { TapasConnector } from './tapas.connector';
import { TonariNoYoungJumpConnector } from './tonarinoyoungjump.connector';

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
  private readonly comick = inject(ComicKConnector);
  private readonly mangakatana = inject(MangaKatanaConnector);
  private readonly mangatown = inject(MangaTownConnector);
  private readonly naver = inject(NaverConnector);
  private readonly shonenjumpplus = inject(ShonenJumpPlusConnector);
  private readonly tapas = inject(TapasConnector);
  private readonly tonarinoyoungjump = inject(TonariNoYoungJumpConnector);

  private readonly _list = signal<readonly Connector[]>([
    this.mangadex,
    this.comick,
    this.mangakatana,
    this.mangatown,
    this.naver,
    this.shonenjumpplus,
    this.tapas,
    this.tonarinoyoungjump,
  ]);

  /** All registered providers, sorted by label. */
  public readonly list = this._list.asReadonly();

  /** Look up a provider by its stable id (e.g. `mangadex`). */
  public byId(id: string): Connector | undefined {
    return this._list().find((connector) => connector.id === id);
  }
}