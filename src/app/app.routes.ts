import { Routes } from '@angular/router';

/** Only the Bookshelf is a real route now; the Viewer is an overlay on top. */
export const APP_ROUTES: Routes = [
  {
    path: '',
    redirectTo: 'bookshelf',
    pathMatch: 'full',
  },
  {
    path: 'bookshelf',
    loadComponent: () =>
      import('./features/bookshelf/bookshelf.page').then((m) => m.BookshelfPage),
  },
];
