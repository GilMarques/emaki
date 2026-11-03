import { Injectable, computed, signal } from '@angular/core';

import type { MegaStorage } from './mega-account.blob-store';
import { MegaAccountBlobStore } from './mega-account.blob-store';
import { describeMegaError, isTwoFactorError } from './mega-node.io';

/**
 * The MEGA account a publishing device signs in to.
 *
 * The password is used once, to log in, and then thrown away: what is kept is
 * the *session token* from `storage.toJSON()`, which MEGA can revoke from the
 * account's Security page without the password changing. Everything else —
 * uploads, folders, deletes — happens through `MegaAccountBlobStore`.
 *
 * Signing in here is a deliberate, computer-only decision: a reader device
 * uses a folder link and never holds a credential.
 */

const STORAGE_KEY = 'emaki:mega-account:v1';

/** What survives a reload: who, and a revocable session. */
export interface MegaAccount {
  readonly email: string;
  /** JSON from `storage.toJSON()`. A bearer credential — treat it as one. */
  readonly session: string;
  readonly savedAt: number;
}

/** Raised when MEGA wants a two-factor code before it will finish a login. */
export const TWO_FACTOR_REQUIRED = 'TwoFactorRequired';

@Injectable({ providedIn: 'root' })
export class MegaAccountService {
  private readonly _account = signal<MegaAccount | null>(loadAccount());

  /** The saved account, or null when this device is signed out. */
  public readonly account = this._account.asReadonly();
  public readonly signedIn = computed(() => this._account() !== null);

  /** Live client, kept so a second call does not re-login. */
  private live: MegaStorage | null = null;
  private loading: Promise<MegaStorage> | null = null;

  /** Log in with an email and password (plus a code when MEGA asks). */
  public async signIn(email: string, password: string, code?: string): Promise<void> {
    const trimmed = email.trim();
    if (trimmed === '' || password === '') {
      throw new Error('Enter your MEGA email and password.');
    }
    let storage: MegaStorage;
    try {
      storage = await this.openSession(trimmed, password, code);
    } catch (error) {
      throw isTwoFactorError(error) ? twoFactorError() : describeMegaError(error);
    }
    this.adopt(trimmed, storage);
  }

  /**
   * A live client, restoring the saved session if this is a fresh launch.
   * A restored session that MEGA has revoked throws; the caller should then
   * sign in again.
   */
  public async storage(): Promise<MegaStorage> {
    if (this.live !== null) return this.live;
    const account = this._account();
    if (account === null) throw new Error('Sign in to MEGA first.');
    this.loading ??= this.reviveSession(account.session)
      .then((storage) => {
        this.live = storage;
        this.loading = null;
        return storage;
      })
      .catch((error: unknown) => {
        this.loading = null;
        throw describeMegaError(error);
      });
    return this.loading;
  }

  /** The account as a writable store, for publishing. */
  public async store(): Promise<MegaAccountBlobStore> {
    return new MegaAccountBlobStore(await this.storage());
  }

  public async signOut(): Promise<void> {
    const live = this.live;
    this.live = null;
    this.loading = null;
    this._account.set(null);
    persist(null);
    try {
      await live?.close?.();
    } catch {
      // Best effort: the local session is already gone, which is what matters.
    }
  }

  /** Test seam: starts a real MEGA session. */
  protected async openSession(
    email: string,
    password: string,
    code?: string,
  ): Promise<MegaStorage> {
    const { Storage } = await import('megajs');
    const storage = await new Storage({
      email,
      password,
      ...(code === undefined || code === '' ? {} : { secondFactorCode: code }),
    }).ready;
    return storage as unknown as MegaStorage;
  }

  /** Test seam: re-attaches to a saved session without the password. */
  protected async reviveSession(session: string): Promise<MegaStorage> {
    const { Storage } = await import('megajs');
    const storage = Storage.fromJSON(JSON.parse(session)) as unknown as MegaStorage & {
      reload(): Promise<unknown>;
    };
    await storage.reload();
    return storage;
  }

  private adopt(email: string, storage: MegaStorage): void {
    const account: MegaAccount = {
      email,
      session: JSON.stringify(storage.toJSON()),
      savedAt: Date.now(),
    };
    this.live = storage;
    this.loading = null;
    this._account.set(account);
    persist(account);
  }
}

function twoFactorError(): Error {
  const error = new Error('MEGA sent a two-factor code request.');
  error.name = TWO_FACTOR_REQUIRED;
  return error;
}

function loadAccount(): MegaAccount | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const value = parsed as Record<string, unknown>;
    if (
      typeof value['email'] !== 'string' ||
      typeof value['session'] !== 'string' ||
      typeof value['savedAt'] !== 'number'
    ) {
      return null;
    }
    return { email: value['email'], session: value['session'], savedAt: value['savedAt'] };
  } catch {
    return null;
  }
}

function persist(account: MegaAccount | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (account === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(account));
  } catch {
    // Quota or disabled storage: the session lasts this run only.
  }
}
