# Bookshelf & Library — Implementation Plan

## Context / platform reality

- The shipping app is **not web**. Targets are **mobile (Capacitor/Android)** and **desktop
  (Tauri 2)**. Web (`ng serve`) is a **debug-only** runtime.
- Because web can't reach the real filesystem, the v1 Bookshelf is exercised from a **set of preset
  books bundled under `src/assets/`**. Real on-device scanning (Tauri desktop FS, Android SAF) is a
  **later phase** and is intentionally out of v1.
- This keeps v1 fully testable today: drop image folders into `assets/`, run a generator, open the
  Bookshelf, and validate grid → open → next-book end to end.

## Goal (v1)

A **Library / Bookshelf**: a graphical grid of registered books with cover thumbnails that routes
into the existing Viewer, plus "next book" navigation when a book is finished.

- **Book (v1)** = a folder of images (PNG/JPG/GIF/BMP/WebP/TIFF…). PDF/CBZ/7Z deferred but the model
  leaves room.
- **Scan** (debug) = load the bundled preset manifest and register every preset book (first image =
  cover). On real devices this becomes "walk the picked root and register image-folders" — same
  `ScannerService`, different backend.
- **Open** = tap a book → Viewer. **Next book** = at the end of a book, advance to the next shelf book.

## Current state

- `core/services/bookstore.service.ts` — in-memory open book + page index + zoom. One book at a time;
  no *collection*.
- `core/models/book.model.ts` — `Book { id, title, pages: Page[] }`, `Page { index, url, label? }`.
- `features/viewer/viewer.page.ts` — auto-opens `buildHxHChapterOneSample()` if nothing open
  (lines 221-223); no "next book".
- `features/bookshelf/bookshelf.page.ts` — empty stub.
- `core/debug/sample-books.ts` — already hardcodes one `assets/sample/...` book; model for presets.
- No Dexie. `@capacitor/filesystem` present but **not** the scanner (see below).

## Architecture

### 1. `ShelfService` — registered library (new, `core/services/shelf.service.ts`)
In-memory signals for v1 (no Dexie yet — persistence is a real-device concern). API:
- `books` — sorted reactive list
- `byId(id)`, `addOrUpdate(book)` (idempotent, dedupe by stable id), `remove(id)`
- `nextBookId(id)` / `prevBookId(id)` — shelf order for "next book"
- `setProgress(id, pageIndex)` — field ready now, UI deferred
- `hasBooks` — for empty-state / dev fallback

### 2. `BookstoreService` — runtime (extend existing)
- `openById(id)` — load from `ShelfService`, set state (index 0 or saved progress)
- `openNext()` / `openPrev()` — advance within the shelf
- keep all existing `next/prev/goTo/zoom`

### 3. Data model (`core/models/book.model.ts`)
- `BookSource` union: `{ type: 'preset'; basePath: string } | { type: 'folder'; uri: string } | …`
  (`preset` = v1; `folder` is the later real-device shape)
- extend `Book` with `coverUrl?: string` and `source: BookSource`; keep `pages: Page[]`
- v1: pages + cover are known from the manifest, so the Viewer needs zero changes

### 4. Book discovery — `LibraryScannerPort` (`core/native/library-scanner.port.ts`)
Interface (typed wrapper; AGENTS.md "don't call Plugins.X directly"):
- `discover(): Promise<DiscoveredBook[]>` where `DiscoveredBook { id; title; imageUrls: string[] }`
- `ScannerService` turns each into a `Book` (cover = `imageUrls[0]`) and registers it.

Backends:
- **v1: `AssetsPresetPort`** — fetches `assets/preset-books.json` (generated, see below) and maps
  each entry to a `DiscoveredBook` with `assets/...` URLs. This is what "Scan" uses in debug/web.
- **Later (desktop): `TauriScannerPort`** — Tauri command walks a user-picked directory (Rust side).
- **Later (mobile): `SafScannerPort`** — wraps `@capacitor-community/saf` (AGENTS.md requirement).
- `@capacitor/filesystem` is **not** used for discovery (web = sandboxed IndexedDB; native = scoped
  storage). It may later cache cover blobs, not discover books.

