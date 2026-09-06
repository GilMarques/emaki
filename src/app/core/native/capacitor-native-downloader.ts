import { Injectable } from '@angular/core';
import { CapacitorDownloader } from '@capgo/capacitor-downloader';

import type {
  NativeDownload,
  NativeDownloaderPort,
  NativeDownloadStartOptions,
} from './native-downloader.port';

/**
 * Android implementation of the downloader port, backed by the system
 * `DownloadManager` through `@capgo/capacitor-downloader`. Transfers continue
 * when the app is backgrounded or closed, and files land on disk.
 *
 * Notification visibility is `'hidden'` (the plugin declares
 * `DOWNLOAD_WITHOUT_NOTIFICATION`), so no Android 13+ notification permission
 * is required — the in-app Manager page is the progress surface.
 */
@Injectable()
export class CapacitorNativeDownloader implements NativeDownloaderPort {
  public async start(options: NativeDownloadStartOptions): Promise<NativeDownload> {
    return CapacitorDownloader.download({
      id: options.id,
      url: options.url,
      destination: options.destination,
      headers: options.headers,
      network: 'cellular',
      notification: 'hidden',
    });
  }

  public async pause(id: string): Promise<void> {
    await CapacitorDownloader.pause({ id });
  }

  public async resume(id: string): Promise<void> {
    await CapacitorDownloader.resume({ id });
  }

  public async stop(id: string): Promise<void> {
    await CapacitorDownloader.stop({ id });
  }

  public async checkStatus(id: string): Promise<NativeDownload> {
    return CapacitorDownloader.checkStatus({ id });
  }

  public async getFileInfo(path: string): Promise<{ size: number; type: string }> {
    return CapacitorDownloader.getFileInfo({ path });
  }

  public onProgress(cb: (d: { id: string; progress: number }) => void): () => void {
    void CapacitorDownloader.addListener('downloadProgress', cb);
    return () => {
      void CapacitorDownloader.removeAllListeners();
    };
  }

  public onCompleted(cb: (d: { id: string }) => void): () => void {
    void CapacitorDownloader.addListener('downloadCompleted', cb);
    return () => {
      void CapacitorDownloader.removeAllListeners();
    };
  }

  public onFailed(cb: (d: { id: string; error: string }) => void): () => void {
    void CapacitorDownloader.addListener('downloadFailed', cb);
    return () => {
      void CapacitorDownloader.removeAllListeners();
    };
  }
}