import { bootstrapApplication } from '@angular/platform-browser';
import { RouteReuseStrategy, provideRouter, withComponentInputBinding } from '@angular/router';
import { IonicRouteStrategy, provideIonicAngular } from '@ionic/angular/standalone';
import { Capacitor } from '@capacitor/core';

import { AppComponent } from './app/app.component';
import { APP_ROUTES } from './app/app.routes';
import { installLogCapture } from './app/core/debug/log-store';
import { LIBRARY_SCANNER } from './app/core/native/library-scanner.port';
import { AssetsPresetScanner } from './app/core/native/assets-preset.scanner';
import { FileSystemLibraryScanner } from './app/core/native/filesystem-library.scanner';
import { FILE_SYSTEM_BROWSER } from './app/core/native/file-system-browser.port';
import { FileSystemAccessBrowser } from './app/core/native/fs-access-browser';
import { SafFileSystemBrowser } from './app/core/native/saf-file-system-browser';

/**
 * A real filesystem backend exists on Android (SAF via the
 * `@openviewer/saf-browser` plugin) and on the desktop (the File System Access
 * API in Chrome/Edge). Browsers without that API keep the preset manifest.
 */
const hasRealFs = (): boolean => Capacitor.isNativePlatform() || isFileSystemAccessSupported();

function isFileSystemAccessSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker ===
      'function'
  );
}

// Capture console output and uncaught errors before Angular starts, so a
// failure during bootstrap still lands in the debug log.
installLogCapture();

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
      useClass: Capacitor.isNativePlatform()
        ? SafFileSystemBrowser
        : FileSystemAccessBrowser,
    },
  ],
}).catch((err) => console.error(err));
