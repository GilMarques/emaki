import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * Typed proxy for the native `SyncEndpoint` plugin (see native/sync-endpoint).
 *
 * The plugin runs a small encrypted HTTP endpoint on the device so a paired
 * computer can hand over processed pages. It only exists on Android; on the
 * web the plugin is absent and the pairing code is scanned instead.
 */
export interface SyncEndpointPlugin {
  /** Open the endpoint; returns the one-time pairing payload. */
  start(args: { mode: string }): Promise<{
    id: string;
    name: string;
    host: string;
    port: number;
    secret: string;
    payload: string;
    expiresAt: number;
  }>;
  /** Close the endpoint. */
  stop(): Promise<void>;
  /** The paired computer and the books received so far. */
  status(): Promise<{
    paired: boolean;
    computerName: string | null;
    books: { id: string; title: string }[];
  }>;
  /** Forget the pairing and delete the received books. */
  forget(): Promise<void>;
}

const SyncEndpoint = registerPlugin<SyncEndpointPlugin>('SyncEndpoint');

/** True when this build can run a local endpoint (Android only). */
export function canRunEndpoint(): boolean {
  return Capacitor.isNativePlatform();
}

/** Open the endpoint and return the pairing payload to show as a QR code. */
export async function startEndpoint(mode: string): Promise<{
  id: string;
  name: string;
  host: string;
  port: number;
  secret: string;
  payload: string;
  expiresAt: number;
}> {
  return SyncEndpoint.start({ mode });
}

export async function stopEndpoint(): Promise<void> {
  return SyncEndpoint.stop();
}

export async function endpointStatus(): Promise<{
  paired: boolean;
  computerName: string | null;
  books: { id: string; title: string }[];
}> {
  return SyncEndpoint.status();
}

export async function forgetEndpoint(): Promise<void> {
  return SyncEndpoint.forget();
}
