import { ChangeDetectionStrategy, Component, computed, effect, inject } from '@angular/core';
import { IonApp, IonRouterOutlet, IonModal } from '@ionic/angular/standalone';

import { SettingsService } from './core/services/settings.service';
import { BookstoreService } from './core/services/bookstore.service';
import { ViewerPage } from './features/viewer/viewer.page';

@Component({
  selector: 'app-root',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonApp, IonRouterOutlet, IonModal, ViewerPage],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
})
export class AppComponent {
  private readonly settings = inject(SettingsService);
  private readonly bookstore = inject(BookstoreService);

  /** Drives the reader overlay — true whenever a book is open. */
  public readonly isReaderOpen = computed(() => this.bookstore.state().book !== null);

  /** Dismiss the reader sheet (handle drag or content swipe-down). */
  public closeReader(): void {
    this.bookstore.closeBook();
  }

  constructor() {
    // Apply theme at the document level so every page inherits it.
    effect(() => {
      applyTheme(this.settings.settings().display.interfaceTheme);
    });
  }
}

/**
 * Apply a theme via two classes on <html>:
 *  - ov-theme-light / ov-theme-dark → our own hook for app-wide overrides
 *  - ion-palette-dark               → Ionic's dark-mode palette trigger
 *
 * 'auto' falls through to Ionic's prefers-color-scheme media query.
 */
function applyTheme(theme: 'auto' | 'light' | 'dark'): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.remove('ov-theme-light', 'ov-theme-dark', 'ion-palette-dark');
  if (theme === 'light') root.classList.add('ov-theme-light');
  else if (theme === 'dark') {
    root.classList.add('ov-theme-dark', 'ion-palette-dark');
  }
}
