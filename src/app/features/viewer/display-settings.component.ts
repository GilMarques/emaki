import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import {
  IonIcon,
  IonItem,
  IonList,
  IonSelect,
  IonSelectOption,
} from '@ionic/angular/standalone';

import type {
  InterfaceTheme,
  PageLayout,
  PageTransition,
  ReadingDirection,
  ScreenOrientation,
  ViewerMode,
  ZoomMode,
} from '../../core/models/settings.model';
import { SettingsService } from '../../core/services/settings.service';

interface Option<T extends string> {
  readonly value: T;
  readonly label: string;
}

const PAGE_LAYOUT_OPTIONS: readonly Option<PageLayout>[] = [
  { value: 'default', label: 'Default' },
  { value: 'auto-single', label: 'Auto single page' },
  { value: 'auto-dual', label: 'Auto dual page' },
  { value: 'auto-switch', label: 'Auto switch' },
];

const THEME_OPTIONS: readonly Option<InterfaceTheme>[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

const VIEWER_MODE_OPTIONS: readonly Option<ViewerMode>[] = [
  { value: 'paged', label: 'Page mode' },
  { value: 'vertical-scroll', label: 'Vertical scroll' },
  { value: 'horizontal-scroll', label: 'Horizontal scroll' },
];

/**
 * Page-curl sits first in the popover so users see what's coming; "None"
 * sits last because it's the boring default once the real effects exist.
 */
const PAGE_TRANSITION_OPTIONS: readonly Option<PageTransition>[] = [
  { value: 'page-curl', label: 'Page curl' },
  { value: 'slide-horizontal', label: 'Slide left/right' },
  { value: 'slide-vertical', label: 'Slide up/down' },
  { value: 'none', label: 'None' },
];

const ORIENTATION_OPTIONS: readonly Option<ScreenOrientation>[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'portrait', label: 'Portrait' },
  { value: 'landscape', label: 'Landscape' },
  { value: 'portrait-inverted', label: 'Portrait (inverted)' },
  { value: 'landscape-inverted', label: 'Landscape (inverted)' },
  { value: 'default', label: 'Default' },
];

const ZOOM_OPTIONS: readonly Option<ZoomMode>[] = [
  { value: 'actual-size', label: 'Actual size' },
  { value: 'fit-screen', label: 'Fit to screen' },
  { value: 'fit-width', label: 'Fit to width' },
  { value: 'fit-height', label: 'Fit to height' },
  { value: 'fixed-size', label: 'Fixed size' },
  { value: 'stretch-to-fill', label: 'Stretch to fill screen' },
  { value: 'cover', label: 'Cover' },
];

const READING_DIRECTION_OPTIONS: readonly Option<ReadingDirection>[] = [
  { value: 'ltr', label: 'Left to right' },
  { value: 'rtl', label: 'Right to left' },
];

/**
 * Display settings tab. All options read/write through SettingsService.
 *
 * Page origin is intentionally absent — its purpose is undecided (see the
 * Linear issue GIL-30 scope locks). Don't add it back until the design
 * intent is settled.
 */
