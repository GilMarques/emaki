/**
 * Transport between this computer (sender) and a paired device (receiver).
 *
 * The transport owns the *path* between the two devices; the payload is always
 * encrypted by `pairing.crypto`, so a transport never sees readable content —
 * that is what lets the same code work over a LAN, over a relay, or over
 * anything else that can move bytes.
 */
import type { PairedDevice } from './pairing.model';

/** One file to hand over to the receiving device. */
export interface SyncFile {
  /** File name on the receiver (unique inside the book). */
  readonly name: string;
  readonly bytes: Uint8Array;
  /** MIME type of the bytes (image/webp, image/png, …). */
  readonly mime: string;
}

/** Metadata of a book being handed over. */
export interface SyncBook {
  /** Stable id on the receiver (the sender's book id, hashed by the receiver). */
  readonly id: string;
  readonly title: string;
  /** Number of pages the book has. */
  readonly pageCount: number;
  /** Model / scale that produced the files, for the receiver's bookkeeping. */
  readonly model?: string;
  readonly scale?: number;
}

/** What the receiver reports back. */
export interface DeviceStatus {
  readonly deviceName: string;
  readonly pairedComputer: string | null;
  readonly books: readonly { readonly id: string; readonly title: string; readonly files: number }[];
}

export interface SyncTransport {
  readonly id: string;
  /**
   * Announce this computer to the receiver and complete the pairing.
   * `computerId` lets a receiver bind the pairing to one machine.
   */
  pair(device: PairedDevice, computerName: string, computerId: string): Promise<void>;
  /** Ask the receiver what it has. */
  status(device: PairedDevice): Promise<DeviceStatus>;
  /** Hand over one book (metadata + files). */
  pushBook(device: PairedDevice, book: SyncBook, files: readonly SyncFile[]): Promise<void>;
}