### 5. Preset manifest generator (`scripts/gen-preset-books.mjs`)
Angular can't enumerate `assets/` at runtime, so a small Node script walks `src/assets/sample/`,
groups image files per top-level folder, and writes `src/assets/preset-books.json`
(`{ books: [{ id, title, imageUrls }] }`). Wired as `npm run presets:gen` and run in `prestart` /
`prebuild` (or just before testing). Adding images → re-run → manifest updates, no code edits.

### 6. `ScannerService` (`core/services/scanner.service.ts`)
`scan(onProgress)` → call active `LibraryScannerPort.discover()` → for each `DiscoveredBook` build a
`Book` (cover = first image) → `shelf.addOrUpdate`. Emit progress (`booksFound`). In v1 the active
port is `AssetsPresetPort`; swapping to Tauri/SAF later is a one-line provider change.

## UI

### `BookshelfPage`
- Toolbar **Scan** button (re-scan / clear-library later). In v1 it loads the preset manifest.
- CSS grid of book cards: cover `<img [src]="coverUrl">` + title. Empty-state when no books.
- Tap card → `bookstore.openById(id)` → `router.navigate(['/viewer'])`.
- Scan progress (count / spinner) while scanning. (later) per-book progress badge.

### `ViewerPage`
- Remove the unconditional sample auto-load; fall back to it only when the shelf is empty in dev.
- At the **last page**, a next gesture/control calls `bookstore.openNext()` instead of no-op → loads
  the next shelf book (toast "Now reading: <title>" or end-of-book sheet: "Next book: <title>" /
  "Back to shelf").
- Exit-to-shelf affordance (menu / back to `/bookshelf`).

### Routing (`app.routes.ts`)
- Default redirect `/` → `/bookshelf` (currently `/viewer`).

## Phased steps

1. **Model + ShelfService** — extend `book.model.ts` (`BookSource`, `coverUrl`); add `ShelfService`
   (signals) + `BookstoreService.openById/openNext/openPrev`. Unit-test the collection
   (add / dedupe / next / prev / progress).
2. **Preset pipeline** — `scripts/gen-preset-books.mjs` → `assets/preset-books.json`; wire
   `presets:gen` into `start`/`build`; `LibraryScannerPort` + `AssetsPresetPort`; `ScannerService`.
3. **Bookshelf UI** — scan button, grid, cards, empty state, routing into the viewer.
4. **Viewer integration** — end-of-book → next-book affordance; default route → bookshelf; gate
   sample auto-load behind empty-shelf dev fallback.
5. **Polish & verify** — `npm run lint`, `npm run build`, manual smoke test: add a couple of image
   folders to `assets/sample/` → `presets:gen` → scan → grid → open → flip to end → next book loads.

## Decisions (locked)

1. **Discovery backend** — v1 uses `AssetsPresetPort` (bundled manifest). **No File System Access
   API.** Real devices: Tauri (desktop) + SAF (mobile), deferred. `@capacitor/filesystem` is not the
   scanner.
2. **Default route** → `/bookshelf` (confirmed). Sample auto-load = dev-only empty-shelf fallback.
3. **Persistence** — Dexie/IndexedDB **deferred** to the real-device phase (library should survive
   relaunch there). v1 `ShelfService` is in-memory signals; preset books reload from the manifest.
4. **Progress field** — add now (data only, no UI) so "next book" + later progress UI are trivial.
5. **Covers** — in v1 the cover URL is just the first preset asset URL (no Blob caching needed since
   assets are served by the app). Blob caching is a real-device concern.

## Explicitly deferred (out of v1)
Real filesystem scanning (Tauri desktop commands, Android SAF), Dexie persistence / cross-relaunch
library, PDF/CBZ/7Z (`BookSource` extension), reading-progress UI, favorites/bookmarks, SMB/SFTP/OPDS/
cloud, colorization/upscaling.
