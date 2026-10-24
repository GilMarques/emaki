import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import {
  IonAlert,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonLabel,
  IonSearchbar,
  IonSegment,
  IonSegmentButton,
  IonTitle,
  IonToast,
  IonToolbar,
} from '@ionic/angular/standalone';

import type { LogEntry } from '../../core/debug/log-store';
import { LogService, type LogSource } from '../../core/services/log.service';
import { MenuButtonComponent } from '../../shared/menu-button.component';

type LevelFilter = 'all' | 'warn' | 'error';

/** Rows rendered at once. The buffer keeps more; the DOM does not need to. */
const MAX_VISIBLE = 400;

interface FilterCounts {
  readonly total: number;
  readonly warnings: number;
  readonly errors: number;
}

/**
 * Debug log viewer. Two sources:
 *  - "This session": the in-memory buffer, updated live.
 *  - "Saved file": what is actually persisted on the device (survives a crash
 *    or a restart), read when the page opens.
 *
 * Newest entries are on top, level filters narrow the list, and the whole
 * source can be copied to the clipboard for pasting into a report.
 */
@Component({
  selector: 'ov-logs',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonAlert,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonLabel,
    IonSearchbar,
    IonSegment,
    IonSegmentButton,
    IonTitle,
    IonToast,
    IonToolbar,
    MenuButtonComponent,
  ],
  templateUrl: './logs.page.html',
  styleUrls: ['./logs.page.scss'],
})
export class LogsPage {
  private readonly logs = inject(LogService);

  public readonly source = signal<LogSource>('session');
  public readonly query = signal('');
  public readonly filter = signal<LevelFilter>('all');

  public readonly filePath = this.logs.filePath;
  public readonly persisted = this.logs.persisted;

  /** Entries of the active source, oldest first. */
  public readonly active = computed<readonly LogEntry[]>(() =>
    this.source() === 'session' ? this.logs.entries() : this.logs.history(),
  );

  public readonly counts = computed<FilterCounts>(() => {
    let warnings = 0;
    let errors = 0;
    const all = this.active();
    for (const entry of all) {
      if (entry.level === 'error') errors++;
      else if (entry.level === 'warn') warnings++;
    }
    return { total: all.length, warnings, errors };
  });

  /** Entries matching the level filter and the search box, oldest first. */
  public readonly matched = computed<readonly LogEntry[]>(() => {
    const needle = this.query().trim().toLowerCase();
    const level = this.filter();
    return this.active().filter((entry) => {
      if (level === 'error' && entry.level !== 'error') return false;
      if (level === 'warn' && entry.level !== 'warn' && entry.level !== 'error') return false;
      if (needle === '') return true;
      return (
        entry.tag.toLowerCase().includes(needle) ||
        entry.message.toLowerCase().includes(needle) ||
        (entry.detail?.toLowerCase().includes(needle) ?? false)
      );
    });
  });

  /** Newest first, capped so a long session cannot bloat the DOM. */
  public readonly visible = computed<readonly LogEntry[]>(() =>
    this.matched().slice(-MAX_VISIBLE).reverse(),
  );

  /** Matching entries dropped by the DOM cap. */
  public readonly omitted = computed(() => Math.max(0, this.matched().length - MAX_VISIBLE));

  public readonly toastMessage = signal<string | null>(null);
  public readonly clearOpen = signal(false);
  public readonly clearButtons = [
    { text: 'Cancel', role: 'cancel' },
    { text: 'Clear', role: 'destructive' },
  ];

  constructor() {
    void this.logs.loadHistory();
  }

  public setSource(value: string | number | undefined): void {
    if (value === 'session' || value === 'device') this.source.set(value);
  }

  public setQuery(value: string | null | undefined): void {
    this.query.set(typeof value === 'string' ? value : '');
  }

  public setFilter(level: LevelFilter): void {
    this.filter.set(level);
  }

  /** `HH:MM:SS.mmm` in local time. */
  public timeOf(ts: number): string {
    const date = new Date(ts);
    const ms = String(date.getMilliseconds()).padStart(3, '0');
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}.${ms}`;
  }

  /** Full timestamp for the row tooltip. */
  public dateOf(ts: number): string {
    return new Date(ts).toISOString();
  }

  public async copyAll(): Promise<void> {
    if (this.active().length === 0) {
      this.toastMessage.set('Nothing to copy');
      return;
    }
    const ok = await this.logs.copy(this.source());
    this.toastMessage.set(
      ok
        ? `Copied ${this.active().length} log line${this.active().length === 1 ? '' : 's'}`
        : 'Could not copy the logs',
    );
  }

  public openClear(): void {
    this.clearOpen.set(true);
  }

  public onClearDismiss(role: string | undefined): void {
    this.clearOpen.set(false);
    if (role !== 'destructive') return;
    void this.logs.clearAll().then(() => this.toastMessage.set('Logs cleared'));
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
