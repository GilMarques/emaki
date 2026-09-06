import { Routes } from '@angular/router';

/** App routes. Pages are top-level; navigation is driven by the side menu
 *  (see app.component.html). The Viewer is an overlay on top. */
export const APP_ROUTES: Routes = [
  {
    path: '',
    redirectTo: 'library',
    pathMatch: 'full',
  },
  {
    path: 'library',
    loadComponent: () =>
      import('./features/bookshelf/bookshelf.page').then((m) => m.BookshelfPage),
  },
  {
    path: 'provider',
    loadComponent: () =>
      import('./features/provider/provider.page').then((m) => m.ProviderPage),
  },
  {
    path: 'provider/:providerId',
    loadComponent: () =>
      import('./features/provider/browse/browse.page').then((m) => m.ProviderBrowsePage),
  },
  {
    path: 'provider/:providerId/manga/:mangaId',
    loadComponent: () =>
      import('./features/provider/chapters/chapters.page').then((m) => m.ProviderChaptersPage),
  },
  {
    path: 'settings',
    loadComponent: () =>
      import('./features/settings/settings.page').then((m) => m.SettingsPage),
  },
];
