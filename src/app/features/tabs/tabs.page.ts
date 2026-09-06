import { ChangeDetectionStrategy, Component, EnvironmentInjector, inject } from '@angular/core';
import { IonIcon, IonLabel, IonTabBar, IonTabButton, IonTabs } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { globeOutline, libraryOutline, settingsOutline } from 'ionicons/icons';

/**
 * Top-level tab shell. Hosts the Library, Provider and Settings tabs as
 * child routes (see `features/tabs/tabs.routes.ts`). The tab bar mirrors
 * the active URL; ion-tabs manages the router outlet itself.
 */
@Component({
  selector: 'ov-tabs',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IonIcon, IonLabel, IonTabBar, IonTabButton, IonTabs],
  templateUrl: './tabs.page.html',
  styleUrls: ['./tabs.page.scss'],
})
export class TabsPage {
  public readonly environmentInjector = inject(EnvironmentInjector);

  constructor() {
    addIcons({ libraryOutline, globeOutline, settingsOutline });
  }
}
