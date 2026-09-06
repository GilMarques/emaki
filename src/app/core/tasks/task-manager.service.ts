import { Injectable, computed, signal } from '@angular/core';

import type { NewTask, TaskKind, TaskProgress, TaskUpdate } from './task-manager.model';

/**
 * Registry of every in-flight background task (upscaling, downloads).
 *
 * The Manager page renders `tasks()`; owning services call `register` /
 * `update` / `remove` as work progresses. A task is kept until removed —
 * finished jobs stay visible so the user can see what completed, then are
 * dismissed by the owning service (or a future "clear" action).
 */
@Injectable({ providedIn: 'root' })
export class TaskManagerService {
  private readonly _tasks = signal<readonly TaskProgress[]>([]);

  /** All tasks, most-recently-registered first. */
  public readonly tasks = computed<readonly TaskProgress[]>(() => this._tasks());

  /** Tasks belonging to one kind, newest first. */
  public tasksOf(kind: TaskKind): readonly TaskProgress[] {
    return this._tasks().filter((t) => t.kind === kind);
  }

  public task(id: string, kind: TaskKind): TaskProgress | undefined {
    return this._tasks().find((t) => t.id === id && t.kind === kind);
  }

  /** Add a new task. Idempotent per (id, kind): re-adding resets it. */
  public register(task: NewTask): void {
    this._tasks.update((list) => [
      { id: task.id, kind: task.kind, title: task.title, done: 0, total: task.total, status: 'queued' },
      ...list.filter((t) => !(t.id === task.id && t.kind === task.kind)),
    ]);
  }

  /** Patch an existing task. No-op when the task doesn't exist. */
  public update(id: string, kind: TaskKind, patch: TaskUpdate): void {
    this._tasks.update((list) =>
      list.map((t) => (t.id === id && t.kind === kind ? { ...t, ...patch } : t)),
    );
  }

  /** Remove a task from the registry. */
  public remove(id: string, kind: TaskKind): void {
    this._tasks.update((list) => list.filter((t) => !(t.id === id && t.kind === kind)));
  }
}