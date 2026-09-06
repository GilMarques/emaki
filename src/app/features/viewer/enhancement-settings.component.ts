import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import {
  IonButton,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonProgressBar,
  IonSelect,
  IonSelectOption,
  IonToggle,
} from '@ionic/angular/standalone';

import { BookstoreService } from '../../core/services/bookstore.service';
import { ScanEnhancementService } from '../../core/services/scan-enhancement.service';

/**
 * Reader-facing controls for the opt-in scan enhancement feature.
 *
 * v1 surface: an explicit enable toggle (enhancement never starts without it),
 * a model choice, live progress, and pause/resume. Advanced controls (denoise,
 * output quality, 4x) are intentionally hidden until device benchmarks justify
 * exposing them. When the native backend is unavailable we show a single note
 * and disable the toggle.
 */
@Component({
  selector: 'ov-enhancement-settings',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonButton,
    IonItem,
    IonLabel,
    IonList,
    IonNote,
    IonProgressBar,
    IonSelect,
    IonSelectOption,
    IonToggle,
  ],
  template: `
    <ion-list lines="none">
      @if (!supported()) {
        <ion-item>
          <ion-note>AI upscaling isn't available on this device.</ion-note>
        </ion-item>
      } @else {
        <ion-item>
          <ion-label>Enhance scans</ion-label>
          <ion-toggle
            slot="end"
            [checked]="enabled()"
            (ionChange)="onToggle()"
          ></ion-toggle>
        </ion-item>

        @if (enabled()) {
          <ion-item>
            <ion-label>Model</ion-label>
            <ion-select
              slot="end"
              [value]="model()"
              (ionChange)="onModel($event)"
            >
              @for (m of modelOptions(); track m) {
                <ion-select-option [value]="m">{{ modelLabel(m) }}</ion-select-option>
              }
            </ion-select>
          </ion-item>

          <ion-item>
            <ion-label>Scale</ion-label>
            <ion-note slot="end">{{ scaleLabel() }}</ion-note>
          </ion-item>


          <ion-item>
            <ion-label>Progress</ion-label>
            <ion-note slot="end">{{ progress().done }} / {{ progress().total }}</ion-note>
          </ion-item>
          <ion-progress-bar [value]="ratio()"></ion-progress-bar>

          <ion-item>
            @if (paused()) {
              <ion-button fill="clear" (click)="resume()">Resume</ion-button>
            } @else {
              <ion-button fill="clear" (click)="pause()">Pause</ion-button>
            }
            <ion-button fill="clear" color="medium" (click)="disable()">Stop</ion-button>
          </ion-item>
        }
      }
    </ion-list>
  `,
  styles: [
    `
      ion-progress-bar {
        margin: 4px 16px 8px;
      }
    `,
  ],
})
export class EnhancementSettingsComponent {
  private readonly bookstore = inject(BookstoreService);
  private readonly scan = inject(ScanEnhancementService);

  public readonly supported = this.scan.isSupported;
  public readonly enabled = this.scan.isActive;
  public readonly paused = this.scan.paused;
  public readonly model = computed(() => this.scan.settings().model);
  /** Model ids the backend actually bundles — the only valid choices. */
  public readonly modelOptions = computed(() => this.scan.capabilities().models);
  public readonly progress = this.scan.progress;
  public readonly ratio = computed(() => {
    const p = this.scan.progress();
    return p.total === 0 ? 0 : p.done / p.total;
  });

  /** Current upscale factor, derived from the selected model + settings. */
  public readonly scaleLabel = computed(() => `${this.scan.settings().scale}×`);

  public onToggle(): void {
    const book = this.bookstore.state().book;
    if (book === null) return;
    void this.scan.toggle(book);
  }

  public onModel(event: CustomEvent): void {
    const value = String((event.detail as { value?: unknown }).value ?? '');
    if (!value) return;
    // A model implies a scale (x2 nets upscale 2×, x4 nets 4×). Keep the two in
    // sync so the backend always receives a scale matching the chosen weights.
    const scale = scaleForModel(value);
    void this.scan.updateSettings({ model: value, scale });
  }

  /** Human-readable label for a model id (the backend reports raw ids). */
  public modelLabel(id: string): string {
    return MODEL_LABELS[id] ?? id;
  }

  public pause(): void {
    this.scan.pause();
  }

  public resume(): void {
    this.scan.resume();
  }

  public disable(): void {
    void this.scan.disable();
  }
}

/** Friendly labels for the model ids reported by the backends. */
const MODEL_LABELS: Record<string, string> = {
  'realesrgan-v2-anime-x2': 'Real-ESRGAN v2 anime · 2×',
  'realesrgan-x4': 'Real-ESRGAN · 4×',
  'real_esrgan_x2plus': 'Real-ESRGAN x2 (general) · 2×',
  'real_esrgan_x4plus': 'Real-ESRGAN x4 (general) · 4×',
};

/** Derive the upscale factor implied by a model id (2× for x2/v2 nets, else 4×). */
function scaleForModel(id: string): 2 | 4 {
  return id.includes('x2') || id.includes('2x') || id.includes('v2') ? 2 : 4;
}
