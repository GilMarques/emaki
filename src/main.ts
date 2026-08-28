import { bootstrapApplication } from '@angular/platform-browser';
import { RouteReuseStrategy, provideRouter, withComponentInputBinding } from '@angular/router';
import { IonicRouteStrategy, provideIonicAngular } from '@ionic/angular/standalone';

import { AppComponent } from './app/app.component';
import { APP_ROUTES } from './app/app.routes';
import { LIBRARY_SCANNER } from './app/core/native/library-scanner.port';
import { AssetsPresetScanner } from './app/core/native/assets-preset.scanner';

bootstrapApplication(AppComponent, {
  providers: [
    { provide: RouteReuseStrategy, useClass: IonicRouteStrategy },
    provideIonicAngular(),
    provideRouter(APP_ROUTES, withComponentInputBinding()),
    { provide: LIBRARY_SCANNER, useClass: AssetsPresetScanner },
  ],
}).catch((err) => console.error(err));