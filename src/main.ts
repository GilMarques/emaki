import { bootstrapApplication } from '@angular/platform-browser';
import { RouteReuseStrategy, provideRouter, withComponentInputBinding } from '@angular/router';
import { IonicRouteStrategy, provideIonicAngular } from '@ionic/angular/standalone';
import { Capacitor } from '@capacitor/core';

import { AppComponent } from './app/app.component';
import { APP_ROUTES } from './app/app.routes';
import { LIBRARY_SCANNER } from './app/core/native/library-scanner.port';
import { AssetsPresetScanner } from './app/core/native/assets-preset.scanner';
import { NATIVE_DOWNLOADER } from './app/core/native/native-downloader.port';
import { CapacitorNativeDownloader } from './app/core/native/capacitor-native-downloader';
import { WebNativeDownloader } from './app/core/native/web-native-downloader';

bootstrapApplication(AppComponent, {
  providers: [
    { provide: RouteReuseStrategy, useClass: IonicRouteStrategy },
    provideIonicAngular(),
    provideRouter(APP_ROUTES, withComponentInputBinding()),
    { provide: LIBRARY_SCANNER, useClass: AssetsPresetScanner },
    {
      provide: NATIVE_DOWNLOADER,
      useClass: Capacitor.isNativePlatform() ? CapacitorNativeDownloader : WebNativeDownloader,
    },
  ],
}).catch((err) => console.error(err));