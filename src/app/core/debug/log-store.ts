import { Capacitor } from '@capacitor/core';

/**
 * In-memory log store + console capture.
 *
 * This module is deliberately Angular-free so it can be installed in `main.ts`
 * before `bootstrapApplication` — that way errors thrown while Angular is
 * starting up are not lost. `LogService` wraps it with signals and file
 * persistence.
 *
 * Capture points:
 *  - `console.log|info|debug|warn|error` (arguments are formatted, not
 *    stringified by the platform — Android's WebView shows plain objects as
 *    `[object Object]`, which is useless in `adb logcat`)
 *  - `window.error` and `window.unhandledrejection`
 *
 * The buffer is capped: an app that logs in a loop cannot eat the heap.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  /** Monotonic id, unique for the lifetime of the process. */
  readonly id: number;
  /** Epoch milliseconds. */
  readonly ts: number;
  readonly level: LogLevel;
  /** Short source label: the `[tag]` prefix of the console call, or `app`. */
  readonly tag: string;
  readonly message: string;
  /** Formatted remaining arguments, or a stack for errors. */
  readonly detail: string | null;
}

/** Keep this many entries in memory; older ones are dropped. */
export const LOG_CAPACITY = 2000;

/** Individual fields are truncated to this length before they reach a file. */
const MAX_FIELD_CHARS = 4000;

/** How often subscribers are told the buffer changed. */
const NOTIFY_DELAY_MS = 150;

/** Leading `[tag]` in a console message, e.g. `[enhance] pump tick`. */
const TAG_PATTERN = /^\[([A-Za-z0-9_.-]{1,32})\]\s*/;

let entries: LogEntry[] = [];
let nextId = 1;
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
let captureInstalled = false;

const listeners = new Set<() => void>();

/** Append one structured entry and return it. */
export function appendLog(
  level: LogLevel,
  tag: string,
  message: string,
  detail?: unknown,
): LogEntry {
  const entry: LogEntry = {
    id: nextId++,
    ts: Date.now(),
    level,
    tag: normalizeTag(tag),
    message: truncate(message),
    detail: detail === undefined ? null : truncate(formatValue(detail)),
  };
  entries.push(entry);
  if (entries.length > LOG_CAPACITY) {
    entries.splice(0, entries.length - LOG_CAPACITY);
  }
  scheduleNotify();
  return entry;
}

/** Turn one `console.*` call into a structured entry. */
export function recordConsole(level: LogLevel, args: readonly unknown[]): void {
  const first = args[0];
  const rest = args.slice(1);
  let tag = 'app';
  let message = '';

  if (args.length === 0) {
    message = '';
  } else if (typeof first === 'string') {
    const match = TAG_PATTERN.exec(first);
    if (match) {
      tag = match[1];
      message = first.slice(match[0].length);
    } else {
      message = first;
    }
  } else {
    message = formatValue(first);
  }

  appendLog(
    level,
    tag,
    message,
    rest.length > 0 ? rest.map((arg) => formatValue(arg)).join(' ') : undefined,
  );
}

/**
 * Replace the console methods with capturing wrappers. Idempotent.
 *
 * On a native platform the original console is called with a single formatted
 * string: Capacitor forwards console output to logcat, where an object prints
 * as `[object Object]`. In the browser the untouched arguments are passed so
 * DevTools keeps its expandable objects.
 */
export function installLogCapture(): void {
  if (captureInstalled || typeof console === 'undefined') return;
  captureInstalled = true;

  const native = Capacitor.isNativePlatform();
  const methods: readonly (readonly [ConsoleMethod, LogLevel])[] = [
    ['log', 'info'],
    ['info', 'info'],
    ['debug', 'debug'],
    ['warn', 'warn'],
    ['error', 'error'],
  ];
  const target = console as unknown as Record<string, (...args: unknown[]) => void>;

  for (const [method, level] of methods) {
    const original = target[method].bind(console);
    target[method] = (...args: unknown[]): void => {
      try {
        recordConsole(level, args);
      } catch {
        // Logging must never be the reason the app fails.
      }
      if (native) {
        original(args.map((arg) => formatValue(arg)).join(' '));
      } else {
        original(...args);
      }
    };
  }

  if (typeof window === 'undefined') return;

  window.addEventListener('error', (event: ErrorEvent) => {
    if (!event.message) return;
    appendLog(
      'error',
      'window',
      event.message,
      event.error ?? `${event.filename}:${event.lineno}:${event.colno}`,
    );
  });

  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    appendLog('error', 'promise', 'Unhandled promise rejection', event.reason);
  });
}

/** Snapshot of the buffer, oldest first. */
export function getEntries(): readonly LogEntry[] {
  return entries.slice();
}

/** Every entry newer than `id`, oldest first. */
export function entriesSince(id: number): readonly LogEntry[] {
  return entries.filter((entry) => entry.id > id);
}

