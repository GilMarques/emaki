/**
 * LAN transport: this computer talks straight to the receiver's local
 * endpoint. The body of every request is encrypted (see `pairing.crypto`), so
 * the transport itself only ever moves ciphertext — the LAN can be shared,
 * sniffed or proxied without leaking the scans.
 */
import { deriveSessionKey, openJson, sealBytes, sealJson } from './pairing.crypto';
import type { PairedDevice } from './pairing.model';
import type {
  DeviceStatus,
  SyncBook,
  SyncFile,
  SyncTransport,
} from './sync-transport.port';

/** Purpose strings for key derivation — one key per direction/purpose. */
const KEY_INFO = {
  control: 'emaki-sync-control',
  files: 'emaki-sync-files',
} as const;

const REQUEST_TIMEOUT_MS = 15_000;

export class LanSyncTransport implements SyncTransport {
  readonly id = 'lan';

  /** Announce ourselves and let the receiver bind the pairing to this computer. */
  async pair(
    device: PairedDevice,
    computerName: string,
    computerId: string,
  ): Promise<void> {
    const key = await deriveSessionKey(device.secret, KEY_INFO.control);
    const body = await sealJson(key, {
      action: 'pair',
      computerName,
      computerId,
      mode: device.mode,
      pairedAt: Date.now(),
    });
    await this.post(device, '/pair', body);
  }

  async status(device: PairedDevice): Promise<DeviceStatus> {
    const key = await deriveSessionKey(device.secret, KEY_INFO.control);
    const body = await sealJson(key, { action: 'status' });
    const raw = await this.post(device, '/status', body);
    return openJson<DeviceStatus>(key, raw);
  }

  /**
   * Hand over a book. The metadata goes in the (encrypted) control body, the
   * files follow one encrypted request each — small requests keep the phone's
   * memory flat and let a failed transfer resume at the next file.
   */
  async pushBook(
    device: PairedDevice,
    book: SyncBook,
    files: readonly SyncFile[],
  ): Promise<void> {
    const controlKey = await deriveSessionKey(device.secret, KEY_INFO.control);
    const fileKey = await deriveSessionKey(device.secret, KEY_INFO.files);

    const head = await sealJson(controlKey, {
      action: 'book',
      book: {
        id: book.id,
        title: book.title,
        pageCount: book.pageCount,
        model: book.model,
        scale: book.scale,
      },
      fileCount: files.length,
    });
    await this.post(device, '/book', head);

    for (const file of files) {
      const body = await sealBytes(fileKey, file.bytes);
      await this.post(device, '/file', body, {
        'X-Emaki-Book': book.id,
        'X-Emaki-File': encodeURIComponent(file.name),
        'X-Emaki-Mime': encodeURIComponent(file.mime),
      });
    }

    const done = await sealJson(controlKey, { action: 'book-done', bookId: book.id });
    await this.post(device, '/book-done', done);
  }

  /**
   * POST an encrypted body to the receiver and return its raw reply.
   *
   * The device may be reachable on more than one address (Wi-Fi and mobile
   * data, say), so every candidate is tried until one answers.
   */
  private async post(
    device: PairedDevice,
    path: string,
    body: Uint8Array,
    headers: Record<string, string> = {},
  ): Promise<Uint8Array> {
    const hosts = device.hosts?.length ? device.hosts : [device.host];
    let lastError: unknown = null;
    for (const host of hosts) {
      try {
        return await this.postTo(host, device, path, body, headers);
      } catch (err) {
        lastError = err;
      }
    }
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Could not reach ${device.name} (${hosts.join(', ')}): ${reason}`);
  }

  private async postTo(
    host: string,
    device: PairedDevice,
    path: string,
    body: Uint8Array,
    headers: Record<string, string> = {},
  ): Promise<Uint8Array> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`http://${host}:${device.port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream', ...headers },
        body: body as unknown as BodyInit,
        signal: controller.signal,
        // The receiver is reached by IP on the LAN; keep it off CORS entirely
        // (this transport is used from a browser, which would otherwise need
        // the receiver to answer preflight requests).
        mode: 'cors',
        cache: 'no-store',
      });
      if (!response.ok) {
        throw new Error(`The device answered ${response.status}.`);
      }
      const buffer = await response.arrayBuffer();
      return new Uint8Array(buffer);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not reach ${device.name} (${host}:${device.port}): ${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
