import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
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
  IonModal,
  IonNote,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';

import { MenuButtonComponent } from '../../shared/menu-button.component';
import { SettingsService } from '../../core/services/settings.service';
import { SERIES_BUDGET_PRESETS } from '../../core/models/settings.model';
import { AddDeviceComponent } from './add-device.component';
import { PairDeviceComponent } from './pair-device.component';
import { SendBookComponent } from './send-book.component';
import { SyncService } from '../../core/sync/sync.service';
import { SYNC_MODE_LABELS, type PairedDevice } from '../../core/sync/pairing.model';
import { canRunEndpoint } from '../../core/native/sync-endpoint.plugin';

/**
 * Settings tab: enhancement budget, paired devices (drawer layout only),
 * the factory reset and the debug log viewer. The Display and Filters
 * panels live with the reader — they are viewer preferences, not settings
 * for the app, and are opened from the bookshelf's quick actions.
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
    IonModal,
    IonNote,
    IonSelect,
    IonSelectOption,
    IonTitle,
    IonToolbar,
    MenuButtonComponent,
    AddDeviceComponent,
    PairDeviceComponent,
    SendBookComponent,
  ],
  templateUrl: './settings.page.html',
  styleUrls: ['settings.page.scss'],
})
export class SettingsPage {
  private readonly settings = inject(SettingsService);
  private readonly sync = inject(SyncService);

  /** Disk budget presets for one series' enhanced scans. */
  public readonly budgetPresets = SERIES_BUDGET_PRESETS;

  /** The budget currently in force (0 = unlimited). */
  public readonly budgetBytes = computed(() => this.settings.settings().enhancement.seriesBudgetBytes);

  /** Devices this computer may hand books to. */
  public readonly devices = this.sync.devices;
  public readonly modeLabels = SYNC_MODE_LABELS;

  /** True when this build can run a local sync endpoint (Android). */
  public readonly canPair = canRunEndpoint();

  public readonly addDeviceOpen = signal(false);
  public readonly pairDeviceOpen = signal(false);
  public readonly sendTarget = signal<PairedDevice | null>(null);
  public readonly notice = signal<string | null>(null);

  public onBudget(event: CustomEvent): void {
    const value = Number((event.detail as { value?: unknown }).value);
    if (!Number.isFinite(value) || value < 0) return;
    this.settings.setSeriesBudgetBytes(value);
  }

  public resetToDefaults(): void {
    this.settings.resetToDefaults();
  }

  public openAddDevice(): void {
    this.addDeviceOpen.set(true);
  }

  public openPairDevice(): void {
    this.pairDeviceOpen.set(true);
  }

  public onPaired(device: PairedDevice): void {
    this.notice.set(`Paired with ${device.name}.`);
  }

  public forget(device: PairedDevice): void {
    this.sync.forget(device.id);
    this.notice.set(`Removed ${device.name}.`);
  }

  public sendTo(device: PairedDevice): void {
    this.sendTarget.set(device);
  }
}
