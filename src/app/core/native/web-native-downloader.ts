import { Injectable, inject } from '@angular/core';

import { ConnectorRequestService } from '../connectors/connector-request.service';
import type {
  NativeDownload,
  NativeDownloaderPort,
  NativeDownloadStartOptions,
} from './native-downloader.port';

interface WebTask extends NativeDownload {
  readonly url: string;
  readonly destination: string;
  blobUrl?: string;
  error?: string;
  progress: number;
  state: 'PENDING' | 'RUNNING' | 'PAUSED' | 'DONE' | 'ERROR';
}

/**
 * Browser fallback for the downloader port. Downloads are session-only blob
 * URLs (no disk persistence), so nothing survives a reload — used purely so
 * `ionic serve` can exercise the queue flow.
 */
@Injectable()
export class WebNativeDownloader implements NativeDownloaderPort {
  private readonly requests = inject(ConnectorRequestService);

  private readonly tasks = new Map<string, WebTask>();
  private progressCb: ((d: { id: string; progress: number }) => void) | null = null;
  private completedCb: ((d: { id: string }) => void) | null = null;
  private failedCb: ((d: { id: string; error: string }) => void) | null = null;

  public async start(options: NativeDownloadStartOptions): Promise<NativeDownload> {
    const task: WebTask = {
      id: options.id,
      url: options.url,
      destination: options.destination,
      progress: 0,
      state: 'RUNNING',
    };
    this.tasks.set(options.id, task);
    void this.run(task);
    return task;
  }

  public async pause(id: string): Promise<void> {
    const t = this.tasks.get(id);
    if (t && t.state === 'RUNNING') t.state = 'PAUSED';
  }

  public async resume(id: string): Promise<void> {
    const t = this.tasks.get(id);
    if (t && t.state === 'PAUSED') {
      t.state = 'RUNNING';
      void this.run(t);
    }
  }

  public async stop(id: string): Promise<void> {
    const t = this.tasks.get(id);
    if (t) {
      t.state = 'ERROR';
      if (t.blobUrl) URL.revokeObjectURL(t.blobUrl);
      this.tasks.delete(id);
    }
  }

  public async checkStatus(id: string): Promise<NativeDownload> {
    const t = this.tasks.get(id);
    return t ?? { id, progress: 0, state: 'PENDING' };
  }

  public async getFileInfo(path: string): Promise<{ size: number; type: string }> {
    return { size: 0, type: 'image/jpeg' };
  }

  public onProgress(cb: (d: { id: string; progress: number }) => void): () => void {
    this.progressCb = cb;
    return () => {
      this.progressCb = null;
    };
  }

  public onCompleted(cb: (d: { id: string }) => void): () => void {
    this.completedCb = cb;
    return () => {
      this.completedCb = null;
    };
  }

  public onFailed(cb: (d: { id: string; error: string }) => void): () => void {
    this.failedCb = cb;
    return () => {
      this.failedCb = null;
    };
  }

  /** Browser download has no real byte progress; fake it 0→100 and complete. */
  private async run(task: WebTask): Promise<void> {
    try {
      const blob = await this.requests.fetchImage(task.url);
      if (task.state === 'PAUSED' || task.state === 'ERROR') return;
      task.blobUrl = URL.createObjectURL(blob);
      task.progress = 100;
      task.state = 'DONE';
      this.progressCb?.({ id: task.id, progress: 100 });
      this.completedCb?.({ id: task.id });
    } catch (err) {
      if (task.state === 'ERROR') return;
      task.state = 'ERROR';
      task.error = err instanceof Error ? err.message : String(err);
      this.failedCb?.({ id: task.id, error: task.error });
    }
  }
}