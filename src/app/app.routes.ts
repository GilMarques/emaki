import { Routes } from '@angular/router';

/** App routes. Only the Tabs shell is a real route now; the Viewer is an
 *  overlay on top (see app.component.html). */
export const APP_ROUTES: Routes = [
  {
    path: '',
    redirectTo: 'tabs',
    pathMatch: 'full',
  },
  {
    path: 'tabs',
    loadChildren: () =>
      import('./features/tabs/tabs.routes').then((m) => m.TABS_ROUTES),
  },
];