/** Id of the newest entry, or 0 when the buffer is empty. */
export function latestEntryId(): number {
  return entries.length > 0 ? entries[entries.length - 1].id : 0;
}

/** Drop everything currently buffered. Ids keep counting up. */
export function clearEntries(): void {
  entries = [];
  scheduleNotify();
}

/** Observe buffer changes (throttled). Returns an unsubscribe function. */
export function subscribeLogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** One human-readable line, used by the viewer and the clipboard export. */
export function formatEntryText(entry: LogEntry): string {
  const time = new Date(entry.ts).toISOString();
  const level = entry.level.toUpperCase().padEnd(5);
  const detail = entry.detail === null ? '' : ` | ${entry.detail}`;
  return `${time} ${level} [${entry.tag}] ${entry.message}${detail}`;
}

/** One JSON line, used by the on-device log file. */
export function toJsonLine(entry: LogEntry): string {
  return JSON.stringify({
    ts: entry.ts,
    level: entry.level,
    tag: entry.tag,
    message: entry.message,
    detail: entry.detail,
  });
}

/** Parse the on-device JSONL format. Malformed lines are skipped. */
export function parseJsonLines(text: string): LogEntry[] {
  const out: LogEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      if (typeof raw['ts'] !== 'number' || typeof raw['message'] !== 'string') continue;
      const level = raw['level'];
      out.push({
        id: -(out.length + 1),
        ts: raw['ts'],
        level:
          level === 'debug' || level === 'warn' || level === 'error' || level === 'info'
            ? level
            : 'info',
        tag: typeof raw['tag'] === 'string' ? raw['tag'] : 'app',
        message: raw['message'],
        detail: typeof raw['detail'] === 'string' ? raw['detail'] : null,
      });
    } catch {
      // Partially written line (the process died mid-flush) — skip it.
    }
  }
  return out;
}

/**
 * Best-effort human string for any console argument.
 *
 * Handles the values that `JSON.stringify` throws on (cycles), drops to
 * useless output (functions, typed arrays, blobs) or blows up the log with
 * DOM trees (elements).
 */
export function formatValue(value: unknown): string {
  try {
    return truncate(formatInner(value));
  } catch {
    return '[Unserializable value]';
  }
}

function formatInner(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
      return String(value);
    case 'bigint':
      return `${value}n`;
    case 'symbol':
      return value.toString();
    case 'function':
      return `[Function ${value.name || 'anonymous'}]`;
    default:
      break;
  }

  const obj = value as object;
  if (obj instanceof Error) {
    return `${obj.name}: ${obj.message}${obj.stack ? `\n${obj.stack}` : ''}`;
  }
  if (typeof Blob !== 'undefined' && obj instanceof Blob) {
    return `Blob(${obj.type || 'unknown'}, ${obj.size} B)`;
  }
  if (typeof ArrayBuffer !== 'undefined' && obj instanceof ArrayBuffer) {
    return `ArrayBuffer(${obj.byteLength} B)`;
  }
  if (ArrayBuffer.isView(obj)) {
    return `${obj.constructor.name}(${obj.byteLength} B)`;
  }
  if (obj instanceof Map || obj instanceof Set) {
    return `${obj.constructor.name}(${obj.size})`;
  }
  if (typeof Node !== 'undefined' && obj instanceof Node) {
    return `<${obj.nodeName.toLowerCase()}>`;
  }

  const json = JSON.stringify(obj, cycleReplacer());
  return json ?? Object.prototype.toString.call(obj);
}

/** Replacer that renders repeated references (including cycles) as a marker. */
function cycleReplacer(): (key: string, value: unknown) => unknown {
  const seen = new WeakSet<object>();
  return (_key, value) => {
    if (typeof value === 'bigint') return `${value}n`;
    if (typeof value === 'function') {
      return `[Function ${(value as { name?: string }).name || 'anonymous'}]`;
    }
    if (value !== null && typeof value === 'object') {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  };
}

function normalizeTag(tag: string): string {
  const cleaned = tag.toLowerCase().replace(/[^a-z0-9_.-]/g, '');
  return cleaned === '' ? 'app' : cleaned.slice(0, 32);
}

function truncate(text: string): string {
  if (text.length <= MAX_FIELD_CHARS) return text;
  return `${text.slice(0, MAX_FIELD_CHARS)}… (+${text.length - MAX_FIELD_CHARS} chars)`;
}

function scheduleNotify(): void {
  if (notifyTimer !== null) return;
  const run = (): void => {
    notifyTimer = null;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // A broken subscriber must not break logging.
      }
    }
  };
  if (typeof setTimeout === 'function') {
    notifyTimer = setTimeout(run, NOTIFY_DELAY_MS);
  } else {
    run();
  }
}

type ConsoleMethod = 'log' | 'info' | 'debug' | 'warn' | 'error';
