import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { IonButton, IonIcon, MenuController } from '@ionic/angular/standalone';

import { MenuStateService } from '../core/services/menu-state.service';

/**
 * Header navigation button shown on every page.
 *
 * Docked layout (md+): toggles the docked sidebar fully open or closed.
 * Overlay layout (below md): opens the side menu as a drawer.
 */
@Component({
  selector: 'ov-menu-button',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonButton, IonIcon],
  template: `
    <ion-button class="ov-menu-button" (click)="toggle()" [attr.aria-label]="label()">
      <ion-icon slot="icon-only" name="menu-outline"></ion-icon>
    </ion-button>
  `,
  styles: `
    :host {
      display: inline-flex;
      flex: 0 0 auto;
    }

    /* Match Ionic's own menu button: transparent, inherits the toolbar color. */
    ion-button {
      height: 36px;
      margin: 0 2px;
      --padding-start: 8px;
      --padding-end: 8px;
      --background: transparent;
      --background-hover: transparent;
      --background-activated: transparent;
      --background-focused: transparent;
      --box-shadow: none;
      --border-radius: 0;
      --color: inherit;
    }

    ion-icon {
      font-size: 24px;
    }
  `,
})
export class MenuButtonComponent {
  private readonly menu = inject(MenuStateService);
  private readonly menuController = inject(MenuController);

  /** "Open" when the sidebar is hidden (or on the drawer layout), else "Close". */
  public readonly label = computed(() =>
    this.menu.docked() && !this.menu.collapsed() ? 'Close menu' : 'Open menu',
  );

  public toggle(): void {
    if (this.menu.docked()) {
      this.menu.toggle();
      return;
    }
    void this.menuController.toggle('start');
  }
}
