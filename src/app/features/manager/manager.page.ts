import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import {
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonMenuButton,
  IonNote,
  IonProgressBar,
  IonSpinner,
  IonText,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';

import { TaskManagerService } from '../../core/tasks/task-manager.service';
import type { TaskProgress } from '../../core/tasks/task-manager.model';

const KIND_LABEL: Record<TaskProgress['kind'], string> = {
  upscale: 'Upscale',
  download: 'Download',
};

/**
 * Manager page — lists every background task (upscaling, downloads) with a
 * per-task progress bar. Reads from TaskManagerService, which both the
 * enhancement engine and the download service report into.
 */
@Component({
  selector: 'ov-manager',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonItem,
    IonLabel,
    IonList,
    IonMenuButton,
    IonNote,
    IonProgressBar,
    IonSpinner,
    IonText,
    IonTitle,
    IonToolbar,
  ],
  templateUrl: './manager.page.html',
  styleUrls: ['./manager.page.scss'],
})
export class ManagerPage {
  private readonly tasks = inject(TaskManagerService);

  public readonly all = this.tasks.tasks;

  public readonly hasTasks = computed(() => this.tasks.tasks().length > 0);

  public readonly tasksWithRatio = computed(() =>
    this.tasks.tasks().map((t) => ({
      ...t,
      ratio: t.total === 0 ? 0 : t.done / t.total,
    })),
  );

  public kindLabel(kind: TaskProgress['kind']): string {
    return KIND_LABEL[kind];
  }
}