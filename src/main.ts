import { bootstrapApplication } from '@angular/platform-browser';
import { RouteReuseStrategy, provideRouter, withComponentInputBinding } from '@angular/router';
import { IonicRouteStrategy, provideIonicAngular } from '@ionic/angular/standalone';
import { Capacitor } from '@capacitor/core';

import { AppComponent } from './app/app.component';
import { APP_ROUTES } from './app/app.routes';
import { LIBRARY_SCANNER } from './app/core/native/library-scanner.port';
import { AssetsPresetScanner } from './app/core/native/assets-preset.scanner';
import { FileSystemLibraryScanner } from './app/core/native/filesystem-library.scanner';
import { FILE_SYSTEM_BROWSER } from './app/core/native/file-system-browser.port';
import { TauriFsBrowser } from './app/core/native/tauri-fs-browser';
import { SafFileSystemBrowser } from './app/core/native/saf-file-system-browser';
import { UnavailableFsBrowser } from './app/core/native/unavailable-fs-browser';
import {
  SCAN_ENHANCEMENT_BACKENDS,
  type ScanEnhancementBackend,
} from './app/core/native/scan-enhancement-backend';
import { TauriRealEsrganBackend } from './app/core/native/tauri-real-esrgan.backend';

const hasTauri = (): boolean =>
  typeof window !== 'undefined' &&
  (window as unknown as { __TAURI__?: unknown }).__TAURI__ !== undefined;

/**
 * A real filesystem backend exists on desktop (Tauri) and on Android (SAF via
 * the `@openviewer/saf-browser` plugin). Web/debug keeps the preset manifest.
 */
const hasRealFs = (): boolean => hasTauri() || Capacitor.isNativePlatform();

bootstrapApplication(AppComponent, {
  providers: [
    { provide: RouteReuseStrategy, useClass: IonicRouteStrategy },
    provideIonicAngular(),
    provideRouter(APP_ROUTES, withComponentInputBinding()),
    {
      provide: LIBRARY_SCANNER,
      useClass: hasRealFs() ? FileSystemLibraryScanner : AssetsPresetScanner,
    },
    {
      provide: FILE_SYSTEM_BROWSER,
      useClass: hasTauri()
        ? TauriFsBrowser
        : Capacitor.isNativePlatform()
          ? SafFileSystemBrowser
          : UnavailableFsBrowser,
    },
    {
      provide: SCAN_ENHANCEMENT_BACKENDS,
      useClass: TauriRealEsrganBackend as unknown as new () => ScanEnhancementBackend,
      multi: true,
    },
  ],
}).catch((err) => console.error(err));