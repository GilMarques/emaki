/**
 * End-to-end encryption for the device-sync tunnel.
 *
 * The pairing secret is a 32-byte random value that never leaves the two
 * devices (it travels in the QR code). From it both sides derive the same
 * AES-256-GCM key with HKDF-SHA256, so every request body on the wire is
 * ciphertext: a relay, a proxy or a passive LAN observer only sees noise.
 */
import { base64Decode } from './pairing.model';

const SALT = new TextEncoder().encode('emaki-pair-v1');
const IV_BYTES = 12;

/** Derive the session key for a direction-specific purpose. */
export async function deriveSessionKey(
  secretBase64: string,
  info: string,
): Promise<CryptoKey> {
  const secret = base64Decode(secretBase64);
  if (secret.length !== 32) {
    throw new Error('The pairing secret is not 32 bytes.');
  }
  const hkdf = await crypto.subtle.importKey(
    'raw',
    secret as unknown as BufferSource,
    { name: 'HKDF' },
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: SALT,
      info: new TextEncoder().encode(info),
    },
    hkdf,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Ciphertext with its nonce prefixed, ready to be sent as a binary body. */
export interface SealedBytes {
  readonly iv: Uint8Array;
  readonly ciphertext: Uint8Array;
}

export async function seal(key: CryptoKey, data: Uint8Array): Promise<SealedBytes> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const buffer = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource },
    key,
    data as unknown as BufferSource,
  );
  return { iv, ciphertext: new Uint8Array(buffer) };
}

export async function open(key: CryptoKey, sealed: SealedBytes): Promise<Uint8Array> {
  const buffer = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: sealed.iv as unknown as BufferSource },
    key,
    sealed.ciphertext as unknown as BufferSource,
  );
  return new Uint8Array(buffer);
}

/** Encrypt a JSON value into a binary body (`iv || ciphertext`). */
export async function sealJson(key: CryptoKey, value: unknown): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const { iv, ciphertext } = await seal(key, bytes);
  const out = new Uint8Array(iv.length + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, iv.length);
  return out;
}

/** Decrypt a body produced by `sealJson`. */
export async function openJson<T>(key: CryptoKey, body: Uint8Array): Promise<T> {
  if (body.length <= IV_BYTES) throw new Error('Encrypted body is truncated.');
  const iv = body.slice(0, IV_BYTES);
  const ciphertext = body.slice(IV_BYTES);
  const plain = await open(key, { iv, ciphertext });
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}

/** Encrypt raw file bytes into a binary body (`iv || ciphertext`). */
export async function sealBytes(key: CryptoKey, data: Uint8Array): Promise<Uint8Array> {
  const { iv, ciphertext } = await seal(key, data);
  const out = new Uint8Array(iv.length + ciphertext.length);
  out.set(iv, 0);
  out.set(ciphertext, iv.length);
  return out;
}

/** Decrypt a body produced by `sealBytes`. */
export async function openBytes(key: CryptoKey, body: Uint8Array): Promise<Uint8Array> {
  if (body.length <= IV_BYTES) throw new Error('Encrypted body is truncated.');
  const iv = body.slice(0, IV_BYTES);
  const ciphertext = body.slice(IV_BYTES);
  return open(key, { iv, ciphertext });
}
