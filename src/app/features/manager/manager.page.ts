import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonMenuButton,
  IonNote,
  IonSpinner,
  IonText,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';

import { TaskManagerService } from '../../core/tasks/task-manager.service';
import { DownloadService } from '../../core/services/download.service';
import { ScanEnhancementService } from '../../core/services/scan-enhancement.service';
import type { TaskProgress } from '../../core/tasks/task-manager.model';

/**
 * Manager page — lists every background task (upscaling, downloads) mixed
 * together with its status. Reads from TaskManagerService, which both the
 * enhancement engine and the download service report into.
 */
@Component({
  selector: 'ov-manager',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonItem,
    IonLabel,
    IonList,
    IonMenuButton,
    IonNote,
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
  private readonly downloads = inject(DownloadService);
  private readonly enhance = inject(ScanEnhancementService);

  public readonly all = this.tasks.tasks;

  public readonly hasTasks = computed(() => this.tasks.tasks().length > 0);

  /** Remove a finished task: delete a download's files, or clear an upscale entry. */
  public remove(task: TaskProgress): void {
    if (task.kind === 'download') {
      void this.downloads.removeByChapterId(task.id);
    } else {
      void this.enhance.stopBook(task.id);
      this.tasks.remove(task.id, 'upscale');
    }
  }
}