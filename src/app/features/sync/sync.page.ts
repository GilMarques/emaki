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
import { PackPublisherService } from '../../core/sync/pack-publisher.service';
import { readRemoteCatalog, type RemoteBook } from '../../core/sync/pack-catalog';
import { SyncService } from '../../core/sync/sync.service';
import { ShelfService } from '../../core/services/shelf.service';
import { SYNC_MODE_LABELS, type PairedDevice } from '../../core/sync/pairing.model';

/**
 * Sync: the MEGA account that holds the library, and the devices that read it.
 *
 * Every device signs in to the same account and looks at the same `Emaki`
 * folder, so there is one code path and one place a book can come from. The
 * trade is explicit: a device that can read the library can also publish to
 * it, so this is not a read-only credential.
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
  private readonly shelf = inject(ShelfService);
  public readonly publisher = inject(PackPublisherService);

  /** Devices paired with this one, for handing books over the LAN. */
  public readonly devices = this.sync.devices;
  public readonly modeLabels = SYNC_MODE_LABELS;

  /** Pairing and send sheets. */
  public readonly addDeviceOpen = signal(false);
  public readonly sendTarget = signal<PairedDevice | null>(null);

  /** The MEGA account this device is signed in to. */
  public readonly signedIn = this.account.signedIn;
  public readonly accountEmail = computed(() => this.account.account()?.email ?? null);
  /** How many shelf books could be published. */
  public readonly publishableCount = computed(() =>
    this.publisher.publishable(this.shelf.books()).length,
  );

  /** Sign-in form state. */
  public readonly email = signal('');
  public readonly password = signal('');
  public readonly code = signal('');
  public readonly needsCode = signal(false);
  public readonly signingIn = signal(false);
  public readonly accountError = signal<string | null>(null);

  /** What the account holds, and whether a read is in flight. */
  public readonly remoteBooks = signal<readonly RemoteBook[]>([]);
  public readonly problems = signal<readonly string[]>([]);
  public readonly loading = signal(false);
  public readonly libraryError = signal<string | null>(null);

  constructor() {
    // A restored session is enough to show the library; a revoked one surfaces
    // as an error with the sign-in form right above it.
    if (this.signedIn()) void this.refresh();
  }

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
      await this.refresh();
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
    this.remoteBooks.set([]);
    this.problems.set([]);
    this.libraryError.set(null);
    this.accountError.set(null);
  }

  /** Read the catalogue from the account. */
  public async refresh(): Promise<void> {
    if (this.loading()) return;
    this.loading.set(true);
    this.libraryError.set(null);
    try {
      const catalog = await readRemoteCatalog(await this.account.store());
      this.remoteBooks.set(catalog.books);
      this.problems.set(catalog.problems);
      this.account.markHealthy();
    } catch (caught) {
      this.remoteBooks.set([]);
      this.problems.set([]);
      this.libraryError.set(caught instanceof Error ? caught.message : String(caught));
      this.account.markFailed();
    } finally {
      this.loading.set(false);
    }
  }

  /** Publish every shelf book that lives on disk, then re-read the catalogue. */
  public async publish(): Promise<void> {
    if (this.publisher.publishing()) return;
    this.accountError.set(null);
    try {
      await this.publisher.publish(this.shelf.books(), await this.account.store());
      await this.refresh();
    } catch (caught) {
      this.accountError.set(caught instanceof Error ? caught.message : String(caught));
    }
  }

  /** "12 / 180 pages" while a publish runs. */
  public pageProgress(): string {
    const progress = this.publisher.progress();
    return progress === null ? '' : `${progress.done} / ${progress.total} pages`;
  }

  /** Human size for a pack ("48.2 MB"). */
  public sizeOf(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${Math.round(kb)} KB`;
    return `${(kb / 1024).toFixed(1)} MB`;
  }

  /** Caption under a remote book: size, pages, and the pipeline if any. */
  public metaFor(book: RemoteBook): string {
    const pages = `${book.pageCount} page${book.pageCount === 1 ? '' : 's'}`;
    const scale = book.scale === undefined ? '' : ` · enhanced ${book.scale}×`;
    return `${pages} · ${this.sizeOf(book.packSize)}${scale}`;
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
