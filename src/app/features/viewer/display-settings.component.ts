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
  PageLayout,
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
  { value: 'auto', label: 'Auto' },
  { value: 'single', label: 'Single page' },
  { value: 'dual', label: 'Dual page' },
];

const VIEWER_MODE_OPTIONS: readonly Option<ViewerMode>[] = [
  { value: 'paged', label: 'Page mode' },
  { value: 'vertical-scroll', label: 'Vertical scroll' },
  { value: 'horizontal-scroll', label: 'Horizontal scroll' },
];

const ORIENTATION_OPTIONS: readonly Option<ScreenOrientation>[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'portrait', label: 'Portrait' },
  { value: 'landscape', label: 'Landscape' },
  { value: 'portrait-inverted', label: 'Portrait (inverted)' },
  { value: 'landscape-inverted', label: 'Landscape (inverted)' },
];

const ZOOM_OPTIONS: readonly Option<ZoomMode>[] = [
  { value: 'fit-screen', label: 'Fit to screen' },
  { value: 'fit-width', label: 'Fit to width' },
  { value: 'fit-height', label: 'Fit to height' },
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
          label="Default zoom"
          class="display-select"
          [value]="zoom()"
          (ionChange)="onZoomChange($event)"
          interface="popover"
          aria-label="Default zoom"
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
  public readonly viewerModes = VIEWER_MODE_OPTIONS;
  public readonly orientations = ORIENTATION_OPTIONS;
  public readonly readingDirections = READING_DIRECTION_OPTIONS;
  public readonly zooms = ZOOM_OPTIONS;

  // Bindings — read from the settings signal each cycle.
  public readonly orientation = computed(() => this.settings.settings().display.screenOrientation);
  public readonly pageLayout = computed(() => this.settings.settings().display.pageLayout);
  public readonly viewerMode = computed(() => this.settings.settings().display.viewerMode);
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
    if (v === 'fit-screen' || v === 'fit-width' || v === 'fit-height') {
      this.settings.setZoom(v);
    }
  }

  public onViewerModeChange(event: CustomEvent<{ value: ViewerMode | undefined }>): void {
    const v = event.detail.value;
    if (v === 'paged' || v === 'vertical-scroll' || v === 'horizontal-scroll') {
      this.settings.setViewerMode(v);
    }
  }
}
