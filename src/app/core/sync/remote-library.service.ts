import { Injectable, computed, signal } from '@angular/core';

/**
 * Where this device reads page packs from.
 *
 * v1 speaks MEGA folder links: the computer exports the `Emaki/` folder once
 * and every device that reads pastes the same link. Exported MEGA folders are
 * read-only by design, so a reader can never damage the library — and no
 * account credential has to leave the computer that owns it.
 *
 * This service deliberately holds the *target* (kind + handle + key), not a
 * transport. The download engine asks it where to read from, so supporting an
 * S3 bucket later is one more `kind` here instead of a rewrite of the page.
 */

const STORAGE_KEY = 'emaki:remote-library:v1';

/** Folder handles are short and case-sensitive; link keys are base64url. */
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{6,}$/;
const KEY_PATTERN = /^[A-Za-z0-9_-]{16,}$/;

export type RemoteLibraryKind = 'mega-folder-link';

/** The remote source a device downloads packs from. */
export interface RemoteLibrary {
  readonly kind: RemoteLibraryKind;
  /** Normalised share link, safe to show and to store again. */
  readonly url: string;
  /** Handle of the folder the link points at. */
  readonly handle: string;
  /** Folder key from the link's fragment; it decrypts the shared subtree. */
  readonly key: string;
  /** Epoch ms the link was saved. */
  readonly addedAt: number;
}

/** Outcome of validating a pasted link. */
export type ConnectResult =
  | { readonly ok: true; readonly library: RemoteLibrary }
  | { readonly ok: false; readonly reason: string };

/**
 * Read a MEGA folder share link.
 *
 * Accepts the link with or without a scheme, and the nested form MEGA hands
 * out for a subfolder of a share (`/folder/A/folder/B#key`): the fragment key
 * belongs to the innermost folder, so the last `folder/<handle>` pair wins.
 */
export function parseMegaFolderLink(input: string, now = Date.now()): ConnectResult {
  const trimmed = input.trim();
  if (trimmed === '') {
    return { ok: false, reason: 'Paste the folder link from MEGA first.' };
  }

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return { ok: false, reason: 'That does not look like a link.' };
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'mega.nz' && host !== 'mega.io') {
    return { ok: false, reason: 'Only MEGA folder links are supported right now.' };
  }

  const segments = url.pathname.split('/').filter((part) => part.length > 0);
  if (segments[0] === 'file') {
    return { ok: false, reason: 'That is a file link. Share the folder itself instead.' };
  }

  let handle: string | undefined;
  for (let i = 0; i + 1 < segments.length; i += 1) {
    if (segments[i] === 'folder') handle = segments[i + 1];
  }
  if (handle === undefined || !HANDLE_PATTERN.test(handle)) {
    return { ok: false, reason: 'That is not a MEGA folder link.' };
  }

  const key = url.hash.replace(/^#/, '');
  if (key === '') {
    return { ok: false, reason: 'The link is missing its key. Copy it from MEGA’s Share menu.' };
  }
  if (!KEY_PATTERN.test(key)) {
    return { ok: false, reason: 'The key at the end of the link is not valid.' };
  }

  return {
    ok: true,
    library: {
      kind: 'mega-folder-link',
      url: `https://mega.nz/folder/${handle}#${key}`,
      handle,
      key,
      addedAt: now,
    },
  };
}

@Injectable({ providedIn: 'root' })
export class RemoteLibraryService {
  private readonly _library = signal<RemoteLibrary | null>(loadStored());

  /** The configured remote source, or null when nothing is set up yet. */
  public readonly library = this._library.asReadonly();
  /** True once this device knows where to download packs from. */
  public readonly hasLibrary = computed(() => this._library() !== null);

  /**
   * Validate and store a folder link. Connecting again replaces the previous
   * target: exporting a folder produces a new key, and the newest link is
   * always the one the user just copied.
   */
  public connect(link: string): ConnectResult {
    const result = parseMegaFolderLink(link, Date.now());
    if (!result.ok) return result;
    this._library.set(result.library);
    persist(result.library);
    return result;
  }

  /** Stop reading from the remote. Packs already on disk stay there. */
  public forget(): void {
    this._library.set(null);
    persist(null);
  }
}

function loadStored(): RemoteLibrary | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isRemoteLibrary(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function persist(library: RemoteLibrary | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (library === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(library));
  } catch {
    // Quota exceeded or storage disabled: the target stays for this session.
  }
}

function isRemoteLibrary(value: unknown): value is RemoteLibrary {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v['kind'] === 'mega-folder-link' &&
    typeof v['url'] === 'string' &&
    typeof v['handle'] === 'string' &&
    typeof v['key'] === 'string' &&
    typeof v['addedAt'] === 'number'
  );
}
