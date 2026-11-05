import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { IonIcon, IonImg } from '@ionic/angular/standalone';

import { ConnectorRequestService } from '../core/connectors/connector-request.service';

/**
 * A cover or thumbnail. MangaDex image URLs are loaded through the provider
 * proxy. If the source is missing or the image fails, a placeholder icon
 * is shown instead of a broken picture.
 */
@Component({
  selector: 'ov-cover',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonIcon, IonImg],
  template: `
    @if (showImage()) {
      <ion-img [src]="resolvedSrc()" [alt]="alt()" (ionError)="onError()"></ion-img>
    } @else {
      <div class="fallback" aria-hidden="true">
        <ion-icon [name]="icon()"></ion-icon>
      </div>
    }
  `,
  styles: `
    :host {
      display: block;
      width: 100%;
      height: 100%;
      container-type: size;
    }

    ion-img {
      display: block;
      width: 100%;
      height: 100%;
    }

    ion-img::part(image) {
      width: 100%;
      height: 100%;
      object-fit: cover;
    }

    .fallback {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
      color: var(--ion-color-medium, #92949c);
    }

    .fallback ion-icon {
      font-size: clamp(18px, 38cqmin, 40px);
    }
  `,
})
export class CoverComponent {
  private readonly requests = inject(ConnectorRequestService);

  /** Image URL. Empty or a failed load shows the placeholder. */
  public readonly src = input<string | null | undefined>(undefined);
  public readonly alt = input('');
  /** Ionic icon name used when there is nothing to show. */
  public readonly icon = input('book-outline');

  /** Resolved URL that last failed to load. A new URL shows the image again. */
  private readonly failedSrc = signal<string | undefined>(undefined);

  public readonly resolvedSrc = computed(() => {
    const src = this.src();
    if (src === undefined || src === null || src.length === 0) return undefined;
    return this.requests.imageSrc(src);
  });

  public readonly showImage = computed(() => {
    const src = this.resolvedSrc();
    return src !== undefined && src !== this.failedSrc();
  });

  public onError(): void {
    const src = this.resolvedSrc();
    if (src !== undefined) this.failedSrc.set(src);
  }
}
