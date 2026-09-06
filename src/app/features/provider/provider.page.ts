import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  IonAvatar,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonImg,
  IonItem,
  IonLabel,
  IonList,
  IonMenuButton,
  IonText,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';

import { ConnectorRegistryService } from '../../core/connectors/connector-registry.service';
import { ProviderBrowseService } from '../../core/connectors/provider-browse.service';

/**
 * Provider tab. Lists the registered manga providers and their advertised
 * characteristics. Drilling into a provider's catalogue comes later.
 */
@Component({
  selector: 'ov-provider',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    IonAvatar,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonImg,
    IonItem,
    IonLabel,
    IonList,
    IonMenuButton,
    IonText,
    IonTitle,
    IonToolbar,
  ],
  templateUrl: './provider.page.html',
  styleUrls: ['./provider.page.scss'],
})
export class ProviderPage {
  private readonly registry = inject(ConnectorRegistryService);
  private readonly browse = inject(ProviderBrowseService);

  public readonly providers = this.registry.list;

  /** Remember the selected provider so browse/chapter pages can resolve it. */
  public openProvider(id: string): void {
    this.browse.selectProvider(id);
  }

  /** Favicon asset for a provider, when one was downloaded. */
  public iconFor(id: string): string {
    return `assets/provider-icons/${id}.ico`;
  }
}
