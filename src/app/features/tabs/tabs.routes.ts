import { Routes } from '@angular/router';

import { TabsPage } from './tabs.page';

export const TABS_ROUTES: Routes = [
  {
    path: '',
    component: TabsPage,
    children: [
      {
        path: '',
        redirectTo: '/tabs/library',
        pathMatch: 'full',
      },
      {
        path: 'library',
        loadComponent: () =>
          import('../bookshelf/bookshelf.page').then((m) => m.BookshelfPage),
      },
      {
        path: 'provider',
        loadComponent: () =>
          import('../provider/provider.page').then((m) => m.ProviderPage),
      },
      {
        path: 'settings',
        loadComponent: () =>
          import('../settings/settings.page').then((m) => m.SettingsPage),
      },
    ],
  },
];
