import { Injectable, inject, signal } from '@angular/core';

import { FILE_SYSTEM_BROWSER } from '../native/file-system-browser.port';
import { DeviceRegistryService } from './device-registry.service';
import { LanSyncTransport } from './lan-sync.transport';
import {
  decodePairingPayload,
  isPairingValid,
  type PairedDevice,
  type SyncMode,
} from './pairing.model';
import type { SyncBook, SyncFile, SyncTransport } from './sync-transport.port';

/** Folder the desktop writes enhanced pages into, next to the source. */
const ENHANCED_DIR = '.enhanced';

/** Progress of a running push. */
export interface SyncProgress {
  readonly deviceId: string;
  readonly bookId: string;
  readonly bookTitle: string;
  readonly done: number;
  readonly total: number;
  readonly state: 'running' | 'done' | 'error';
  readonly error?: string;
}

/** Name of this computer, shown on the receiving device. */
const COMPUTER_NAME_KEY = 'emaki:computer-name';
const COMPUTER_ID_KEY = 'emaki:computer-id';

@Injectable({ providedIn: 'root' })
export class SyncService {
  private readonly fs = inject(FILE_SYSTEM_BROWSER);
  private readonly registry = inject(DeviceRegistryService);
  private readonly transport: SyncTransport = new LanSyncTransport();

  private readonly _progress = signal<readonly SyncProgress[]>([]);
  public readonly progress = this._progress.asReadonly();
  public readonly devices = this.registry.devices;

  /** A human-friendly name for this computer. */
  public computerName(): string {
    if (typeof localStorage === 'undefined') return 'This computer';
    let name = localStorage.getItem(COMPUTER_NAME_KEY);
    if (!name) {
      name = `Computer ${Math.floor(Math.random() * 900 + 100)}`;
      localStorage.setItem(COMPUTER_NAME_KEY, name);
    }
    return name;
  }

  /**
   * Pair with a device from a scanned / pasted pairing code. The code carries
   * the shared secret, so the pairing is complete once the device confirms.
   */
  public async pair(code: string, nameOverride?: string): Promise<PairedDevice> {
    const payload = decodePairingPayload(code);
    if (!isPairingValid(payload)) {
      throw new Error('This pairing code has expired.');
    }
    const device: PairedDevice = {
      id: payload.id,
      name: nameOverride?.trim() || payload.name,
      host: payload.host,
      hosts: payload.hosts,
      port: payload.port,
      mode: payload.mode,
      secret: payload.secret,
      pairedAt: Date.now(),
      lastSeenAt: null,
    };
    await this.transport.pair(device, this.computerName(), this.computerId());
    this.registry.upsert(device);
    this.registry.touch(device.id);
    return device;
  }

  /** A stable id for this computer, so a device can be bound to it. */
  public computerId(): string {
    if (typeof localStorage === 'undefined') return 'unknown';
    let id = localStorage.getItem(COMPUTER_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(COMPUTER_ID_KEY, id);
    }
    return id;
  }

  public forget(deviceId: string): void {
    this.registry.remove(deviceId);
  }

  /**
   * Push the enhanced pages of a book to a device.
   *
   * The desktop writes enhanced pages into `<book>/.enhanced/`, so the files
   * are picked up straight from disk — the same bytes the reader shows.
   */
  public async pushBook(deviceId: string, book: SyncBook, folderPath: string): Promise<void> {
    const device = this.registry.byId(deviceId);
    if (!device) throw new Error('That device is not paired.');
    const files = await this.collectEnhancedFiles(folderPath);
    if (files.length === 0) {
      throw new Error('This book has no enhanced pages yet.');
    }
    this.setProgress({
      deviceId,
      bookId: book.id,
      bookTitle: book.title,
      done: 0,
      total: files.length,
      state: 'running',
    });
    try {
      await this.transport.pushBook(device, book, files);
      this.registry.touch(deviceId);
      this.setProgress({
        deviceId,
        bookId: book.id,
        bookTitle: book.title,
        done: files.length,
        total: files.length,
        state: 'done',
      });
    } catch (err) {
      this.setProgress({
        deviceId,
        bookId: book.id,
        bookTitle: book.title,
        done: 0,
        total: files.length,
        state: 'error',
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /** Read every enhanced page of a book folder into memory. */
  private async collectEnhancedFiles(folderPath: string): Promise<SyncFile[]> {
    const entries = await this.fs.listDirectory(folderPath);
    const enhanced = entries.find((e) => e.kind === 'dir' && e.name === ENHANCED_DIR);
    if (!enhanced) return [];
    const files = await this.fs.listDirectory(enhanced.path);
    const out: SyncFile[] = [];
    for (const entry of files) {
      if (entry.kind !== 'image' && entry.kind !== 'other') continue;
      const blob = await this.fs.readFile(entry.path);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      out.push({
        name: entry.name,
        bytes,
        mime: blob.type || mimeFor(entry.name),
      });
    }
    return out;
  }

  private setProgress(entry: SyncProgress): void {
    this._progress.update((list) => {
      const rest = list.filter(
        (p) => !(p.deviceId === entry.deviceId && p.bookId === entry.bookId),
      );
      return [entry, ...rest];
    });
  }
}

function mimeFor(name: string): string {
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  return 'application/octet-stream';
}

/** Modes the UI may offer, in the order the screenshot lists them. */
export const SYNC_MODES: readonly SyncMode[] = ['anywhere', 'home-network', 'this-computer'];
