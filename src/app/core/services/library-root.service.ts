import { Injectable, signal } from '@angular/core';

const ROOT_KEY = 'openviewer:library-root';

/**
 * Remembers the user's chosen library root folder (a real filesystem path on
 * desktop). Persisted so the shelf rebuilds from the same folder across
 * restarts. No new dependency — `localStorage` is available in both the web
 * dev build and the Tauri webview.
 */
@Injectable({ providedIn: 'root' })
export class LibraryRootService {
  private readonly _root = signal<string | null>(this.load());
  public readonly root = this._root.asReadonly();

  private load(): string | null {
    try {
      return localStorage.getItem(ROOT_KEY);
    } catch {
      return null;
    }
  }

  public setRoot(path: string): void {
    this._root.set(path);
    try {
      localStorage.setItem(ROOT_KEY, path);
    } catch {
      // persistence is best-effort
    }
  }

  public clear(): void {
    this._root.set(null);
    try {
      localStorage.removeItem(ROOT_KEY);
    } catch {
      // ignore
    }
  }
}
