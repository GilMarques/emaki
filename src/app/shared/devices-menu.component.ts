import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core';
import { IonIcon } from '@ionic/angular/standalone';

import { SyncService } from '../core/sync/sync.service';
import { SYNC_MODE_LABELS, type PairedDevice } from '../core/sync/pairing.model';

/**
 * Content of the sidebar's devices popover (docked layout only).
 *
 * Lists the devices this computer may hand books to, with a way to push a
 * book to one, forget it, and pair a new one. Below `md` the same information
 * lives on the Settings page instead — there is no room for a popover there.
 */
@Component({
  selector: 'ov-devices-menu',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonIcon],
  template: `
    <div class="dm">
      <header class="dm-head">
        <span class="dm-title">Devices</span>
        <span class="dm-count">{{ devices().length }} paired</span>
      </header>

      @if (devices().length === 0) {
        <p class="dm-empty">
          Pair a phone to hand it the pages you enhance on this computer.
        </p>
      } @else {
        <ul class="dm-list">
          @for (device of devices(); track device.id) {
            <li class="dm-row">
              <ion-icon aria-hidden="true" class="dm-phone" name="phone-portrait-outline"></ion-icon>
              <div class="dm-text">
                <span class="dm-name">{{ device.name }}</span>
                <span class="dm-meta" [title]="address(device)">
                  {{ modeLabels[device.mode] }} · {{ device.host }}
                </span>
                <span class="dm-sub">{{ lastSeen(device) }}</span>
              </div>
              <button
                type="button"
                class="dm-action"
                title="Send a book"
                aria-label="Send a book"
                (click)="sendBook.emit(device)"
              >
                <ion-icon aria-hidden="true" name="book-outline"></ion-icon>
              </button>
              <button
                type="button"
                class="dm-action danger"
                title="Forget this device"
                aria-label="Forget this device"
                (click)="remove.emit(device)"
              >
                <ion-icon aria-hidden="true" name="trash-outline"></ion-icon>
              </button>
            </li>
          }
        </ul>
      }

      <button type="button" class="dm-add" (click)="add.emit()">
        <ion-icon aria-hidden="true" name="add-outline"></ion-icon>
        <span>Add device</span>
      </button>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
        width: 100%;
      }

      .dm {
        display: flex;
        flex-direction: column;
        min-width: 260px;
        padding: 6px 0 0;
        color: var(--ion-text-color, #000);
      }

      .dm-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 12px;
        padding: 6px 14px 8px;
      }

      .dm-title {
        font-size: 0.95rem;
        font-weight: 600;
      }

      .dm-count {
        color: var(--ion-color-medium, #92949c);
        font-size: 0.72rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      .dm-empty {
        margin: 0;
        padding: 2px 14px 12px;
        color: var(--ion-color-medium, #92949c);
        font-size: 0.8rem;
        line-height: 1.4;
      }

      .dm-list {
        margin: 0;
        padding: 0 6px 6px;
        list-style: none;
      }

      .dm-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 8px;
        border-radius: 10px;
      }

      .dm-row:hover {
        background: var(--ion-color-step-100, rgba(0, 0, 0, 0.04));
      }

      .dm-phone {
        flex: 0 0 auto;
        color: var(--ion-color-primary, #35a77c);
        font-size: 18px;
      }

      .dm-text {
        display: flex;
        flex: 1 1 auto;
        flex-direction: column;
        min-width: 0;
      }

      .dm-name {
        overflow: hidden;
        font-size: 0.88rem;
        font-weight: 600;
        line-height: 1.25;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .dm-meta {
        overflow: hidden;
        color: var(--ion-color-medium, #92949c);
        font-size: 0.72rem;
        line-height: 1.3;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .dm-sub {
        color: var(--ion-color-medium, #92949c);
        font-size: 0.68rem;
        line-height: 1.3;
        opacity: 0.75;
      }

      .dm-action {
        display: inline-flex;
        flex: 0 0 auto;
        align-items: center;
        justify-content: center;
        width: 28px;
        height: 28px;
        padding: 0;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: var(--ion-color-medium, #92949c);
        cursor: pointer;
        font-size: 17px;
      }

      .dm-action:hover {
        background: var(--ion-color-step-150, rgba(0, 0, 0, 0.08));
        color: var(--ion-text-color, #000);
      }

      .dm-action.danger:hover {
        color: var(--ion-color-danger, #f85552);
      }

      .dm-add {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        padding: 11px 14px;
        border: 0;
        border-top: 1px solid var(--ion-color-step-150, rgba(0, 0, 0, 0.08));
        background: transparent;
        color: var(--ion-text-color, #000);
        font: inherit;
        font-size: 0.85rem;
        font-weight: 600;
        text-align: start;
        cursor: pointer;
      }

      .dm-add ion-icon {
        color: var(--ion-color-primary, #35a77c);
        font-size: 18px;
      }

      .dm-add:hover {
        background: var(--ion-color-step-100, rgba(0, 0, 0, 0.04));
      }
    `,
  ],
})
export class DevicesMenuComponent {
  private readonly sync = inject(SyncService);

  /** The user asked to pair a new device. */
  public readonly add = output<void>();
  /** The user wants to hand a book to this device. */
  public readonly sendBook = output<PairedDevice>();
  /** The user wants to forget this device. */
  public readonly remove = output<PairedDevice>();

  /** Devices this computer may hand books to. */
  public readonly devices = this.sync.devices;

  /** Labels for the three reach modes. */
  public readonly modeLabels = SYNC_MODE_LABELS;

  /** Full address, for the tooltip — the row itself has no room for it. */
  public address(device: PairedDevice): string {
    return `${device.host}:${device.port}`;
  }

  /** Coarse "seen" label; exact times are noise in a two-line row. */
  public lastSeen(device: PairedDevice): string {
    if (device.lastSeenAt === null) return 'Never used';
    return `Used ${relative(device.lastSeenAt)}`;
  }
}

function relative(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}
