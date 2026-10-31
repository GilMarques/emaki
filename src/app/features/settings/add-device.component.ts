import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  IonButton,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonRadio,
  IonRadioGroup,
  IonSpinner,
  IonTextarea,
} from '@ionic/angular/standalone';

import { QrService } from '../../core/sync/qr.service';
import { SyncService } from '../../core/sync/sync.service';
import {
  SYNC_MODE_HINTS,
  SYNC_MODE_LABELS,
  type PairedDevice,
  type SyncMode,
} from '../../core/sync/pairing.model';

/**
 * "Add a device" — pair this computer with a phone that is running the local
 * sync endpoint.
 *
 * The phone shows a QR code with its one-time pairing secret; this computer
 * scans it (or the code is pasted). The secret never travels over the network:
 * the payload is handed over directly, and every later request is encrypted
 * with a key derived from it.
 */
@Component({
  selector: 'ov-add-device',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonButton,
      IonIcon,
    IonInput,
    IonItem,
    IonLabel,
    IonList,
    IonListHeader,
    IonNote,
    IonRadio,
    IonRadioGroup,
    IonSpinner,
    IonTextarea,
  ],
  template: `
    <div class="modal-body">
    <ion-list-header>Add a device</ion-list-header>
    <ion-note class="modal-note">
      On the phone, open Emaki → Settings → Pair a computer. It shows a QR code
      with a one-time pairing code. Scan it here (or paste the code below).
    </ion-note>

    <ion-list lines="inset">
      <ion-item>
        <ion-label position="stacked">Device name</ion-label>
        <ion-input
          [value]="deviceName()"
          (ionInput)="onName($event)"
          placeholder="e.g. My Phone"
          autocapitalize="words"
        ></ion-input>
      </ion-item>

      <ion-radio-group [value]="mode()" (ionChange)="onMode($event)">
        @for (option of modes; track option) {
          <ion-item>
            <ion-radio [value]="option">{{ modeLabels[option] }}</ion-radio>
          </ion-item>
          <ion-note class="mode-hint">{{ modeHints[option] }}</ion-note>
        }
      </ion-radio-group>
    </ion-list>

    @if (scanning()) {
      <div class="scanner">
        <video #video playsinline muted></video>
        <ion-button fill="clear" size="small" (click)="stopScan()">Cancel</ion-button>
      </div>
    } @else {
      <ion-list lines="inset">
        <ion-item>
          <ion-label position="stacked">Pairing code</ion-label>
          <ion-textarea
            [value]="code()"
            (ionInput)="code.set($any($event.detail.value ?? ''))"
            [autoGrow]="true"
            rows="2"
            placeholder="emaki-pair-v1.…"
          ></ion-textarea>
        </ion-item>
      </ion-list>
      <div class="actions">
        <ion-button fill="outline" (click)="startScan()">
          <ion-icon slot="start" name="scan-outline"></ion-icon>
          Scan QR code
        </ion-button>
        <ion-button [disabled]="!code().trim() || busy()" (click)="pair()">
          @if (busy()) {
            <ion-spinner name="crescent"></ion-spinner>
          } @else {
            Pair
          }
        </ion-button>
      </div>
    }

    @if (error()) {
      <ion-note class="error">{{ error() }}</ion-note>
    }
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
      .mode-hint {
        display: block;
        padding: 0 16px 8px;
        font-size: 0.8rem;
      }
      .mode-hint {
        padding-bottom: 10px;
        opacity: 0.7;
      }
      .actions {
        display: flex;
        gap: 12px;
        justify-content: flex-end;
        padding: 12px 16px;
      }
      .scanner {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        padding: 16px;
      }
      .scanner video {
        width: 100%;
        max-width: 360px;
        border-radius: 12px;
        background: #000;
      }
      .error {
        display: block;
        padding: 0 16px 16px;
        color: var(--ion-color-danger);
      }
    `,
  ],
})
export class AddDeviceComponent implements OnDestroy {
  private readonly qr = inject(QrService);
  private readonly sync = inject(SyncService);

  /** Whether the modal is open. */
  readonly isOpen = input(false);
  /** Emitted when the modal should close. */
  readonly dismissed = output<void>();
  /** Emitted once a device is paired. */
  readonly paired = output<PairedDevice>();

  readonly modes = ['anywhere', 'home-network', 'this-computer'] as const;
  readonly modeLabels = SYNC_MODE_LABELS;
  readonly modeHints = SYNC_MODE_HINTS;

  readonly deviceName = signal('');
  readonly mode = signal<SyncMode>('home-network');
  readonly code = signal('');
  readonly scanning = signal(false);
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  private readonly video = viewChild<ElementRef<HTMLVideoElement>>('video');
  private scanAbort = false;

  public onName(event: CustomEvent): void {
    this.deviceName.set(String(event.detail?.value ?? ''));
  }

  public onMode(event: CustomEvent): void {
    this.mode.set(event.detail?.value as SyncMode);
  }

  /** Point the camera at the phone's QR code. */
  public async startScan(): Promise<void> {
    this.error.set(null);
    this.scanning.set(true);
    this.scanAbort = false;
    // The <video> only exists once the scanner is shown.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const element = this.video()?.nativeElement;
    if (!element) {
      this.scanning.set(false);
      return;
    }
    try {
      const text = await this.qr.scan(element);
      if (this.scanAbort) return;
      this.code.set(text.trim());
      this.scanning.set(false);
    } catch (err) {
      if (this.scanAbort) return;
      this.scanning.set(false);
      this.error.set(err instanceof Error ? err.message : String(err));
    }
  }

  public stopScan(): void {
    this.scanAbort = true;
    this.scanning.set(false);
  }

  /** Complete the pairing with the scanned / pasted code. */
  public async pair(): Promise<void> {
    this.error.set(null);
    this.busy.set(true);
    try {
      const device = await this.sync.pair(this.code().trim(), this.deviceName());
      this.paired.emit(device);
      this.dismissed.emit();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }

  public ngOnDestroy(): void {
    this.scanAbort = true;
  }
}
