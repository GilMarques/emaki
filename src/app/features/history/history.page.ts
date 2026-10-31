import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  IonAlert,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonImg,
  IonTitle,
  IonToast,
  IonToolbar,
} from '@ionic/angular/standalone';

import type { HistoryEntry } from '../../core/models/history.model';
import { MenuButtonComponent } from '../../shared/menu-button.component';
import { BookstoreService } from '../../core/services/bookstore.service';
import { FilePageService } from '../../core/services/file-page.service';
import { HistoryService } from '../../core/services/history.service';
import { ScannerService } from '../../core/services/scanner.service';
import { ShelfService } from '../../core/services/shelf.service';

/** One "Today" / "Yesterday" / date section of the list. */
interface HistoryGroup {
  readonly key: string;
  readonly label: string;
  readonly entries: readonly HistoryEntry[];
}

/**
 * Reading history: every book the user has opened, newest first, with the
 * page they stopped on. Tapping a row resumes that book at that page.
 *
 * The list survives restarts (HistoryService persists it), but the shelf does
 * not — it is rebuilt from disk by a scan. When history is opened before the
 * library has ever been registered this session, a scan is kicked off in the
 * background so rows become resumable instead of reading "Not in library".
 */
@Component({
  selector: 'ov-history',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    IonAlert,
    IonButton,
    IonButtons,
    IonContent,
    IonHeader,
    IonIcon,
    IonImg,
      IonTitle,
    IonToast,
    IonToolbar,
    MenuButtonComponent,
  ],
  templateUrl: './history.page.html',
  styleUrls: ['./history.page.scss'],
})
export class HistoryPage {
  private readonly history = inject(HistoryService);
  private readonly shelf = inject(ShelfService);
  private readonly scanner = inject(ScannerService);
  private readonly bookstore = inject(BookstoreService);
  private readonly filePages = inject(FilePageService);

  public readonly entries = this.history.entries;
  public readonly hasEntries = this.history.hasEntries;

  /** Confirmation alert for the header's clear button. */
  public readonly clearOpen = signal(false);
  public readonly clearButtons = [
    { text: 'Cancel', role: 'cancel' },
    { text: 'Clear', role: 'destructive' },
  ];

  public readonly toastMessage = signal<string | null>(null);

  /** Drives the relative timestamps; bumped once a minute. */
  private readonly now = signal(Date.now());

  /** Rows grouped into day sections, newest first. */
  public readonly groups = computed<readonly HistoryGroup[]>(() => {
    const now = this.now();
    const out: { key: string; label: string; entries: HistoryEntry[] }[] = [];
    for (const entry of this.entries()) {
      const key = dayKey(entry.readAt);
      const last = out[out.length - 1];
      if (last !== undefined && last.key === key) {
        last.entries.push(entry);
      } else {
        out.push({ key, label: dayLabel(entry.readAt, now), entries: [entry] });
      }
    }
    return out;
  });

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 60_000);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));

    // History outlives the shelf. On a fresh start the shelf is empty until a
    // scan registers books again — do that here so history can resume them.
    if (this.hasEntries() && this.shelf.books().length === 0) {
      void this.scanner.scan();
    }
  }

  /** True when the shelf can currently resolve the entry's book. */
  public isAvailable(entry: HistoryEntry): boolean {
    return this.shelf.byId(entry.bookId) !== undefined;
  }

  /** Raw page count from the shelf when present, else the history snapshot. */
  private pageCountFor(entry: HistoryEntry): number {
    return this.shelf.byId(entry.bookId)?.pages.length ?? entry.pageCount;
  }

  /** Completion percentage, 0..100. */
  public percentFor(entry: HistoryEntry): number {
    const count = this.pageCountFor(entry);
    if (count <= 0) return 0;
    return Math.min(100, Math.round((this.pageNumberFor(entry) / count) * 100));
  }

  /** 1-based page number, clamped to the current page count. */
  private pageNumberFor(entry: HistoryEntry): number {
    return Math.min(entry.pageIndex + 1, Math.max(1, this.pageCountFor(entry)));
  }

  /** Caption under the title: where the reader stopped, or why it can't open. */
  public metaFor(entry: HistoryEntry): string {
    if (!this.isAvailable(entry)) {
      return this.scanner.scanning() ? 'Restoring book…' : 'Not in library';
    }
    const count = this.pageCountFor(entry);
    return `Page ${this.pageNumberFor(entry)} of ${count} · ${this.percentFor(entry)}%`;
  }

  /** Resolved cover URL for a row, warming fs covers like the shelf does. */
  public coverFor(entry: HistoryEntry): string | undefined {
    const raw = this.shelf.byId(entry.bookId)?.coverUrl ?? entry.coverUrl;
    if (raw === undefined) return undefined;
    if (this.filePages.needsResolve(raw)) {
      // Track the resolver revision so the cover re-renders once its blob
      // URL is ready (the convertFileSrc fast path is synchronous anyway).
      this.filePages.revision();
      return this.filePages.displayUrl(raw);
    }
    return raw;
  }

  /** Human-friendly last-read time ("Just now", "5m ago", "12 Oct"). */
  public readTime(entry: HistoryEntry): string {
    return relativeReadTime(entry.readAt, this.now());
  }

  /** Resume a book at the exact page it was left on. */
  public resume(entry: HistoryEntry): void {
    if (!this.isAvailable(entry)) {
      this.toastMessage.set(
        this.scanner.scanning()
          ? 'Still restoring your library — try again in a moment.'
          : 'This book isn’t in your library anymore.',
      );
      return;
    }
    this.bookstore.openById(entry.bookId, entry.pageIndex);
    const book = this.shelf.byId(entry.bookId);
    // Warm real-disk pages like the shelf does; the reader resolves lazily
    // anyway, so this doesn't need to block the tap.
    if (book?.source.type === 'folder') void this.filePages.preload(book);
  }

  public remove(entry: HistoryEntry): void {
    this.history.remove(entry.bookId);
  }

  public openClear(): void {
    this.clearOpen.set(true);
  }

  public onClearDismiss(role: string | undefined): void {
    this.clearOpen.set(false);
    if (role === 'destructive') this.history.clear();
  }
}

/** Local calendar day as `YYYY-MM-DD`, so grouping is timezone-correct. */
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Section header for a day: Today, Yesterday, or a short date. */
export function dayLabel(ms: number, now: number): string {
  const key = dayKey(ms);
  if (key === dayKey(now)) return 'Today';
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (key === dayKey(yesterday.getTime())) return 'Yesterday';
  return shortDate(ms, now);
}

/** Compact "5m ago" / "3h ago" / "12 Oct" label. */
export function relativeReadTime(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return 'Just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (dayKey(ms) === dayKey(now)) return `${Math.floor(diff / 3_600_000)}h ago`;
  return shortDate(ms, now);
}

function shortDate(ms: number, now: number): string {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(
    undefined,
    sameYear
      ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' },
  );
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : `${value}`;
}
