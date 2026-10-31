import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import {
  IonButton,
  IonItem,
  IonList,
  IonListHeader,
  IonNote,
  IonRadio,
  IonRadioGroup,
  IonSpinner,
} from '@ionic/angular/standalone';

import {
  canRunEndpoint,
  startEndpoint,
  stopEndpoint,
} from '../../core/native/sync-endpoint.plugin';
import { QrService } from '../../core/sync/qr.service';
import {
  SYNC_MODE_HINTS,
  SYNC_MODE_LABELS,
  type SyncMode,
} from '../../core/sync/pairing.model';

/**
 * "Pair a computer" — the phone's side of the pairing.
 *
 * It opens the local endpoint and shows the one-time pairing payload as a QR
 * code (and as text, for the copy/paste path). The endpoint stays open until
 * this sheet is closed.
 */
@Component({
  selector: 'ov-pair-device',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonButton,
      IonItem,
    IonList,
    IonListHeader,
    IonNote,
    IonRadio,
    IonRadioGroup,
    IonSpinner,
  ],
  template: `
    <div class="modal-body">
    <ion-list-header>Pair a computer</ion-list-header>
    <ion-note class="modal-note">
      The computer shows a scan dialog for this code. Traffic between the two
      is encrypted end to end — the network only ever carries ciphertext.
    </ion-note>

    <ion-list lines="inset">
      <ion-radio-group [value]="mode()" (ionChange)="onMode($event)">
        @for (option of modes; track option) {
          <ion-item>
            <ion-radio [value]="option">{{ modeLabels[option] }}</ion-radio>
          </ion-item>
          <ion-note class="mode-hint">{{ modeHints[option] }}</ion-note>
        }
      </ion-radio-group>
    </ion-list>

    @if (starting()) {
      <div class="center">
        <ion-spinner name="crescent"></ion-spinner>
      </div>
    } @else if (qrDataUrl()) {
      <div class="center">
        <img [src]="qrDataUrl()" alt="Pairing code" class="qr" />
      </div>
      <ion-note class="code">{{ code() }}</ion-note>
      <div class="actions">
        <ion-button fill="outline" (click)="restart()">New code</ion-button>
        <ion-button (click)="dismissed.emit()">Done</ion-button>
      </div>
    } @else if (error()) {
      <ion-note class="error">{{ error() }}</ion-note>
    }
    </div>
  `,
  styles: [
    `
      .modal-body {
        display: block;
        padding: calc(env(safe-area-inset-top, 0px) + 12px) 0 20px;
        max-height: 100%;
        overflow-y: auto;
      }
      .modal-note,
      .mode-hint,
      .code {
        display: block;
        padding: 0 16px 8px;
        font-size: 0.8rem;
      }
      .mode-hint {
        padding-bottom: 10px;
        opacity: 0.7;
      }
      .center {
        display: flex;
        justify-content: center;
        padding: 16px;
      }
      .qr {
        width: 260px;
        height: 260px;
        border-radius: 12px;
        background: #fff;
        padding: 8px;
      }
      .code {
        word-break: break-all;
        opacity: 0.75;
        padding-bottom: 12px;
      }
      .actions {
        display: flex;
        gap: 12px;
        justify-content: flex-end;
        padding: 0 16px 16px;
      }
      .error {
        display: block;
        padding: 0 16px 16px;
        color: var(--ion-color-danger);
      }
    `,
  ],
})
export class PairDeviceComponent {
  private readonly qr = inject(QrService);

  /** Whether the sheet is open. */
  readonly isOpen = input(false);
  /** Emitted when the sheet should close. */
  readonly dismissed = output<void>();

  readonly modes = ['home-network', 'this-computer', 'anywhere'] as const;
  readonly modeLabels = SYNC_MODE_LABELS;
  readonly modeHints = SYNC_MODE_HINTS;

  readonly mode = signal<SyncMode>('home-network');
  readonly qrDataUrl = signal<string | null>(null);
  readonly code = signal('');
  readonly starting = signal(false);
  readonly error = signal<string | null>(null);

  constructor() {
    // Start the endpoint as soon as the sheet opens, and close it again when
    // it goes away.
    effect(() => {
      const open = this.isOpen();
      if (open) {
        void this.open();
      } else {
        void this.close();
      }
    });
  }

  public onMode(event: CustomEvent): void {
    this.mode.set(event.detail?.value as SyncMode);
    void this.open();
  }

  /** (Re)open the endpoint with the current mode and render its QR code. */
  public async open(): Promise<void> {
    if (!canRunEndpoint()) {
      this.error.set('This device cannot run a sync endpoint.');
      return;
    }
    this.starting.set(true);
    this.error.set(null);
    try {
      await stopEndpoint();
      const endpoint = await startEndpoint(this.mode());
      this.code.set(endpoint.payload);
      this.qrDataUrl.set(await this.qr.encode(endpoint.payload));
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.starting.set(false);
    }
  }

  public async restart(): Promise<void> {
    await this.open();
  }

  public async close(): Promise<void> {
    if (!canRunEndpoint()) return;
    try {
      await stopEndpoint();
    } catch {
      // The endpoint may already be gone.
    }
  }
}
