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
  IonNote,
  IonSpinner,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';

import { MenuButtonComponent } from '../../shared/menu-button.component';
import type { BlobReader } from '../../core/sync/blob-store.port';
import { blobReaderFor } from '../../core/sync/mega-folder.blob-reader';
import { readRemoteCatalog, type RemoteBook } from '../../core/sync/pack-catalog';
import { MegaAccountService } from '../../core/sync/mega-account.service';
import { PackPublisherService } from '../../core/sync/pack-publisher.service';
import { DeviceUiService } from '../../core/sync/device-ui.service';
import { RemoteLibraryService } from '../../core/sync/remote-library.service';
import { SyncService } from '../../core/sync/sync.service';
import { ShelfService } from '../../core/services/shelf.service';
import { SYNC_MODE_LABELS, type PairedDevice } from '../../core/sync/pairing.model';

/**
 * Sync setup: where the packs come from, and which devices may read them.
 *
 * The page is the introduction to the system, not a dashboard of things that
 * do not exist yet — every row here is backed by real state. Library storage
 * is a validated MEGA folder link (read-only, so a reader cannot damage the
 * library) and devices come from the same registry the sidebar uses.
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
  private readonly remote = inject(RemoteLibraryService);
  private readonly sync = inject(SyncService);
  private readonly deviceUi = inject(DeviceUiService);
  private readonly account = inject(MegaAccountService);
  private readonly shelf = inject(ShelfService);
  public readonly publisher = inject(PackPublisherService);

  /** The configured remote source, or null when none is set up. */
  public readonly library = this.remote.library;
  /** Devices paired with this one. */
  public readonly devices = this.sync.devices;
  public readonly modeLabels = SYNC_MODE_LABELS;

  /** Publishing device: the MEGA account, if signed in. */
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

  /** The link being pasted, and why it was rejected. */
  public readonly link = signal('');
  public readonly error = signal<string | null>(null);

  /** Result of the last folder check, and whether one is running. */
  public readonly checking = signal(false);
  public readonly checkResult = signal<string | null>(null);
  /** Books the folder offers, and folders whose manifest we cannot trust. */
  public readonly remoteBooks = signal<readonly RemoteBook[]>([]);
  public readonly problems = signal<readonly string[]>([]);
  private reader: BlobReader | null = null;

  public onLink(event: CustomEvent): void {
    this.link.set(String(event.detail?.value ?? ''));
    this.error.set(null);
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
    this.accountError.set(null);
  }

  /** Publish every shelf book that lives on disk. */
  public async publish(): Promise<void> {
    if (this.publisher.publishing()) return;
    this.accountError.set(null);
    try {
      const store = await this.account.store();
      await this.publisher.publish(this.shelf.books(), store);
      // The link may point at the folder that was just written to.
      await this.check();
    } catch (caught) {
      this.accountError.set(caught instanceof Error ? caught.message : String(caught));
    }
  }

  /** "12 / 180 pages" while a publish runs. */
  public pageProgress(): string {
    const progress = this.publisher.progress();
    return progress === null ? '' : `${progress.done} / ${progress.total} pages`;
  }

  /** Validate and store the pasted folder link. */
  public connect(): void {
    const result = this.remote.connect(this.link());
    if (!result.ok) {
      this.error.set(result.reason);
      return;
    }
    this.reader = null;
    this.link.set('');
    this.error.set(null);
    void this.check();
  }

  public disconnect(): void {
    this.reader = null;
    this.checkResult.set(null);
    this.remoteBooks.set([]);
    this.problems.set([]);
    this.remote.forget();
  }

  /**
   * Ask the store what is actually in the shared folder.
   *
   * Parsing the link only proves it is shaped like a link. This reads the
   * folder, so the page can say what is there — the difference between
   * "connected" and "connected to something".
   */
  public async check(): Promise<void> {
    const library = this.library();
    if (library === null || this.checking()) return;
    this.checking.set(true);
    this.checkResult.set(null);
    try {
      this.reader ??= blobReaderFor(library);
      const catalog = await readRemoteCatalog(this.reader);
      this.remoteBooks.set(catalog.books);
      this.problems.set(catalog.problems);
      this.checkResult.set(describeCatalog(catalog.books.length, library.handle));
    } catch (caught) {
      this.reader = null;
      this.remoteBooks.set([]);
      this.problems.set([]);
      this.checkResult.set(describeFailure(caught));
    } finally {
      this.checking.set(false);
    }
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
    this.deviceUi.openAdd();
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

/** One line describing what the folder holds. */
function describeCatalog(count: number, handle: string): string {
  if (count === 0) return 'No books published in this folder yet.';
  return `${count} book${count === 1 ? '' : 's'} available in ${handle}.`;
}

/** Turn a load or network failure into something a person can act on. */
function describeFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Loading chunk|dynamically imported module/i.test(message)) {
    return 'The MEGA client failed to load. Check the connection, then reload the app.';
  }
  return message;
}
