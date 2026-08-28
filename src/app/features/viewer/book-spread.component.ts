import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  NgZone,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { BookFlipService } from '../../core/services/book-flip.service';
import { SettingsService } from '../../core/services/settings.service';
import type { Book } from '../../core/models/book.model';
import type { PageLayout, ZoomMode } from '../../core/models/settings.model';

/**
 * Host for a page-flip instance. Mounts the lib on its element ref and
 * remounts when book / layout / zoom changes.
 *
 * Mounting is driven by a `ResizeObserver` (not just an effect) because the
 * host can have zero size when the viewer first renders inside a modal that
 * is still laying out / animating in — an effect alone would mount against a
 * 0×0 box and the canvas would never appear. The observer re-triggers mount
 * the moment the host gets real dimensions.
 */
@Component({
  selector: 'ov-book-spread',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div #host class="spread-host"></div>`,
  styles: [
    `
      :host {
        display: block;
        width: 100%;
        height: 100%;
      }
      .spread-host {
        position: relative;
        width: 100%;
        height: 100%;
      }
    `,
  ],
})
export class BookSpreadComponent implements AfterViewInit, OnDestroy {
  /** Open book; identity change → remount. */
  public readonly book = input<Book | null>(null);

  /** Optional (not required) — reading it before resolution must not throw. */
  private readonly hostRef = viewChild<ElementRef<HTMLDivElement>>('host');
  private readonly flip = inject(BookFlipService);
  private readonly settings = inject(SettingsService);
  private readonly zone = inject(NgZone);

  public readonly layout = computed<'single' | 'double'>(() => {
    const layout: PageLayout = this.settings.settings().display.pageLayout;
    if (layout === 'auto-dual') return 'double';
    return 'single';
  });

  public readonly zoom = computed<ZoomMode>(() => this.settings.settings().display.zoom);

  private resizeObserver?: ResizeObserver;
  /** Key of the last successful mount, so we don't remount on every pixel. */
  private mountedKey = '';

  constructor() {
    effect(() => {
      // Re-read the inputs so this effect re-runs when any of them change.
      this.book();
      this.layout();
      this.zoom();
      this.tryMount();
    });
  }

  public ngAfterViewInit(): void {
    const ref = this.hostRef();
    if (ref !== undefined) {
      this.resizeObserver = new ResizeObserver(() => this.zone.run(() => this.tryMount()));
      this.resizeObserver.observe(ref.nativeElement);
    }
    this.tryMount();
  }

  public ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.flip.unmount();
  }

  @HostListener('window:resize')
  public onResize(): void {
    this.flip.update();
  }

  /** Mount when we have a book and a host with real dimensions. */
  private tryMount(): void {
    const book = this.book();
    const host = this.hostRef();
    if (book === null || host === undefined) return;

    const el = host.nativeElement;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w <= 0 || h <= 0) return;

    const layout = this.layout();
    const zoom = this.zoom();
    const key = `${book.id}:${layout}:${zoom}:${w}x${h}`;
    if (key === this.mountedKey && this.flip.mounted()) return;

    this.mountedKey = key;
    this.flip.mount(el, book, layout, zoom);
  }
}
