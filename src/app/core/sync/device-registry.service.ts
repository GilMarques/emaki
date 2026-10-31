import { Injectable, computed, signal } from '@angular/core';

import type { PairedDevice } from './pairing.model';

const STORAGE_KEY = 'emaki:devices:v1';

/**
 * The devices this computer may push to. Persisted in `localStorage`: the
 * pairing secret has to survive a reload, otherwise every page would have to
 * be scanned again.
 */
@Injectable({ providedIn: 'root' })
export class DeviceRegistryService {
  private readonly _devices = signal<readonly PairedDevice[]>(this.load());

  /** All paired devices, newest first. */
  public readonly devices = this._devices.asReadonly();
  public readonly hasDevices = computed(() => this._devices().length > 0);

  public byId(id: string): PairedDevice | undefined {
    return this._devices().find((d) => d.id === id);
  }

  /** Add or replace a device (pairing the same device twice refreshes it). */
  public upsert(device: PairedDevice): void {
    const rest = this._devices().filter((d) => d.id !== device.id);
    this._devices.set([device, ...rest]);
    this.persist();
  }

  /** Record that we just talked to the device. */
  public touch(id: string): void {
    const now = Date.now();
    this._devices.update((list) =>
      list.map((d) => (d.id === id ? { ...d, lastSeenAt: now } : d)),
    );
    this.persist();
  }

  public remove(id: string): void {
    this._devices.update((list) => list.filter((d) => d.id !== id));
    this.persist();
  }

  private load(): readonly PairedDevice[] {
    if (typeof localStorage === 'undefined') return [];
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw === null) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isPairedDevice);
    } catch {
      return [];
    }
  }

  private persist(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._devices()));
    } catch {
      // Quota exceeded or storage disabled: pairing stays for this session.
    }
  }
}

function isPairedDevice(value: unknown): value is PairedDevice {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  return (
    typeof d['id'] === 'string' &&
    typeof d['name'] === 'string' &&
    typeof d['host'] === 'string' &&
    typeof d['port'] === 'number' &&
    typeof d['secret'] === 'string' &&
    typeof d['mode'] === 'string'
  );
}
