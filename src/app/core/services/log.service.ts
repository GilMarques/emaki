import { Injectable, OnDestroy, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';

import {
  LOG_CAPACITY,
  appendLog,
  clearEntries,
  entriesSince,
  formatEntryText,
  getEntries,
  latestEntryId,
  parseJsonLines,
  subscribeLogs,
  toJsonLine,
  type LogEntry,
} from '../debug/log-store';
import { LogFileStore } from '../native/log-file.store';

/** Which set of logs the viewer is showing. */
export type LogSource = 'session' | 'device';

/** Coalesce file writes; page turns and downloads can log in bursts. */
const FLUSH_INTERVAL_MS = 1000;

/**
 * Debug logging: buffers console output and uncaught errors, mirrors them to a
 * rotating file on the device, and exposes them to the in-app log viewer.
 *
 * The capture itself lives in `core/debug/log-store` and is installed from
 * `main.ts` before Angular boots. This service adds the Angular-facing
 * signals and the file sink:
 *
 *  - `entries`  — this session, in memory (2000 lines, newest last)
 *  - `history`  — what is actually on disk, loaded on demand
 *
 * The file is app-private (`Directory.Data/emaki-logs/emaki.log`), capped at
 * 1.5 MB and rotated once. No permission prompt, survives restarts, and can be
 * pulled off a debug build with `adb exec-out run-as <package> cat ...`.
 */
@Injectable({ providedIn: 'root' })
export class LogService implements OnDestroy {
  /** This session's entries, newest last. */
  public readonly entries = signal<readonly LogEntry[]>(getEntries());

  /** Entries read back from the on-device file (empty on web/Tauri). */
  public readonly history = signal<readonly LogEntry[]>([]);

  /** True when there is a persistent log file (Capacitor native only). */
  public readonly persisted: boolean;

  /** `file://` URI of the log file once resolved. */
  public readonly filePath = signal<string | null>(null);

  private readonly file = new LogFileStore();
  private readonly unsubscribe: () => void;
  private readonly timer: ReturnType<typeof setInterval> | null = null;

  private lastFlushedId = latestEntryId();
  private flushChain: Promise<void> = Promise.resolve();
  private warnedWriteFailure = false;

  constructor() {
    this.persisted = this.file.available;
    this.unsubscribe = subscribeLogs(() => this.entries.set(getEntries()));

    appendLog('info', 'session', 'Session start', {
      platform: Capacitor.getPlatform(),
      url: typeof location === 'undefined' ? 'n/a' : location.href,
      viewport:
        typeof window === 'undefined'
          ? 'n/a'
          : `${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}x`,
      language: typeof navigator === 'undefined' ? 'n/a' : navigator.language,
      userAgent: typeof navigator === 'undefined' ? 'n/a' : navigator.userAgent,
    });
    this.entries.set(getEntries());

    if (!this.file.available) return;

    void this.file.uri().then((uri) => {
      if (uri === null) return;
      this.filePath.set(uri);
      this.info('logs', `Writing logs to ${uri}`);
    });
    this.timer = setInterval(() => void this.flushNow(), FLUSH_INTERVAL_MS);

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  public ngOnDestroy(): void {
    this.unsubscribe();
    if (this.timer !== null) clearInterval(this.timer);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.onVisibilityChange);
    }
  }

  // ──────────────────────── Logging API ────────────────────────

  /** Structured log line, tagged and without a console echo. */
  public info(tag: string, message: string, detail?: unknown): void {
    appendLog('info', tag, message, detail);
  }

  public warn(tag: string, message: string, detail?: unknown): void {
    appendLog('warn', tag, message, detail);
  }

  public error(tag: string, message: string, detail?: unknown): void {
    appendLog('error', tag, message, detail);
  }

  public debug(tag: string, message: string, detail?: unknown): void {
    appendLog('debug', tag, message, detail);
  }

  // ──────────────────────── Reading ────────────────────────

  /** Entries for one source, oldest first. */
  public listFor(source: LogSource): readonly LogEntry[] {
    return source === 'session' ? this.entries() : this.history();
  }

  /** Plain-text dump of one source, one entry per line. */
  public textFor(source: LogSource): string {
    return this.listFor(source).map(formatEntryText).join('\n');
  }

  /** Load the on-device file (flushing pending lines first). */
  public async loadHistory(): Promise<void> {
    if (!this.file.available) return;
    await this.flushNow();
    const text = await this.file.readAll();
    this.history.set(parseJsonLines(text).slice(-LOG_CAPACITY));
    const uri = await this.file.uri();
    if (uri !== null) this.filePath.set(uri);
  }

  /** Copy one source to the clipboard. Returns false when it is empty. */
  public async copy(source: LogSource): Promise<boolean> {
    const text = this.textFor(source);
    if (text.trim() === '') return false;
    return copyText(text);
  }

  /** Delete both log files and the in-memory buffer. */
  public async clearAll(): Promise<void> {
    // Serialize with in-flight flushes so a write cannot land after the delete.
    this.flushChain = this.flushChain
      .then(() => this.file.clear())
      .catch(() => undefined);
    await this.flushChain;

    clearEntries();
    this.lastFlushedId = 0;
    this.history.set([]);
    appendLog('info', 'logs', 'Debug log cleared');
    await this.flushNow();
  }

  // ──────────────────────── File sink ────────────────────────

  /** Write pending lines now. Serialized — safe to call from anywhere. */
  public flushNow(): Promise<void> {
    if (!this.file.available) return Promise.resolve();
    this.flushChain = this.flushChain
      .then(() => this.flushOnce())
      .catch(() => undefined);
    return this.flushChain;
  }

  private async flushOnce(): Promise<void> {
    const fresh = entriesSince(this.lastFlushedId);
    if (fresh.length === 0) return;
    try {
      await this.file.append(fresh.map(toJsonLine).join('\n') + '\n');
      this.lastFlushedId = fresh[fresh.length - 1].id;
    } catch (err) {
      // One warning per session: retrying on every tick would spam the log
      // with its own write failures.
      if (!this.warnedWriteFailure) {
        this.warnedWriteFailure = true;
        appendLog('warn', 'logs', 'Could not write the log file', err);
      }
    }
  }

  /** Flush when the app goes to the background — the process may be killed. */
  private readonly onVisibilityChange = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      void this.flushNow();
    }
  };
}

/** Clipboard write with a `document.execCommand` fallback for old WebViews. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or insecure context — try the legacy path.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}
