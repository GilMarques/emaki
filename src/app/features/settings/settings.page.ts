import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';

import { DisplaySettingsComponent } from '../viewer/display-settings.component';
import { FiltersSettingsComponent } from '../viewer/filters-settings.component';
import { MenuButtonComponent } from '../../shared/menu-button.component';
import { SettingsService } from '../../core/services/settings.service';

/**
 * Settings tab. Groups the Display and Filters panels (shared with the
 * reader's quick-actions sheets) and exposes a factory reset.
 */
@Component({
  selector: 'ov-settings',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonItem,
    IonLabel,
    IonList,
    IonListHeader,
      IonTitle,
    IonToolbar,
    DisplaySettingsComponent,
    FiltersSettingsComponent,
    MenuButtonComponent,
  ],
  templateUrl: './settings.page.html',
  styleUrls: ['./settings.page.scss'],
})
export class SettingsPage {
  private readonly settings = inject(SettingsService);

  public resetToDefaults(): void {
    this.settings.resetToDefaults();
  }
}
