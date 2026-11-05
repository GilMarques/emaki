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
import { MegaAccountService } from '../../core/sync/mega-account.service';
import { RemoteShelfService } from '../../core/sync/remote-shelf.service';

/**
 * Sync: the MEGA account this device reads from.
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
  ],
  templateUrl: './sync.page.html',
  styleUrls: ['./sync.page.scss'],
})
export class SyncPage {
  private readonly account = inject(MegaAccountService);
  private readonly remote = inject(RemoteShelfService);

  /** The MEGA account sheet: sign in, or sign out. */
  public readonly megaOpen = signal(false);

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
      this.megaOpen.set(false);
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

  public openAccount(): void {
    this.megaOpen.set(true);
  }
}
