import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonMenuButton,
  IonText,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';

import { ConnectorRegistryService } from '../../core/connectors/connector-registry.service';

/**
 * Provider tab. Lists the registered manga providers and their advertised
 * characteristics. Drilling into a provider's catalogue comes later.
 */
@Component({
  selector: 'ov-provider',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
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

  public readonly providers = this.registry.list;
}
