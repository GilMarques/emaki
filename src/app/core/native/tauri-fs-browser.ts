import type {
  ArchiveInfo,
  FileSystemBrowser,
  FsEntry,
} from './file-system-browser.port';

type TauriInvoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Read `window.__TAURI__.core.invoke`, injected only when running inside Tauri. */
function getInvoke(): TauriInvoke | null {
  const w = window as unknown as {
    __TAURI__?: { core?: { invoke: TauriInvoke; convertFileSrc?: (p: string) => string } };
  };
  return w.__TAURI__?.core?.invoke ?? null;
}

/**
 * Desktop backend: forwards filesystem operations to the Rust host. No
 * `@tauri-apps/api` import — we use the global injected by `app.withGlobalTauri`
 * so the web/debug build never hard-depends on Tauri. Blob bytes are returned
 * across the bridge and turned into object URLs by the resolver.
 */
export class TauriFsBrowser implements FileSystemBrowser {
  readonly id = 'tauri-fs';

  isAvailable(): boolean {
    return getInvoke() !== null;
  }

  private async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const inv = getInvoke();
    if (!inv) throw new Error('Tauri invoke unavailable');
    return inv(cmd, args) as Promise<T>;
  }

  pickDirectory(): Promise<string | null> {
    return this.invoke<string | null>('pick_directory');
  }

  listDirectory(path: string): Promise<readonly FsEntry[]> {
    return this.invoke<FsEntry[]>('list_directory', { path });
  }

  async readFile(path: string): Promise<Blob> {
    const bytes = (await this.invoke<number[] | Uint8Array>('read_file', {
      path,
    })) as ArrayLike<number>;
    return new Blob([new Uint8Array(bytes)]);
  }

  async stat(path: string): Promise<number | null> {
    const size = await this.invoke<number | null>('stat_file', { path });
    return size;
  }

  openArchive(path: string): Promise<ArchiveInfo> {
    return this.invoke<ArchiveInfo>('open_archive', { path });
  }

  cleanupArchive(tempDir: string): Promise<void> {
    return this.invoke<void>('cleanup_archive', { tempDir });
  }

  convertFileSrc(path: string): string | null {
    const w = window as unknown as {
      __TAURI__?: { core?: { convertFileSrc?: (p: string) => string } };
    };
    return w.__TAURI__?.core?.convertFileSrc?.(path) ?? null;
  }
}
