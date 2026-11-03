import { Injectable, signal } from '@angular/core';

import type { PairedDevice } from './pairing.model';

/**
 * Shared state for the device modals.
 *
 * The modals live once in the app shell (`app.component.html`) so every entry
 * point — the sidebar popover, the Settings page and the Sync page — drives
 * the same instance instead of mounting its own copy.
 */
@Injectable({ providedIn: 'root' })
export class DeviceUiService {
  private readonly _addOpen = signal(false);
  private readonly _sendTarget = signal<PairedDevice | null>(null);

  /** True while the "add a device" (scan a pairing code) modal is open. */
  public readonly addOpen = this._addOpen.asReadonly();
  /** Device picked for "send a book", or null when that modal is closed. */
  public readonly sendTarget = this._sendTarget.asReadonly();

  public openAdd(): void {
    this._addOpen.set(true);
  }

  public closeAdd(): void {
    this._addOpen.set(false);
  }

  public requestSend(device: PairedDevice): void {
    this._sendTarget.set(device);
  }

  public closeSend(): void {
    this._sendTarget.set(null);
  }
}
