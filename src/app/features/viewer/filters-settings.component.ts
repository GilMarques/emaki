import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import {
  IonIcon,
  IonList,
  IonRange,
  IonToggle,
  type RangeChangeEventDetail,
} from '@ionic/angular/standalone';

import type { FilterSettings } from '../../core/models/settings.model';
import { FILTER_BOUNDS } from '../../core/models/settings.model';
import { SettingsService } from '../../core/services/settings.service';

interface SliderRow {
  readonly key: Exclude<keyof FilterSettings, 'imageSmooth' | 'grayscale'>;
  readonly label: string;
  readonly suffix: string;
  readonly icon: string;
}

/** One row per slider filter. Keep the order = the order the user sees them. */
const SLIDER_ROWS: readonly SliderRow[] = [
  { key: 'brightness', label: 'Brightness', suffix: '%', icon: 'sunny' },
  { key: 'blueLight', label: 'Blue light filter', suffix: '%', icon: 'eye' },
  { key: 'contrast', label: 'Contrast', suffix: '%', icon: 'contrast' },
  { key: 'sepia', label: 'Sepia', suffix: '%', icon: 'leaf' },
  { key: 'grain', label: 'Grain', suffix: '%', icon: 'sparkles' },
];

/**
 * Filters tab. On a normal screen each slider is two lines: icon, name, and
 * toggle, then the track underneath. When the viewport is short, the track
 * moves onto the same line so the dialog can stay content-sized without
 * scrolling. Grayscale is a toggle with no slider.
 *
 * When a toggle is off, the name and the slider (track and endpoint labels)
 * dim. The toggle stays at full contrast. The value is preserved either way;
 * the toggle only decides whether the filter is applied.
 */
@Component({
  selector: 'ov-filters-settings',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonIcon, IonList, IonRange, IonToggle],
  template: `
    <ion-list lines="none" class="filters-list">
      @for (row of sliderRows; track row.key) {
        <div class="filter-unit" [class.is-off]="!getEnabled(row.key)">
          <ion-icon
            class="filter-icon"
            aria-hidden="true"
            [ios]="row.icon + '-outline'"
            [md]="row.icon + '-sharp'"
          ></ion-icon>
          <span class="filter-name">{{ row.label }}</span>
          <div class="filter-slider">
            <span class="endpoint">{{ bounds[row.key].min }}</span>
            <ion-range
              [min]="bounds[row.key].min"
              [max]="bounds[row.key].max"
              [step]="bounds[row.key].step"
              [value]="getValue(row.key)"
              (ionInput)="onSliderChange(row.key, $event)"
              [disabled]="!getEnabled(row.key)"
              [attr.aria-label]="row.label + ' slider'"
            ></ion-range>
            <span class="endpoint">{{ bounds[row.key].max }}</span>
          </div>
          <ion-toggle
            [checked]="getEnabled(row.key)"
            (ionChange)="onToggleChange(row.key, $event)"
            [attr.aria-label]="'Enable ' + row.label"
          ></ion-toggle>
        </div>
      }

      <div class="filter-unit filter-toggle-only">
        <ion-icon
          class="filter-icon"
          aria-hidden="true"
          ios="color-wand-outline"
          md="color-wand-sharp"
        ></ion-icon>
        <span class="filter-name">Grayscale</span>
        <ion-toggle
          [checked]="grayscaleEnabled()"
          (ionChange)="onGrayscaleToggle($event)"
          aria-label="Enable grayscale"
        ></ion-toggle>
      </div>
    </ion-list>
  `,
  styles: [
    `
      .filters-list {
        padding-top: 4px;
        background: transparent;
      }
      .filter-unit {
        display: grid;
        grid-template-columns: 22px minmax(0, 1fr) auto;
        grid-template-areas:
          'icon name toggle'
          'slider slider slider';
        align-items: center;
        column-gap: 12px;
        row-gap: 2px;
        min-height: 64px;
        padding: 8px 16px 6px;
      }
      .filter-toggle-only {
        grid-template-areas: 'icon name toggle';
        min-height: 48px;
        padding-top: 6px;
        padding-bottom: 6px;
      }
      .filter-icon {
        grid-area: icon;
        color: var(--ion-color-medium);
        font-size: 22px;
      }
      .filter-name {
        grid-area: name;
        min-width: 0;
        font-size: 0.875rem;
        line-height: 1.25;
      }
      ion-toggle {
        grid-area: toggle;
        justify-self: end;
      }
      .filter-slider {
        grid-area: slider;
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 24px;
        margin-inline-start: 34px;
      }
      .endpoint {
        flex: 0 0 auto;
        min-width: 1.75rem;
        font-size: 0.75rem;
        color: var(--ion-color-medium);
        font-variant-numeric: tabular-nums;
      }
      .endpoint:last-child {
        text-align: end;
      }
      .filter-slider ion-range {
        flex: 1;
        min-width: 0;
        padding: 0;
        --height: 24px;
        --bar-height: 3px;
        --bar-border-radius: 2px;
        --knob-size: 0px;
        --knob-box-shadow: none;
      }
      /* Ionic paints a white outline on the disabled knob that wins over
         ::part() without !important. Size is already 0; this keeps that
         outline from showing a handle. */
      .filter-slider ion-range::part(knob) {
        opacity: 0 !important;
        background: transparent !important;
        box-shadow: none !important;
        outline: none !important;
      }
      .filter-slider ion-range::part(pin) {
        display: none;
      }
      .filter-unit.is-off .filter-name,
      .filter-unit.is-off .filter-slider {
        opacity: 0.45;
      }

      /* Short window: one line per filter. Text stays at the same size. */
      @media (max-height: 700px) {
        .filter-unit {
          grid-template-columns: 22px minmax(7.5rem, 9.5rem) minmax(2.5rem, 1fr) auto;
          grid-template-areas: 'icon name slider toggle';
          min-height: 44px;
          padding: 2px 12px;
          column-gap: 10px;
          row-gap: 0;
        }
        .filter-toggle-only {
          grid-template-areas: 'icon name . toggle';
          min-height: 44px;
        }
        .filter-slider {
          margin-inline-start: 0;
          min-height: 32px;
          gap: 6px;
        }
      }

      @media (max-height: 700px) and (max-width: 420px) {
        .filter-unit {
          grid-template-columns: 22px minmax(6.5rem, 7.5rem) minmax(1.875rem, 1fr) auto;
          column-gap: 6px;
          padding-inline: 10px;
        }
      }

      @media (max-height: 480px) {
        .filters-list {
          padding-top: 0;
        }
        .filter-unit {
          min-height: 38px;
          column-gap: 6px;
        }
        .filter-toggle-only {
          min-height: 38px;
        }
        .filter-slider {
          min-height: 28px;
        }
        .filter-slider ion-range {
          --height: 22px;
        }
      }
    `,
  ],
})
export class FiltersSettingsComponent {
  private readonly settings = inject(SettingsService);

  public readonly sliderRows = SLIDER_ROWS;
  public readonly bounds = FILTER_BOUNDS;

  /** Live snapshot of the filters object — recomputed whenever settings change. */
  private readonly filters = computed(() => this.settings.settings().filters);

  public getEnabled(key: Exclude<keyof FilterSettings, 'imageSmooth' | 'grayscale'>): boolean {
    return this.filters()[key].enabled;
  }

  public getValue(key: Exclude<keyof FilterSettings, 'imageSmooth' | 'grayscale'>): number {
    return this.filters()[key].value;
  }

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
