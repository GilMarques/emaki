/**
 * Shared task-progress contract.
 *
 * Both long-running work streams — the scan-enhancement (upscaling) engine
 * and the provider page downloader — report into `TaskManagerService` so a
 * single Manager page can show progress for every background job. Keep the
 * shape small and serializable; per-page detail lives in the owning service.
 */

/** Which engine a task belongs to. */
export type TaskKind = 'upscale' | 'download';

/** Lifecycle of a task. */
export type TaskStatus = 'queued' | 'processing' | 'done' | 'error' | 'cancelled';

/** A progress-bearing background job. */
export interface TaskProgress {
  /** Stable id within its kind, e.g. the chapter id. */
  readonly id: string;
  readonly kind: TaskKind;
  /** Human title shown in the Manager list. */
  readonly title: string;
  readonly done: number;
  readonly total: number;
  readonly status: TaskStatus;
  /** Last error message, when status is 'error'. */
  readonly error?: string;
}

/** Input when registering a task. */
export interface NewTask {
  readonly id: string;
  readonly kind: TaskKind;
  readonly title: string;
  readonly total: number;
}

/** Patch applied to a task via `update`. */
export interface TaskUpdate {
  readonly done?: number;
  readonly total?: number;
  readonly status?: TaskStatus;
  readonly error?: string;
}