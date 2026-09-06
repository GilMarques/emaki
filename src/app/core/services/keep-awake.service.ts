import { Injectable } from '@angular/core';

/** Minimal Screen Wake Lock sentinel (the DOM lib may not type it yet). */
interface WakeLockSentinel {
  readonly released: boolean;
  release(): Promise<void>;
  onrelease: (() => void) | null;
}

type WakeLockNavigator = Navigator & {
  wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinel> };
};

/**
 * Keeps the device screen on while reading via the Screen Wake Lock API
 * (Chromium WebView). The lock is only held while a consumer calls
 * {@link enable}; it is automatically released when the app leaves the
 * foreground (correct — nothing to keep awake off-screen), and re-acquired
 * when the reader becomes visible again.
 */
@Injectable({ providedIn: 'root' })
export class KeepAwakeService {
  private wantOn = false;
  private sentinel: WakeLockSentinel | null = null;

  constructor() {
    if (typeof document === 'undefined') return;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.request();
    });
  }

  public enable(): void {
    if (this.wantOn) return;
    this.wantOn = true;
    void this.request();
  }

  public disable(): void {
    this.wantOn = false;
    const lock = this.sentinel;
    this.sentinel = null;
    if (lock) void lock.release().catch(() => undefined);
  }

  private async request(): Promise<void> {
    if (!this.wantOn || this.sentinel) return;
    const wl = (navigator as WakeLockNavigator).wakeLock;
    if (!wl) return;
    try {
      const lock = await wl.request('screen');
      if (!this.wantOn) {
        void lock.release().catch(() => undefined);
        return;
      }
      this.sentinel = lock;
      lock.onrelease = () => {
        if (this.sentinel === lock) this.sentinel = null;
      };
    } catch {
      // Unsupported or denied (e.g. low-power mode) — reading still works.
    }
  }
}