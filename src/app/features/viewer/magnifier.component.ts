import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';

import { SURROUND_FALLBACK } from '../../core/services/page-edge-color';

/**
 * Loupe overlay rendered when the user holds a pointer on the page.
 *
 * Geometry:
 *   - `imageRect` is the viewport bounds where the current page image is
 *     drawn (full stage in single layout, left/right half in dual spread).
 *   - Pointer coords map to a fractional position inside that rect, then to
 *     natural image pixels (srcX, srcY).
 *   - A large window (60% of the viewport width and height) docks at the
 *     corner opposite the pointer. CSS background-image samples the page URL;
 *     background-size and background-position centre srcX/srcY under the
 *     loupe centre.
 */
@Component({
  selector: 'ov-magnifier',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (visible()) {
      <div
        class="loupe"
        [class.tl]="placement() === 'tl'"
        [class.tr]="placement() === 'tr'"
        [class.bl]="placement() === 'bl'"
        [class.br]="placement() === 'br'"
        [style.background-image]="backgroundImage()"
        [style.background-size]="backgroundSize()"
        [style.background-position]="backgroundPosition()"
        [style.background-color]="background()"
        [style.width.px]="loupeWidthPx()"
        [style.height.px]="loupeHeightPx()"
        aria-hidden="true"
      ></div>
    }
  `,
  styles: [
    `
      :host {
        position: absolute;
        inset: 0;
        pointer-events: none;
        z-index: 5;
      }
      .loupe {
        position: absolute;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
        background-repeat: no-repeat;
      }
      .loupe.tl { top: 3vmin; left: 3vmin; }
      .loupe.tr { top: 3vmin; right: 3vmin; }
      .loupe.bl { bottom: 3vmin; left: 3vmin; }
      .loupe.br { bottom: 3vmin; right: 3vmin; }
    `,
  ],
})
export class MagnifierComponent {
  /** Whether the loupe should be shown. */
  public readonly active = input<boolean>(false);

  /** Page image URL — used as the background-image source. */
  public readonly pageUrl = input<string | null>(null);

  /** Pointer X in viewport coords. */
  public readonly pointerX = input<number>(0);

  /** Pointer Y in viewport coords. */
  public readonly pointerY = input<number>(0);

  /** Viewport rect of the rendered current page (not the full stage in dual spread). */
  public readonly imageRect = input<DOMRect | null>(null);

  /** Page image's natural pixel dimensions. */
  public readonly naturalWidth = input<number>(0);
  public readonly naturalHeight = input<number>(0);

  /** Magnification factor from settings. 1 = no zoom. */
  public readonly zoom = input<number>(1);

  /** Fills the loupe past the page edge. Same color as the viewer letterbox. */
  public readonly background = input<string>(SURROUND_FALLBACK);

  /** Viewport size (used for placement decisions). */
  public readonly viewportWidth = input<number>(0);
  public readonly viewportHeight = input<number>(0);

  /** Loupe window size — 60% of the viewport on each axis. */
  private static readonly LOUPE_VIEWPORT_FRACTION = 0.6;

  /** Loupe window width in CSS px (60% of the viewport width). */
  public readonly loupeWidthPx = computed(() => {
    const vw = this.viewportWidth();
    if (vw === 0) return 240;
    return Math.round(vw * MagnifierComponent.LOUPE_VIEWPORT_FRACTION);
  });

  /** Loupe window height in CSS px (60% of the viewport height). */
  public readonly loupeHeightPx = computed(() => {
    const vh = this.viewportHeight();
    if (vh === 0) return 240;
    return Math.round(vh * MagnifierComponent.LOUPE_VIEWPORT_FRACTION);
  });

  public readonly visible = computed(() => {
    if (!this.active()) return false;
    if (this.pageUrl() === null) return false;
    const rect = this.imageRect();
    if (rect === null) return false;
    if (this.naturalWidth() === 0 || this.naturalHeight() === 0) return false;
    const px = this.pointerX();
    const py = this.pointerY();
    return (
      px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom
    );
  });

  /** Where to dock the loupe: opposite diagonal of the pointer. */
  public readonly placement = computed<'tl' | 'tr' | 'bl' | 'br'>(() => {
    const vw = this.viewportWidth();
    const vh = this.viewportHeight();
    if (vw === 0 || vh === 0) return 'tl';
    return this.pointerX() < vw / 2
      ? this.pointerY() < vh / 2
        ? 'br'
        : 'tr'
      : this.pointerY() < vh / 2
        ? 'bl'
        : 'tl';
  });

  /** Fractional pointer position inside the rendered page rect. */
  private readonly pointerFraction = computed<{ fx: number; fy: number } | null>(() => {
    const rect = this.imageRect();
    if (rect === null || rect.width === 0 || rect.height === 0) return null;
    return {
      fx: (this.pointerX() - rect.left) / rect.width,
      fy: (this.pointerY() - rect.top) / rect.height,
    };
  });

  public readonly backgroundImage = computed(() => {
    const url = this.pageUrl();
    return url === null ? 'none' : `url("${url}")`;
  });

  /** Scaled natural dimensions — zoom applied once here (not via CSS transform). */
  public readonly backgroundSize = computed<string>(() => {
    const nw = this.naturalWidth();
    const nh = this.naturalHeight();
    const z = this.zoom();
    if (nw === 0 || nh === 0) return '0px 0px';
    return `${nw * z}px ${nh * z}px`;
  });

  /**
   * Offsets the scaled background so the source pixel under the pointer
   * sits at the centre of the loupe window.
   */
  public readonly backgroundPosition = computed<string>(() => {
    const frac = this.pointerFraction();
    if (frac === null) return '0px 0px';
    return loupeBackgroundPosition(
      frac.fx,
      frac.fy,
      this.naturalWidth(),
      this.naturalHeight(),
      this.zoom(),
      this.loupeWidthPx(),
      this.loupeHeightPx(),
    );
  });
}

/** Viewport rect of a page drawn at `frame` inside a spread scaled from its top-left. */
export function placedPageRect(
  stage: { readonly left: number; readonly top: number },
  panX: number,
  panY: number,
  frame: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  zoom: number,
): DOMRect {
  return new DOMRect(
    stage.left + panX + frame.x * zoom,
    stage.top + panY + frame.y * zoom,
    frame.width * zoom,
    frame.height * zoom,
  );
}

/** `background-position` that puts source fraction `(fx, fy)` at the loupe's centre. */
export function loupeBackgroundPosition(
  fx: number,
  fy: number,
  naturalWidth: number,
  naturalHeight: number,
  zoom: number,
  loupeWidth: number,
  loupeHeight: number,
): string {
  const x = -(fx * naturalWidth) * zoom + loupeWidth / 2;
  const y = -(fy * naturalHeight) * zoom + loupeHeight / 2;
  return `${x}px ${y}px`;
}
