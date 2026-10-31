import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import {
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonSpinner,
} from '@ionic/angular/standalone';

import { ShelfService } from '../../core/services/shelf.service';
import { SyncService } from '../../core/sync/sync.service';
import type { PairedDevice } from '../../core/sync/pairing.model';

/**
 * "Send a book" — hand the enhanced pages of one book to a paired device.
 *
 * The desktop keeps the enhanced pages next to the source (`.enhanced/`), so
 * what is sent is exactly what the reader shows.
 */
@Component({
  selector: 'ov-send-book',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonItem, IonLabel, IonList, IonListHeader, IonNote, IonSpinner],
  template: `
    <div class="modal-body">
    <ion-list-header>Send to {{ device()?.name }}</ion-list-header>
    @if (busy()) {
      <div class="center"><ion-spinner name="crescent"></ion-spinner></div>
    }
    <ion-list lines="inset">
      @for (book of books(); track book.id) {
        <ion-item button [detail]="false" (click)="send(book.id, book.title, book.uri)">
          <ion-label>
            <h2>{{ book.title }}</h2>
            @if (book.uri) {
              <p>{{ book.uri }}</p>
            } @else {
              <p>Only folders of pages can be sent.</p>
            }
          </ion-label>
        </ion-item>
      } @empty {
        <ion-item>
          <ion-label>
            <h2>No books yet</h2>
            <p>Open a folder in the Files tab first.</p>
          </ion-label>
        </ion-item>
      }
    </ion-list>
    @if (error()) {
      <ion-note class="error">{{ error() }}</ion-note>
    }
    </div>
  `,
  styles: [
    `
      .modal-body {
        display: block;
        padding: calc(env(safe-area-inset-top, 0px) + 12px) 0 20px;
        max-height: 100%;
        overflow-y: auto;
      }
      .center {
        display: flex;
        justify-content: center;
        padding: 16px;
      }
      .error {
        display: block;
        padding: 0 16px 16px;
        color: var(--ion-color-danger);
      }
    `,
  ],
})
export class SendBookComponent {
  private readonly shelf = inject(ShelfService);
  private readonly sync = inject(SyncService);

  readonly device = input<PairedDevice | null>(null);
  readonly dismissed = output<void>();
  readonly sent = output<void>();

  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  /** Books that live in a folder on disk (the ones we can hand over). */
  public books(): { id: string; title: string; uri: string | null }[] {
    return this.shelf
      .books()
      .map((book) => ({
        id: book.id,
        title: book.title,
        uri: book.source.type === 'folder' ? book.source.uri : null,
      }));
  }

  public async send(bookId: string, title: string, uri: string | null): Promise<void> {
    const device = this.device();
    if (!device) return;
    if (!uri) {
      this.error.set('Only folders of pages can be sent.');
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.sync.pushBook(
        device.id,
        { id: bookId, title, pageCount: 0 },
        uri,
      );
      this.sent.emit();
      this.dismissed.emit();
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }
}
