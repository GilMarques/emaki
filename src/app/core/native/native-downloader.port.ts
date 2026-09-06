/**
 * Port for file downloads that survive the app losing focus.
 *
 * Android is backed by `@capgo/capacitor-downloader` (system `DownloadManager`,
 * which keeps transferring when the app is backgrounded or closed). The web
 * build falls back to `ConnectorRequestService.fetchImage` + blob URLs so
 * `ionic serve` still works — downloads there are session-only.
 */
import { InjectionToken } from '@angular/core';

export interface NativeDownload {
  readonly id: string;
  readonly progress: number;
  readonly state: 'PENDING' | 'RUNNING' | 'PAUSED' | 'DONE' | 'ERROR';
}

export interface NativeDownloadStartOptions {
  /** Unique task id (e.g. `chapterId:p3`). */
  readonly id: string;
  readonly url: string;
  /** Local path where the file is saved (see DownloadStore). */
  readonly destination: string;
  readonly headers?: Record<string, string>;
}

export interface NativeDownloaderPort {
  /** Start (or re-queue) a download task. */
  start(options: NativeDownloadStartOptions): Promise<NativeDownload>;
  pause(id: string): Promise<void>;
  resume(id: string): Promise<void>;
  /** Cancel permanently; any partial file is removed. */
  stop(id: string): Promise<void>;
  checkStatus(id: string): Promise<NativeDownload>;
  getFileInfo(path: string): Promise<{ size: number; type: string }>;
  /**
   * Progress callback fired by the underlying engine. Return the unsubscribe
   * handle so the caller can stop listening later.
   */
  onProgress(cb: (d: { id: string; progress: number }) => void): () => void;
  onCompleted(cb: (d: { id: string }) => void): () => void;
  onFailed(cb: (d: { id: string; error: string }) => void): () => void;
}

export const NATIVE_DOWNLOADER = new InjectionToken<NativeDownloaderPort>('NATIVE_DOWNLOADER');