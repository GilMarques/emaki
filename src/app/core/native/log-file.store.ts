import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';

/**
 * Rotation cap for the log file. One file, one backup: past ~3 MB the oldest
 * session is dropped. Debug logs are not an archive.
 */
const MAX_FILE_BYTES = 1_500_000;

const LOG_DIR = 'emaki-logs';
const LOG_FILE = 'emaki.log';
const ROTATED_FILE = 'emaki.log.1';

/** Remembers that the directory exists, so a restart does not re-create it. */
const DIRECTORY_FLAG = 'openviewer:logs-dir';

/** Remembers that a rotated file exists, so reading a missing one is skipped. */
const ROTATED_FLAG = 'openviewer:logs-rotated';

/**
 * Typed wrapper around the Capacitor Filesystem for the on-device debug log.
 *
 * The log lives in `Directory.Data` (app-private, survives restarts, needs no
 * permission) and is written as JSON lines so a partially flushed tail can be
 * discarded line by line. On the web this class is inert — there is no
 * persistent file to write into.
 */
export class LogFileStore {
  public readonly available = Capacitor.isNativePlatform();

  private directoryReady = false;
  private appendedOnce = false;

  /** Append text (one or more lines) and rotate first when the file is full. */
  public async append(text: string): Promise<void> {
    if (!this.available) return;
    await this.ensureDirectory();
    // The first append of a session cannot rotate: probing a file that may
    // not exist yet turns a normal fresh start into a logged plugin error.
    if (this.appendedOnce) {
      await this.rotateIfNeeded();
    } else {
      this.appendedOnce = true;
    }
    try {
      await this.appendLine(text);
    } catch {
      // The directory can disappear (restored data, manual cleanup). Recreate
      // it once and retry rather than silently dropping the log.
      this.directoryReady = false;
      forgetDirectory();
      await this.makeDirectory();
      await this.appendLine(text);
    }
  }

  /** Both the current and the rotated file, oldest first. Empty on failure. */
  public async readAll(): Promise<string> {
    if (!this.available) return '';
    const parts: string[] = [];
    // Reading a file that does not exist rejects, and the plugin echoes that
    // into the console (which the log capture would record). Only probe the
    // rotated file once a rotation has actually happened.
    const names = rememberedRotated() ? [ROTATED_FILE, LOG_FILE] : [LOG_FILE];
    for (const name of names) {
      try {
        const { data } = await Filesystem.readFile({
          path: `${LOG_DIR}/${name}`,
          directory: Directory.Data,
          encoding: Encoding.UTF8,
        });
        parts.push(typeof data === 'string' ? data : await data.text());
      } catch {
        // Missing file is the normal case on a fresh install.
      }
    }
    return parts.join('\n');
  }

  /** Delete both files. Never throws. */
  public async clear(): Promise<void> {
    if (!this.available) return;
    this.appendedOnce = false;
    forgetRotated();
    for (const name of [LOG_FILE, ROTATED_FILE]) {
      try {
        await Filesystem.deleteFile({
          path: `${LOG_DIR}/${name}`,
          directory: Directory.Data,
        });
      } catch {
        // Already gone.
      }
    }
  }

  /** Absolute `file://` URI of the current log, or null when unavailable. */
  public async uri(): Promise<string | null> {
    if (!this.available) return null;
    try {
      const { uri } = await Filesystem.getUri({
        path: `${LOG_DIR}/${LOG_FILE}`,
        directory: Directory.Data,
      });
      return uri;
    } catch {
      return null;
    }
  }

  private appendLine(text: string): Promise<void> {
    return Filesystem.appendFile({
      path: `${LOG_DIR}/${LOG_FILE}`,
      data: text,
      directory: Directory.Data,
      encoding: Encoding.UTF8,
    });
  }

  private async ensureDirectory(): Promise<void> {
    if (this.directoryReady) return;
    if (rememberedDirectory()) {
      this.directoryReady = true;
      return;
    }
    await this.makeDirectory();
  }

  private async makeDirectory(): Promise<void> {
    try {
      await Filesystem.mkdir({
        path: LOG_DIR,
        directory: Directory.Data,
        recursive: true,
      });
    } catch {
      // Already there, or not creatable — the append will report the truth.
    }
    this.directoryReady = true;
    rememberDirectory();
  }

  private async rotateIfNeeded(): Promise<void> {
    let size = 0;
    try {
      const stat = await Filesystem.stat({
        path: `${LOG_DIR}/${LOG_FILE}`,
        directory: Directory.Data,
      });
      size = stat.size ?? 0;
    } catch {
      return; // No file yet.
    }
    if (size < MAX_FILE_BYTES) return;

    try {
      await Filesystem.deleteFile({
        path: `${LOG_DIR}/${ROTATED_FILE}`,
        directory: Directory.Data,
      });
    } catch {
      // Nothing to replace.
    }
    try {
      await Filesystem.rename({
        from: `${LOG_DIR}/${LOG_FILE}`,
        to: `${LOG_DIR}/${ROTATED_FILE}`,
        directory: Directory.Data,
        toDirectory: Directory.Data,
      });
      rememberRotated();
    } catch {
      // If the rename fails, append to the current file instead of losing lines.
    }
  }
}

/**
 * `mkdir` is not idempotent in the native plugin (it rejects when the folder
 * exists), and a rejected plugin call is echoed to the console — which the log
 * capture would then record as an error on every launch. A localStorage flag
 * keeps ordinary restarts quiet; the append path re-creates the folder if it
 * ever actually goes missing.
 */
function rememberedDirectory(): boolean {
  try {
    return localStorage.getItem(DIRECTORY_FLAG) === '1';
  } catch {
    return false;
  }
}

function rememberDirectory(): void {
  try {
    localStorage.setItem(DIRECTORY_FLAG, '1');
  } catch {
    // Storage unavailable — mkdir will simply run next time.
  }
}

function forgetDirectory(): void {
  try {
    localStorage.removeItem(DIRECTORY_FLAG);
  } catch {
    // Nothing to forget.
  }
}

function rememberedRotated(): boolean {
  try {
    return localStorage.getItem(ROTATED_FLAG) === '1';
  } catch {
    return false;
  }
}

function rememberRotated(): void {
  try {
    localStorage.setItem(ROTATED_FLAG, '1');
  } catch {
    // Storage unavailable — the next read simply reports the file as missing.
  }
}

function forgetRotated(): void {
  try {
    localStorage.removeItem(ROTATED_FLAG);
  } catch {
    // Nothing to forget.
  }
}
