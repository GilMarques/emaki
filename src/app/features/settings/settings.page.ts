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
  IonToggle,
  IonToolbar,
} from '@ionic/angular/standalone';

import type { InterfaceTheme } from '../../core/models/settings.model';
import { MenuButtonComponent } from '../../shared/menu-button.component';
import { SettingsService } from '../../core/services/settings.service';

const THEME_OPTIONS: readonly { value: InterfaceTheme; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

/**
 * Settings tab: app-wide preferences, the factory reset, and the debug log
 * viewer. Display and Filters stay with the reader.
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
    IonToggle,
    IonToolbar,
    MenuButtonComponent,
  ],
  templateUrl: './settings.page.html',
  styleUrls: ['settings.page.scss'],
})
export class SettingsPage {
  private readonly settings = inject(SettingsService);

  public readonly themes = THEME_OPTIONS;
  public readonly theme = computed(() => this.settings.settings().display.interfaceTheme);
  public readonly keepAwake = computed(() => this.settings.settings().display.keepAwake);

  public onKeepAwakeChange(event: CustomEvent<{ checked: boolean }>): void {
    this.settings.setKeepAwake(event.detail.checked);
  }

  public onThemeChange(event: CustomEvent<{ value: InterfaceTheme | undefined }>): void {
    const v = event.detail.value;
    if (v === 'auto' || v === 'light' || v === 'dark') this.settings.setInterfaceTheme(v);
  }

  public resetToDefaults(): void {
    this.settings.resetToDefaults();
  }
}
