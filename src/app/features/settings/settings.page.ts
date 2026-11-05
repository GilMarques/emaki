import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';

import { MenuButtonComponent } from '../../shared/menu-button.component';
import { SettingsService } from '../../core/services/settings.service';

/**
 * Settings tab: the factory reset and the debug log viewer. The Display and
 * Filters panels live with the reader — they are viewer preferences, not
 * settings for the app, and are opened from the bookshelf's quick actions.
 */
@Component({
  selector: 'ov-settings',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonItem,
    IonLabel,
    IonList,
    IonListHeader,
    IonTitle,
    IonToolbar,
    MenuButtonComponent,
  ],
  templateUrl: './settings.page.html',
  styleUrls: ['settings.page.scss'],
})
export class SettingsPage {
  private readonly settings = inject(SettingsService);

  public resetToDefaults(): void {
    this.settings.resetToDefaults();
  }
}
