import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import {
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonRange,
  IonSelect,
  IonSelectOption,
  IonToggle,
  type RangeChangeEventDetail,
} from '@ionic/angular/standalone';

import type {
  FilterSettings,
  ImageSmoothMethod,
} from '../../core/models/settings.model';
import { FILTER_BOUNDS } from '../../core/models/settings.model';
import { SettingsService } from '../../core/services/settings.service';

interface SliderRow {
  readonly key: Exclude<keyof FilterSettings, 'imageSmooth' | 'grayscale'>;
  readonly label: string;
  readonly suffix: string;
  readonly icon: string;
}

interface SmoothOption {
  readonly value: ImageSmoothMethod;
  readonly label: string;
}

/** One row per slider filter. Keep the order = the order the user sees them. */
const SLIDER_ROWS: readonly SliderRow[] = [
  { key: 'brightness', label: 'Brightness', suffix: '%', icon: 'sunny' },
  { key: 'blueLight', label: 'Blue light filter', suffix: '%', icon: 'eye' },
  { key: 'contrast', label: 'Contrast', suffix: '%', icon: 'contrast' },
  { key: 'sepia', label: 'Sepia', suffix: '%', icon: 'leaf' },
  { key: 'grain', label: 'Grain', suffix: '%', icon: 'sparkles' },
];

const SMOOTH_OPTIONS: readonly SmoothOption[] = [
  { value: 'none', label: 'None' },
  { value: 'nearest-neighbor', label: 'Nearest neighbor' },
  { value: 'averaging', label: 'Averaging' },
  { value: 'bilinear', label: 'Bilinear' },
  { value: 'bicubic', label: 'Bicubic' },
  { value: 'lanczos3', label: 'Lanczos3' },
];

/**
 * Filters tab. Each row is either a (toggle, slider) pair or the image-smooth
 * toggle + sampling-method dropdown.
 *
 * Disabled sliders drop to a lower opacity but stay visible so the user knows
 * the option exists. The toggle's state drives whether the filter is applied
 * to the canvas at all — value is preserved either way.
 */
@Component({
  selector: 'ov-filters-settings',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonIcon,
    IonItem,
    IonLabel,
    IonList,
    IonNote,
    IonRange,
    IonSelect,
    IonSelectOption,
    IonToggle,
  ],
  template: `
    <ion-list lines="none" class="filters-list">
      @for (row of sliderRows; track row.key) {
        <ion-item>
          <ion-icon
            aria-hidden="true"
            slot="start"
            [ios]="row.icon + '-outline'"
            [md]="row.icon + '-sharp'"
          ></ion-icon>
          <ion-toggle
            slot="end"
            [checked]="getEnabled(row.key)"
            (ionChange)="onToggleChange(row.key, $event)"
            [attr.aria-label]="'Enable ' + row.label"
          ></ion-toggle>
          <ion-label>
            <h3>{{ row.label }}</h3>
          </ion-label>
        </ion-item>
        <ion-item class="slider-row" [class.is-disabled]="!getEnabled(row.key)">
          <ion-range
            pin="true"
            [min]="bounds[row.key].min"
            [max]="bounds[row.key].max"
            [step]="bounds[row.key].step"
            [value]="getValue(row.key)"
            (ionInput)="onSliderChange(row.key, $event)"
            [disabled]="!getEnabled(row.key)"
            [attr.aria-label]="row.label + ' slider'"
          >
            <ion-note slot="start">{{ bounds[row.key].min }}</ion-note>
            <ion-note slot="end">{{ bounds[row.key].max }}</ion-note>
          </ion-range>
        </ion-item>
      }

      <ion-item>
        <ion-icon
          aria-hidden="true"
          slot="start"
          ios="resize-outline"
          md="resize-sharp"
        ></ion-icon>
        <ion-select
          label="Image smooth"
          [value]="imageSmoothMethod()"
          (ionChange)="onImageSmoothMethodChange($event)"
          interface="popover"
          aria-label="Image smoothing method"
          class="smooth-select"
        >
          @for (opt of smoothOptions; track opt.value) {
            <ion-select-option [value]="opt.value">{{ opt.label }}</ion-select-option>
          }
        </ion-select>
      </ion-item>

      <ion-item>
        <ion-icon
          aria-hidden="true"
          slot="start"
          ios="color-wand-outline"
          md="color-wand-sharp"
        ></ion-icon>
        <ion-label>
          <h3>Grayscale</h3>
        </ion-label>
        <ion-toggle
          slot="end"
          [checked]="grayscaleEnabled()"
          (ionChange)="onGrayscaleToggle($event)"
          aria-label="Enable grayscale"
        ></ion-toggle>
      </ion-item>
    </ion-list>
  `,
  styles: [
    `
      .filters-list {
        padding-top: 8px;
      }
      .slider-row {
        --min-height: 32px;
        padding-inline: 12px;
      }
      .slider-row.is-disabled {
        opacity: 0.55;
      }
      ion-item ion-icon[slot='start'] {
        color: var(--ion-color-medium);
        font-size: 22px;
      }
      .smooth-select {
        min-width: 140px;
      }
      ion-select::part(label) {
        font-size: 0.875rem;
      }
    `,
  ],
})
export class FiltersSettingsComponent {
  private readonly settings = inject(SettingsService);

