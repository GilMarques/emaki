import type {
  ArchiveInfo,
  FileSystemBrowser,
  FsEntry,
} from './file-system-browser.port';

/**
 * Web/debug fallback: the file browser is unavailable outside the Tauri host, so
 * the `Files` tab hides itself and the preset Library is the only entry point.
 */
export class UnavailableFsBrowser implements FileSystemBrowser {
  readonly id = 'none';

  isAvailable(): boolean {
    return false;
  }

  async pickDirectory(): Promise<string | null> {
    return null;
  }

  async listDirectory(_path: string): Promise<readonly FsEntry[]> {
    return [];
  }

  async readFile(_path: string): Promise<Blob> {
    throw new Error('File browser unavailable in this build');
  }

  async stat(_path: string): Promise<number | null> {
    return null;
  }

  async openArchive(_path: string): Promise<ArchiveInfo> {
    throw new Error('File browser unavailable in this build');
  }

  async cleanupArchive(_tempDir: string): Promise<void> {
    // nothing to clean up outside Tauri
  }
}
