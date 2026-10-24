import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
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
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';

import { DisplaySettingsComponent } from '../viewer/display-settings.component';
import { FiltersSettingsComponent } from '../viewer/filters-settings.component';
import { MenuButtonComponent } from '../../shared/menu-button.component';
import { SettingsService } from '../../core/services/settings.service';
import { SERIES_BUDGET_PRESETS } from '../../core/models/settings.model';

/**
 * Settings tab. Groups the Display and Filters panels (shared with the
 * reader's quick-actions sheets) and exposes a factory reset.
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
    IonSelect,
    IonSelectOption,
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

  /** Disk budget presets for one series' enhanced scans. */
  public readonly budgetPresets = SERIES_BUDGET_PRESETS;

  /** The budget currently in force (0 = unlimited). */
  public readonly budgetBytes = computed(() => this.settings.settings().enhancement.seriesBudgetBytes);

  public onBudget(event: CustomEvent): void {
    const value = Number((event.detail as { value?: unknown }).value);
    if (!Number.isFinite(value) || value < 0) return;
    this.settings.setSeriesBudgetBytes(value);
  }

  public resetToDefaults(): void {
    this.settings.resetToDefaults();
  }
}