  public readonly sliderRows = SLIDER_ROWS;
  public readonly smoothOptions = SMOOTH_OPTIONS;
  public readonly bounds = FILTER_BOUNDS;

  /** Live snapshot of the filters object — recomputed whenever settings change. */
  private readonly filters = computed(() => this.settings.settings().filters);

  public getEnabled(key: Exclude<keyof FilterSettings, 'imageSmooth' | 'grayscale'>): boolean {
    return this.filters()[key].enabled;
  }

  public getValue(key: Exclude<keyof FilterSettings, 'imageSmooth' | 'grayscale'>): number {
    return this.filters()[key].value;
  }

  public readonly imageSmoothMethod = computed(() => this.filters().imageSmooth.method);

  /** Grayscale is a toggle-only filter (no value). */
  public readonly grayscaleEnabled = computed(() => this.filters().grayscale.enabled);

  public onGrayscaleToggle(event: CustomEvent<{ checked: boolean }>): void {
    this.settings.setGrayscale(event.detail.checked);
  }

  public onToggleChange(
    key: Exclude<keyof FilterSettings, 'imageSmooth' | 'grayscale'>,
    event: CustomEvent<{ checked: boolean }>,
  ): void {
    const current = this.filters()[key];
    this.settings.setFilter(key, event.detail.checked, current.value);
  }

  public onSliderChange(
    key: Exclude<keyof FilterSettings, 'imageSmooth' | 'grayscale'>,
    event: CustomEvent<RangeChangeEventDetail>,
  ): void {
    const raw = firstNumeric(event.detail.value);
    const current = this.filters()[key];
    this.settings.setFilter(key, current.enabled, raw);
  }

  public onImageSmoothMethodChange(event: CustomEvent<{ value: ImageSmoothMethod | undefined }>): void {
    const v = event.detail.value;
    if (v === undefined) return;
    if (
      v === 'none' ||
      v === 'nearest-neighbor' ||
      v === 'averaging' ||
      v === 'bilinear' ||
      v === 'bicubic' ||
      v === 'lanczos3'
    ) {
      this.settings.setImageSmoothMethod(v);
    }
  }
}

/** Extract the first numeric value from a RangeValue. Single-thumb ranges
 *  pass a number; dual-thumb ranges pass { lower, upper } or [lower, upper].
 *  Anything else falls back to NaN so the service receives a sane value
 *  to clamp. */
function firstNumeric(value: unknown): number {
  if (typeof value === 'number') return value;
  if (Array.isArray(value) && typeof value[0] === 'number') return value[0];
  if (value !== null && typeof value === 'object' && 'lower' in value && typeof value.lower === 'number') {
    return value.lower;
  }
  return Number.NaN;
}
