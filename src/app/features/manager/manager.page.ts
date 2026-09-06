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
  IonSpinner,
  IonText,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';

import { TaskManagerService } from '../../core/tasks/task-manager.service';

/**
 * Manager page — lists every background task (upscaling, downloads) with its
 * status. Reads from TaskManagerService, which both the enhancement engine
 * and the download service report into.
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
}