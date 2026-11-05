import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  IonAlert,
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

import { ConnectorRegistryService } from '../../core/connectors/connector-registry.service';
import type { InterfaceTheme } from '../../core/models/settings.model';
import { MenuButtonComponent } from '../../shared/menu-button.component';
import { HistoryService } from '../../core/services/history.service';
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
    IonAlert,
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
  private readonly history = inject(HistoryService);
  private readonly registry = inject(ConnectorRegistryService);

  public readonly themes = THEME_OPTIONS;
  public readonly providers = this.registry.list;
  public readonly providerId = this.settings.browseProviderId;
  public readonly theme = computed(() => this.settings.settings().display.interfaceTheme);
  public readonly keepAwake = computed(() => this.settings.settings().display.keepAwake);
  public readonly hasHistory = this.history.hasEntries;

  /** Confirmation before the reading list is wiped. */
  public readonly clearOpen = signal(false);
  public readonly clearButtons = [
    { text: 'Cancel', role: 'cancel' },
    { text: 'Clear', role: 'destructive' },
  ];

  public onKeepAwakeChange(event: CustomEvent<{ checked: boolean }>): void {
    this.settings.setKeepAwake(event.detail.checked);
  }

  public onThemeChange(event: CustomEvent<{ value: InterfaceTheme | undefined }>): void {
    const v = event.detail.value;
    if (v === 'auto' || v === 'light' || v === 'dark') this.settings.setInterfaceTheme(v);
  }

  public onProviderChange(event: CustomEvent<{ value: string | undefined }>): void {
    const id = event.detail.value;
    if (typeof id === 'string') this.settings.setProvider(id);
  }

  public resetToDefaults(): void {
    this.settings.resetToDefaults();
  }

  public openClearHistory(): void {
    this.clearOpen.set(true);
  }

  public onClearDismiss(role: string | undefined): void {
    this.clearOpen.set(false);
    if (role === 'destructive') this.history.clear();
  }
}
