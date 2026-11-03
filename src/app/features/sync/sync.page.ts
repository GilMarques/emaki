import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonModal,
  IonNote,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';

import { MenuButtonComponent } from '../../shared/menu-button.component';
import { AddDeviceComponent } from '../../shared/add-device.component';
import { SendBookComponent } from '../../shared/send-book.component';
import { MegaAccountService } from '../../core/sync/mega-account.service';
import { SyncService } from '../../core/sync/sync.service';
import { RemoteShelfService } from '../../core/sync/remote-shelf.service';
import { SYNC_MODE_LABELS, type PairedDevice } from '../../core/sync/pairing.model';

/**
 * Sync: the MEGA account this device reads from, and the devices it can hand
 * books to over the LAN.
 *
 * The library itself lives on the Library page — publishing and previews
 * belong where the books are, not in account settings.
 */
@Component({
  selector: 'ov-sync',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonInput,
    IonItem,
    IonLabel,
    IonList,
    IonListHeader,
    IonModal,
    IonNote,
    IonSpinner,
    IonTitle,
    IonToolbar,
    MenuButtonComponent,
    AddDeviceComponent,
    SendBookComponent,
  ],
  templateUrl: './sync.page.html',
  styleUrls: ['./sync.page.scss'],
})
export class SyncPage {
  private readonly sync = inject(SyncService);
  private readonly account = inject(MegaAccountService);
  private readonly remote = inject(RemoteShelfService);

  /** Devices paired with this one, for handing books over the LAN. */
  public readonly devices = this.sync.devices;
  public readonly modeLabels = SYNC_MODE_LABELS;

  /** Pairing and send sheets. */
  public readonly addDeviceOpen = signal(false);
  public readonly sendTarget = signal<PairedDevice | null>(null);

  /** The MEGA account this device is signed in to. */
  public readonly signedIn = this.account.signedIn;
  public readonly accountEmail = computed(() => this.account.account()?.email ?? null);

  /** Sign-in form state. */
  public readonly email = signal('');
  public readonly password = signal('');
  public readonly code = signal('');
  public readonly needsCode = signal(false);
  public readonly signingIn = signal(false);
  public readonly accountError = signal<string | null>(null);

  public onEmail(event: CustomEvent): void {
    this.email.set(String(event.detail?.value ?? ''));
    this.accountError.set(null);
  }

  public onPassword(event: CustomEvent): void {
    this.password.set(String(event.detail?.value ?? ''));
    this.accountError.set(null);
  }

  public onCode(event: CustomEvent): void {
    this.code.set(String(event.detail?.value ?? ''));
    this.accountError.set(null);
  }

  /** Sign in to MEGA. MEGA may answer with a two-factor challenge first. */
  public async signIn(): Promise<void> {
    if (this.signingIn()) return;
    this.signingIn.set(true);
    this.accountError.set(null);
    try {
      await this.account.signIn(
        this.email(),
        this.password(),
        this.needsCode() ? this.code() : undefined,
      );
      this.password.set('');
      this.code.set('');
      this.needsCode.set(false);
      // The shelf is read on the Library page; this just settles the health dot.
      await this.account.probe();
    } catch (caught) {
      if (caught instanceof Error && caught.name === 'TwoFactorRequired') {
        this.needsCode.set(true);
        this.accountError.set('Enter the two-factor code from your authenticator app.');
      } else {
        this.accountError.set(caught instanceof Error ? caught.message : String(caught));
      }
    } finally {
      this.signingIn.set(false);
    }
  }

  public async signOut(): Promise<void> {
    await this.account.signOut();
    this.remote.clear();
    this.accountError.set(null);
  }

  public pairDevice(): void {
    this.addDeviceOpen.set(true);
  }

  public closeSend(): void {
    this.sendTarget.set(null);
  }

  public sendTo(device: PairedDevice): void {
    this.sendTarget.set(device);
  }

  public forget(device: PairedDevice): void {
    this.sync.forget(device.id);
  }

  /** Caption under a paired device: when this computer last reached it. */
  public lastSeen(device: PairedDevice): string {
    if (device.lastSeenAt === null) return 'Not contacted yet';
    const diff = Math.max(0, Date.now() - device.lastSeenAt);
    if (diff < 60_000) return 'Seen just now';
    if (diff < 3_600_000) return `Seen ${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86_400_000) return `Seen ${Math.floor(diff / 3_600_000)}h ago`;
    return `Seen ${Math.floor(diff / 86_400_000)}d ago`;
  }
}
