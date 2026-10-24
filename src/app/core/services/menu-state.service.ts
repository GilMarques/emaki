import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';

const COLLAPSED_KEY = 'openviewer:menu-collapsed';

/** Must match the split pane's `when` in the app shell. */
export const MENU_DOCKED_QUERY = '(min-width: 768px)';

/**
 * Shell navigation state shared by the app shell and the page headers.
 *
 * From `md` up the menu is docked by the split pane: "collapsed" hides it
 * completely and the content takes the full width. Below `md` the same signal
 * is irrelevant — the menu is an overlay drawer. `docked` tracks the
 * breakpoint so the menu button knows whether to toggle the sidebar or open
 * the drawer.
 *
 * The collapsed choice is persisted so it survives restarts.
 */
@Injectable({ providedIn: 'root' })
export class MenuStateService {
  private readonly destroyRef = inject(DestroyRef);
  private readonly media: MediaQueryList | null =
    typeof window === 'undefined' ? null : window.matchMedia(MENU_DOCKED_QUERY);

  private readonly _docked = signal(this.media?.matches ?? false);
  /** True when the layout docks the menu (md+). */
  public readonly docked = this._docked.asReadonly();

  private readonly _collapsed = signal(loadCollapsed());
  /** True when the user collapsed the docked menu. */
  public readonly collapsed = this._collapsed.asReadonly();

  /** Collapsed *and* docked — the menu is fully out of the layout. */
  public readonly hidden = computed(() => this._docked() && this._collapsed());

  constructor() {
    const media = this.media;
    if (media === null) return;
    const onChange = (event: MediaQueryListEvent): void => this._docked.set(event.matches);
    media.addEventListener('change', onChange);
    this.destroyRef.onDestroy(() => media.removeEventListener('change', onChange));
  }

  public toggle(): void {
    this.setCollapsed(!this._collapsed());
  }

  public setCollapsed(collapsed: boolean): void {
    this._collapsed.set(collapsed);
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      // Persistence is best-effort, like the other UI preferences.
    }
  }
}

function loadCollapsed(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    // Storage disabled: start expanded.
    return false;
  }
}
