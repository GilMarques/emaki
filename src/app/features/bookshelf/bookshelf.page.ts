import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import {
  IonButtons,
  IonButton,
  IonCard,
  IonCardHeader,
  IonCardTitle,
  IonCol,
  IonContent,
  IonGrid,
  IonHeader,
  IonIcon,
  IonModal,
  IonRow,
  IonSpinner,
  IonText,
  IonTitle,
  IonToolbar,
} from '@ionic/angular/standalone';

import { DisplaySettingsComponent } from '../viewer/display-settings.component';
import { FiltersSettingsComponent } from '../viewer/filters-settings.component';
import { BookstoreService } from '../../core/services/bookstore.service';
import { ScannerService } from '../../core/services/scanner.service';
import { ShelfService } from '../../core/services/shelf.service';

@Component({
  selector: 'ov-bookshelf',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonButtons,
    IonButton,
    IonCard,
    IonCardHeader,
    IonCardTitle,
    IonCol,
    IonContent,
    IonGrid,
    IonHeader,
    IonIcon,
    IonModal,
    IonRow,
    IonSpinner,
    IonText,
    IonTitle,
    IonToolbar,
    DisplaySettingsComponent,
    FiltersSettingsComponent,
  ],
  templateUrl: './bookshelf.page.html',
  styleUrls: ['./bookshelf.page.scss'],
})
export class BookshelfPage {
  private readonly shelf = inject(ShelfService);
  private readonly scanner = inject(ScannerService);
  private readonly bookstore = inject(BookstoreService);

  public readonly books = this.shelf.books;
  public readonly scanning = this.scanner.scanning;
  public readonly booksFound = this.scanner.booksFound;

  /** Filters sheet (moved here from the reader's quick-actions). */
  public readonly filtersOpen = signal(false);
  /** Display sheet (reading direction, layout, zoom, theme, …). */
  public readonly displayOpen = signal(false);

  public async scan(): Promise<void> {
    await this.scanner.scan();
  }

  public openBook(id: string): void {
    this.bookstore.openById(id);
  }
}