@Component({
  selector: 'ov-display-settings',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonIcon, IonItem, IonList, IonSelect, IonSelectOption],
  template: `
    <ion-list lines="none" class="settings-list">
      <ion-item>
        <ion-icon
          aria-hidden="true"
          slot="start"
          ios="swap-horizontal-outline"
          md="swap-horizontal-sharp"
        ></ion-icon>
        <ion-select
          label="Reading direction"
          class="display-select"
          [value]="readingDirection()"
          (ionChange)="onReadingDirectionChange($event)"
          interface="popover"
          aria-label="Reading direction"
        >
          @for (opt of readingDirections; track opt.value) {
            <ion-select-option [value]="opt.value">{{ opt.label }}</ion-select-option>
          }
        </ion-select>
      </ion-item>

      <ion-item>
        <ion-icon
          aria-hidden="true"
          slot="start"
          ios="phone-portrait-outline"
          md="phone-portrait-sharp"
        ></ion-icon>
        <ion-select
          label="Screen orientation"
          class="display-select"
          [value]="orientation()"
          (ionChange)="onOrientationChange($event)"
          interface="popover"
          aria-label="Screen orientation"
        >
          @for (opt of orientations; track opt.value) {
            <ion-select-option [value]="opt.value">{{ opt.label }}</ion-select-option>
          }
        </ion-select>
      </ion-item>

      <ion-item>
        <ion-icon
          aria-hidden="true"
          slot="start"
          ios="book-outline"
          md="book-sharp"
        ></ion-icon>
        <ion-select
          label="Page layout"
          class="display-select"
          [value]="pageLayout()"
          (ionChange)="onPageLayoutChange($event)"
          interface="popover"
          aria-label="Page layout"
        >
          @for (opt of pageLayouts; track opt.value) {
            <ion-select-option [value]="opt.value">{{ opt.label }}</ion-select-option>
          }
        </ion-select>
      </ion-item>

      <ion-item>
        <ion-icon
          aria-hidden="true"
          slot="start"
          ios="scan-outline"
          md="scan-sharp"
        ></ion-icon>
        <ion-select
          label="Zoom"
          class="display-select"
          [value]="zoom()"
          (ionChange)="onZoomChange($event)"
          interface="popover"
          aria-label="Zoom"
        >
          @for (opt of zooms; track opt.value) {
            <ion-select-option [value]="opt.value">{{ opt.label }}</ion-select-option>
          }
        </ion-select>
      </ion-item>

      <ion-item>
        <ion-icon
          aria-hidden="true"
          slot="start"
          ios="contrast-outline"
          md="contrast-sharp"
        ></ion-icon>
        <ion-select
          label="Interface theme"
          class="display-select"
          [value]="theme()"
          (ionChange)="onThemeChange($event)"
          interface="popover"
          aria-label="Interface theme"
        >
          @for (opt of themes; track opt.value) {
            <ion-select-option [value]="opt.value">{{ opt.label }}</ion-select-option>
          }
        </ion-select>
      </ion-item>

      <ion-item>
        <ion-icon
          aria-hidden="true"
          slot="start"
          ios="albums-outline"
          md="albums-sharp"
        ></ion-icon>
        <ion-select
          label="Viewer mode"
          class="display-select"
          [value]="viewerMode()"
          (ionChange)="onViewerModeChange($event)"
          interface="popover"
          aria-label="Viewer mode"
        >
          @for (opt of viewerModes; track opt.value) {
            <ion-select-option [value]="opt.value">{{ opt.label }}</ion-select-option>
          }
        </ion-select>
      </ion-item>

      <ion-item>
        <ion-icon
          aria-hidden="true"
          slot="start"
          ios="refresh-outline"
          md="refresh-sharp"
        ></ion-icon>
        <ion-select
          label="Page transition effect"
          class="display-select"
          [value]="pageTransition()"
          (ionChange)="onPageTransitionChange($event)"
          interface="popover"
          aria-label="Page transition"
        >
          @for (opt of pageTransitions; track opt.value) {
            <ion-select-option [value]="opt.value">{{ opt.label }}</ion-select-option>
          }
        </ion-select>
      </ion-item>
    </ion-list>
  `,
  styles: [
    `
      .settings-list {
        padding-top: 8px;
      }
      ion-item ion-icon[slot='start'] {
        color: var(--ion-color-medium);
        font-size: 22px;
      }
      .display-select {
        min-width: 160px;
      }
      ion-select::part(label) {
        font-size: 0.875rem;
      }
    `,
  ],
})
export class DisplaySettingsComponent {
  private readonly settings = inject(SettingsService);

  public readonly pageLayouts = PAGE_LAYOUT_OPTIONS;
  public readonly themes = THEME_OPTIONS;
  public readonly viewerModes = VIEWER_MODE_OPTIONS;
  public readonly pageTransitions = PAGE_TRANSITION_OPTIONS;
  public readonly orientations = ORIENTATION_OPTIONS;
  public readonly readingDirections = READING_DIRECTION_OPTIONS;
  public readonly zooms = ZOOM_OPTIONS;

  // Bindings — read from the settings signal each cycle.
  public readonly orientation = computed(() => this.settings.settings().display.screenOrientation);
  public readonly pageLayout = computed(() => this.settings.settings().display.pageLayout);
  public readonly theme = computed(() => this.settings.settings().display.interfaceTheme);
  public readonly viewerMode = computed(() => this.settings.settings().display.viewerMode);
  public readonly pageTransition = computed(() => this.settings.settings().display.pageTransition);
  public readonly zoom = computed(() => this.settings.settings().display.zoom);
  public readonly readingDirection = computed(() => this.settings.settings().display.readingDirection);

  public onReadingDirectionChange(event: CustomEvent<{ value: ReadingDirection | undefined }>): void {
    const v = event.detail.value;
    if (v === 'ltr' || v === 'rtl') this.settings.setReadingDirection(v);
  }

  public onOrientationChange(event: CustomEvent<{ value: ScreenOrientation | undefined }>): void {
    if (event.detail.value !== undefined) this.settings.setScreenOrientation(event.detail.value);
  }

  public onPageLayoutChange(event: CustomEvent<{ value: PageLayout | undefined }>): void {
    if (event.detail.value !== undefined) this.settings.setPageLayout(event.detail.value);
  }

  public onZoomChange(event: CustomEvent<{ value: ZoomMode | undefined }>): void {
    const v = event.detail.value;
    if (
      v === 'actual-size' ||
      v === 'fit-screen' ||
      v === 'fit-width' ||
      v === 'fit-height' ||
      v === 'fixed-size' ||
      v === 'stretch-to-fill' ||
      v === 'cover'
    ) {
      this.settings.setZoom(v);
    }
  }

  public onThemeChange(event: CustomEvent<{ value: InterfaceTheme | undefined }>): void {
    const v = event.detail.value;
    if (v === 'auto' || v === 'light' || v === 'dark') this.settings.setInterfaceTheme(v);
  }

  public onViewerModeChange(event: CustomEvent<{ value: ViewerMode | undefined }>): void {
    const v = event.detail.value;
    if (v === 'paged' || v === 'vertical-scroll' || v === 'horizontal-scroll') {
      this.settings.setViewerMode(v);
    }
  }

  public onPageTransitionChange(event: CustomEvent<{ value: PageTransition | undefined }>): void {
    if (event.detail.value !== undefined) this.settings.setPageTransition(event.detail.value);
  }
}
