/**
 * Wire format for device pairing.
 *
 * The phone (receiver) mints a one-time pairing payload and shows it as a QR
 * code / short text. The PC (sender) scans or pastes it, derives a shared
 * session key from the payload's secret, and can then push files to the phone.
 *
 * The payload never travels over the network: it is handed over directly
 * (camera, or copy/paste), so the secret is only ever known to the two devices.
 */

/** How much reach a paired device is allowed to use. */
export type SyncMode =
  /** Only this computer (identified by its install id) may push. */
  | 'this-computer'
  /** Direct LAN only — the phone refuses connections from outside the LAN. */
  | 'home-network'
  /** Anywhere: needs a relay; the transport layer decides how bytes travel. */
  | 'anywhere';

export const SYNC_MODE_LABELS: Record<SyncMode, string> = {
  'this-computer': 'This computer only',
  'home-network': 'Home network only',
  anywhere: 'Anywhere',
};

export const SYNC_MODE_HINTS: Record<SyncMode, string> = {
  'this-computer':
    'This pairing is bound to this computer. Nothing is accepted from another machine.',
  'home-network':
    'Direct connection over your local network. Nothing leaves the LAN.',
  anywhere:
    'Reach the device over the internet through a relay. Traffic stays end-to-end encrypted.',
};

/** Prefix of the encoded payload; lets us reject foreign codes early. */
export const PAIRING_PREFIX = 'emaki-pair-v1.';

/** One-time pairing payload, minted by the device that can be reached. */
export interface PairingPayload {
  /** Format version. */
  readonly v: 1;
  /** Stable id of the receiving device. */
  readonly id: string;
  /** Human-readable device name ("Pixel 8"). */
  readonly name: string;
  /** Reach allowed for this pairing. */
  readonly mode: SyncMode;
  /** Host the receiver listens on (LAN address, or a relay host). */
  readonly host: string;
  /** Every address the receiver can be reached on, best first. */
  readonly hosts?: readonly string[];
  /** TCP port the receiver listens on. */
  readonly port: number;
  /** Base64 32-byte shared secret. */
  readonly secret: string;
  /** Expiry (epoch ms). */
  readonly exp: number;
}

/** A device this computer is paired with. */
export interface PairedDevice {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  /** Every address the device can be reached on, best first. */
  readonly hosts?: readonly string[];
  readonly port: number;
  readonly mode: SyncMode;
  /** Base64 32-byte shared secret. */
  readonly secret: string;
  /** Epoch ms. */
  readonly pairedAt: number;
  /** Epoch ms of the last successful contact, or null. */
  readonly lastSeenAt: number | null;
}

/** Encode a payload into the text that goes into the QR code. */
export function encodePairingPayload(payload: PairingPayload): string {
  const json = JSON.stringify(payload);
  return `${PAIRING_PREFIX}${base64UrlEncode(new TextEncoder().encode(json))}`;
}

/** Parse the text from a QR code / paste box. Throws on anything unexpected. */
export function decodePairingPayload(text: string): PairingPayload {
  const trimmed = text.trim();
  const prefix = PAIRING_PREFIX;
  if (!trimmed.startsWith(prefix)) {
    throw new Error('That does not look like an Emaki pairing code.');
  }
  let json: string;
  try {
    json = new TextDecoder().decode(base64UrlDecode(trimmed.slice(prefix.length)));
  } catch {
    throw new Error('The pairing code is damaged.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('The pairing code is damaged.');
  }
  return validatePayload(raw);
}

function validatePayload(raw: unknown): PairingPayload {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('The pairing code is damaged.');
  }
  const p = raw as Record<string, unknown>;
  const mode = p['mode'];
  if (
    p['v'] !== 1 ||
    typeof p['id'] !== 'string' ||
    typeof p['name'] !== 'string' ||
    typeof p['host'] !== 'string' ||
    typeof p['port'] !== 'number' ||
    typeof p['secret'] !== 'string' ||
    typeof p['exp'] !== 'number' ||
    (mode !== 'this-computer' && mode !== 'home-network' && mode !== 'anywhere')
  ) {
    throw new Error('The pairing code is damaged.');
  }
  const hosts = Array.isArray(p['hosts'])
    ? (p['hosts'] as unknown[]).filter((h): h is string => typeof h === 'string')
    : undefined;
  return {
    v: 1,
    id: p['id'],
    name: p['name'],
    mode,
    host: p['host'],
    hosts,
    port: p['port'],
    secret: p['secret'],
    exp: p['exp'],
  };
}

/** True when the payload is still usable (not expired). */
export function isPairingValid(payload: PairingPayload, now = Date.now()): boolean {
  return payload.exp > now;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function base64Encode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function base64Decode(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
