import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { IonIcon, IonNote, IonProgressBar } from '@ionic/angular/standalone';

import { ScanEnhancementService } from '../core/services/scan-enhancement.service';
import { ShelfService } from '../core/services/shelf.service';

/**
 * Google-Drive-style bottom-right tray listing every book currently being
 * enhanced, with a per-book progress bar. Auto-hides once a book is fully
 * enhanced (or stopped). Rendered once at the app root so it overlays both the
 * bookshelf and the reader.
 */
@Component({
  selector: 'ov-enhancement-progress',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonIcon, IonNote, IonProgressBar],
  templateUrl: './enhancement-progress.component.html',
  styleUrls: ['./enhancement-progress.component.scss'],
})
export class EnhancementProgressComponent {
  private readonly scan = inject(ScanEnhancementService);
  private readonly shelf = inject(ShelfService);

  public readonly paused = this.scan.paused;

  public readonly items = computed(() =>
    this.scan.activeJobs().map((j) => ({
      bookId: j.bookId,
      title: this.shelf.byId(j.bookId)?.title ?? j.bookId,
      done: j.done,
      total: j.total,
      processing: j.processing,
      ratio: j.total === 0 ? 0 : j.done / j.total,
    })),
  );

  public stop(bookId: string): void {
    void this.scan.stopBook(bookId);
  }
}
