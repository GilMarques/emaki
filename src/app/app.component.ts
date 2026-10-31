import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { Router, RouterLink, RouterLinkActive } from '@angular/router';
import {
  IonApp,
  IonContent,
  IonFooter,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonMenu,
  IonMenuToggle,
  IonModal,
  IonPopover,
  IonRouterOutlet,
  IonSpinner,
  IonSplitPane,
  IonTitle,
  IonToolbar,
  MenuController,
} from '@ionic/angular/standalone';

import type { TaskProgress } from './core/tasks/task-manager.model';
import { TaskManagerService } from './core/tasks/task-manager.service';
import { LogService } from './core/services/log.service';
import { SettingsService } from './core/services/settings.service';
import { BookstoreService } from './core/services/bookstore.service';
import { MenuStateService } from './core/services/menu-state.service';
import { SyncService } from './core/sync/sync.service';
import type { PairedDevice } from './core/sync/pairing.model';
import { ViewerPage } from './features/viewer/viewer.page';
import { AddDeviceComponent } from './features/settings/add-device.component';
import { SendBookComponent } from './features/settings/send-book.component';
import { DevicesMenuComponent } from './shared/devices-menu.component';

@Component({
  selector: 'app-root',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
imports: [
    RouterLink,
    RouterLinkActive,
    IonApp,
    IonContent,
    IonFooter,
    IonHeader,
    IonIcon,
    IonItem,
    IonLabel,
    IonList,
    IonMenu,
    IonMenuToggle,
    IonModal,
    IonPopover,
    IonRouterOutlet,
    IonSpinner,
    IonSplitPane,
    IonTitle,
    IonToolbar,
    ViewerPage,
    AddDeviceComponent,
    SendBookComponent,
    DevicesMenuComponent,
  ],
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
})
export class AppComponent {
  private readonly settings = inject(SettingsService);
  private readonly bookstore = inject(BookstoreService);
  private readonly tasks = inject(TaskManagerService);
  private readonly sync = inject(SyncService);
  private readonly router = inject(Router);
  private readonly menuController = inject(MenuController);

  /** Docked sidebar state (shared with every page's menu button). */
  public readonly menu = inject(MenuStateService);

  /** Devices this computer may hand books to (shown in the sidebar popover). */
  public readonly devices = this.sync.devices;

  /** Popover state for the sidebar's devices button (docked layout only). */
  public readonly devicesOpen = signal(false);
  public readonly devicesEvent = signal<Event | undefined>(undefined);

  /** Device modals, shared by the sidebar popover and the Settings page. */
  public readonly addDeviceOpen = signal(false);
  public readonly sendTarget = signal<PairedDevice | null>(null);

  /** Accessible label for the sidebar devices button. */
  public readonly devicesLabel = computed(() => {
    const count = this.devices().length;
    return count === 0 ? 'Devices' : `Devices (${count})`;
  });

  /** Background jobs in the side menu — downloads and enhancements mixed,
   *  newest first, at most five. */
  public readonly backgroundTasks = computed(() => this.tasks.tasks().slice(0, 5));

  /** Menu icon for a task: sparkles for upscaling, the download glyph otherwise. */
  public taskIcon(task: TaskProgress): string {
    return task.kind === 'upscale' ? 'sparkles' : 'download-outline';
  }

  /** Compact status line under a task's title. */
  public taskDetail(task: TaskProgress): string {
    const count = `${task.total} page${task.total === 1 ? '' : 's'}`;
    const verb = task.kind === 'upscale' ? 'enhanced' : 'downloaded';
    switch (task.status) {
      case 'queued':
        return 'Queued';
      case 'processing':
        return `${task.done} / ${count} ${verb}`;
      case 'done':
        return `${count} ${verb}`;
      case 'error':
        return task.error ?? (task.kind === 'upscale' ? 'Enhancement failed' : 'Download failed');
      case 'cancelled':
        return 'Cancelled';
    }
  }

  /** Drives the reader overlay — true whenever a book is open. */
  public readonly isReaderOpen = computed(() => this.bookstore.state().book !== null);

  /**
   * The sidebar's devices button.
   *
   * Docked layout: opens the devices popover above the button — the desktop
   * has room for a menu, and the Settings page hides its Devices section.
   * Drawer layout (phone): closes the drawer and goes to Settings, where the
   * Devices section is the "add device" screen.
   */
  public openDevices(event: Event): void {
    if (this.menu.docked()) {
      this.devicesEvent.set(event);
      this.devicesOpen.set(true);
      return;
    }
    void this.menuController.close('start');
    void this.router.navigateByUrl('/settings');
  }

  /** Close the drawer when a footer link navigates (no-op while docked). */
  public closeDrawer(): void {
    if (!this.menu.docked()) void this.menuController.close('start');
  }

  /** Pair a device from the sidebar popover. */
  public openAddDevice(): void {
    this.devicesOpen.set(false);
    this.addDeviceOpen.set(true);
  }

  /** Forget a device from the sidebar popover. */
  public forget(device: PairedDevice): void {
    this.sync.forget(device.id);
    this.devicesOpen.set(false);
  }

  /** Hand a book to a device picked in the sidebar popover. */
  public sendTo(device: PairedDevice): void {
    this.devicesOpen.set(false);
    this.sendTarget.set(device);
  }

  /**
   * The sheet has finished animating out. Only now stop the renderer and
   * clear the open book — doing it while the sheet is still sliding away made
   * the viewer swap to "No book open" mid-animation.
   */
  public onReaderDismissed(): void {
    this.bookstore.closeBook();
  }

  /**
   * Film-grain overlay opacity. Grain is a texture layer, not a CSS filter —
   * mapping it onto `brightness()` would only darken the app. 0 = off; at 100
   * the noise sheet runs at 90% so the specks stay clearly visible.
   */
  public readonly grainOpacity = computed(() => {
    const grain = this.settings.settings().filters.grain;
    if (!grain.enabled) return 0;
    return (Math.min(100, Math.max(0, grain.value)) / 100) * 0.9;
  });

  constructor() {
    // Start the debug log (session marker + file sink) at launch rather than
    // when the log viewer is first opened.
    inject(LogService);

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

