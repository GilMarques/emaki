# Tauri file browser — roam the local filesystem from the shelf

## Context

The shelf (`features/bookshelf`) is rooted at a generated preset manifest
(`assets/preset-library.json`, see `assets-preset.scanner.ts`). `LibraryScannerPort.discover()`
returns one in-memory `LibraryTree` whose root is literally named `"Library"`, and the
`BookshelfPage` only ever walks that fixed tree. There is no path to the real disk — once you
are at the Library root you cannot go anywhere else. That is the gap this plan closes.

We already have a desktop Tauri runtime (`src-tauri/`, `tauri.conf.json` with
`withGlobalTauri: true`, Rust commands in `lib.rs`, and a `TauriRealEsrganBackend` that talks to
it through the global `window.__TAURI__.core.invoke` without any `@tauri-apps/api` import). The
upscaling work also added `ScanEnhancementService.displayUrlFor(page)` as the single place where
a page's `url` is resolved into something the reader/canvas can draw — exactly the hook we need
to serve pages from an arbitrary filesystem path.

Scope stays inside v1 (local files + bookshelf + image/comic viewer). No SMB/SFTP/OPDS/cloud, no
PDF/DJVU, no new UI kits. EPUB is noted as a later separate reader path and is out of scope here.

## Decisions

1. **Path-based browser, not a giant in-memory tree.** The preset `LibraryTree` stays as-is for
   the existing Library tab. The file browser lists one directory at a time and expands lazily as
   the user descends — this matches the `akoskm/file-browser-tauri` reference and real disks
   (you never want to enumerate a whole drive up front).
2. **Sibling "Files" tab, not a replacement.** Add a segmented toggle at the top of the shelf:
   `Library` (existing preset/shelf) and `Files` (filesystem). Both reuse the same tile grid +
   breadcrumb chrome; `Library` behavior is untouched.
3. **Backend behind a `FileSystemBrowser` port.** `TauriFsBrowser` (real) plus
   `UnavailableFsBrowser` (web/debug, `isAvailable()` → false). The `Files` tab is only shown
   when `isAvailable()` is true, so the debug web build keeps exactly the current Library UX.
4. **Pages are served as cached object URLs, resolved through `displayUrlFor`.** A new
   `TauriFileAssetService` holds a `Map<fsPath, objectURL>` (and revokes URLs on book close to
   honor the 5-page LRU / memory budget). `ScanEnhancementService.displayUrlFor(page)` gains a
   branch: when `page.url` is a filesystem path (book `source.type === 'folder' | 'archive' and
   running under Tauri), return the cached/served object URL. The reader, canvas, and enhancement
   pipeline are unchanged because they already go through `displayUrlFor`.
5. **Formats for v1: folder-of-images and CBZ/CBR/7Z archives.** Archive extraction is done in
   Rust (zip/rar/7z crates) behind `list_archive` / `read_archive_entry` so we don't ship large
   wasm decoders in the first pass. The debug web build keeps only the preset and never needs the
   wasm libs. EPUB/PDF are explicitly deferred (different reader path).
6. **Native picker + std fs, no new Tauri fs plugin/capability.** Use the `rfd` crate for the
   folder picker and `std::fs` inside the new commands for listing/reading. This needs no
   `tauri-plugin-fs` scope and no change to `capabilities/default.json` (which stays
   `core:default`). Like the existing backend, call Rust via the global `__TAURI__` — no
   `@tauri-apps/api` hard dependency in the Angular bundle.
7. **Safety & performance.** Originals are read-only; enhanced derivatives stay in the separate
   store (`PageAssetService`). Served object URLs respect the existing 2× decode cap and 5-page
   LRU. The browser never loads a whole book into memory — `pages` carries logical paths/entry
   names and bytes are fetched on demand as the user flips.

## Implementation base

**Rust (`src-tauri/src/lib.rs` + `Cargo.toml`)**

- Add crates: `rfd` (folder picker) and archive readers (`zip`, plus `unrar`/`rar` and a 7z lib
  such as `sevenz-rust` or `sevenz`) — justified because they replace wasm decoders for v1.
- New commands (all return serializable structs; paths are absolute strings):
  - `pick_directory() -> Option<String>` — `rfd::FileDialog::new().pick_folder()`.
  - `list_directory(path: String) -> Vec<FsEntry>` — `std::fs::read_dir`, classify each entry as
    `dir | image | archive | other` (`archive` = `.cbz/.cbr/.7z`; `image` = jpg/png/webp/gif/bmp/
    tiff). Folders whose contents include ≥1 image are flagged `is_book` so the UI can show them
    as openable.
  - `read_file(path: String) -> Vec<u8>` — single image bytes (folder-of-images case).
  - `list_archive(path: String) -> Vec<ArchiveEntry>` — entries with name + size; image entries
    flagged.
  - `read_archive_entry(archive_path: String, entry: String) -> Vec<u8>` — extracted bytes for one
    image entry.
- Register the commands in `invoke_handler!`. No new managed state required beyond what exists.

**JavaScript abstraction**

- `core/native/file-system-browser.port.ts`:
  - `interface FsEntry { name; path; kind: 'dir'|'image'|'archive'|'other'; isBook: boolean }`
  - `interface FileSystemBrowser { isAvailable(): boolean; pickDirectory(): Promise<string|null>;
    listDirectory(path: string): Promise<FsEntry[]>; readFile(path: string): Promise<Blob>;
    listArchive(path: string): Promise<FsEntry[]>; readArchiveEntry(archive: string, entry: string): Promise<Blob> }`
  - `FILE_SYSTEM_BROWSER` multi/optional `InjectionToken`.
- `core/native/tauri-fs-browser.ts` — implements the port via `window.__TAURI__.core.invoke`
  (mirrors `tauri-real-esrgan.backend.ts`); `isAvailable()` returns true only when the global is
  present. `readFile`/`readArchiveEntry` return an `ArrayBuffer` that the asset service turns into
  an object URL.
- `core/native/unavailable-fs-browser.ts` — `isAvailable()` false, methods reject/return empty.
- `core/services/file-browser.service.ts` — signals `mode` is unused here; holds `currentPath`
  (`string[]` of path segments), `entries`, `busy`, `error`; methods `openPicker()`,
  `list(path?)`, `enter(entry)`, `goUp()`, `goToCrumb(depth)`, `crumbs()` computed. Decides which
  entries are openable books and calls `BookstoreService.openBook(buildBook(entry))`.
- `core/services/tauri-file-asset.service.ts` — `objectUrlFor(fsPath | {archive,entry})` (cached
  `URL.createObjectURL`), `revokeAll()` on book close. `ScanEnhancementService.displayUrlFor`
  gains the folder/archive branch that delegates here.
- Extend `BookSource` in `core/models/book.model.ts` with
  `{ type: 'folder'; uri: string } | { type: 'archive'; uri: string }`; page `url` carries the
  absolute path or `archive::entry` logical id.

**UI (`features/bookshelf`)**

- `bookshelf.page.ts/.html`: add `mode = signal<'library'|'files'>('library')` + a segmented
  control; render the existing library block when `library`, and a new
  `FileBrowserComponent` when `files`. Only register `FileBrowserComponent` if the backend is
  available (hide the `Files` segment otherwise).
- `features/bookshelf/file-browser.component.ts` — tiles + breadcrumbs bound to
  `FileBrowserService` (reuses `ion-breadcrumbs`, the same `.tile`/`.cover` styles). Tapping a
  `dir` descends; tapping a book (`isBook` folder or `archive`) opens it via the service.
- `BookstoreService` already opens a `Book`; add the small path to accept `folder`/`archive`
  sources and build `pages` with logical urls (folder: sorted image paths; archive: `listArchive`
  image entries). Opening flows into the same viewer as today.

## Work

- [ ] `Cargo.toml`: add `rfd` + archive crates; `lib.rs`: add the 5 commands + register them.
- [ ] `file-system-browser.port.ts` + `tauri-fs-browser.ts` + `unavailable-fs-browser.ts`;
      provide the active one in `main.ts` (Tauri-first, unavailable fallback for web).
- [ ] `file-browser.service.ts` (path/crumbs/enter/goUp/openPicker + book building).
- [ ] `tauri-file-asset.service.ts` (object URL cache + revoke); extend `displayUrlFor` with the
      folder/archive branch.
- [ ] `book.model.ts`: add `folder` / `archive` `BookSource` variants.
- [ ] `file-browser.component.ts` + `bookshelf.page` mode toggle (hide `Files` when unavailable).
- [ ] `BookstoreService`: open folder/archive sources; build `pages` from logical urls.
- [ ] Keep `Library` tab 100% unchanged for web/debug and unaffected for Tauri.

## Testing

- Unit: `FileBrowserService` path/crumb/enter/goUp logic and book detection; `TauriFsBrowser`
  invoke mapping with a mocked global; `displayUrlFor` folder/archive branch returns the cached
  object URL and falls back to the original for the preset.
- Manual: `npx tauri dev` → `Files` tab → pick a folder → descend/ascend via breadcrumbs → open a
  folder-of-images and a CBZ/CBR/7Z → flip pages (60fps, 2× cap) → enhancement still applies via
  `displayUrlFor` → close book and confirm object URLs are revoked. Web `npm start`: `Files` tab
  absent, Library unchanged.

## Acceptance

- From the shelf you can open a native folder picker and browse anywhere on the local disk.
- Folders of images and CBZ/CBR/7Z archives open in the existing reader; pages resolve through
  `displayUrlFor`; filters and scan-enhancement still work unchanged.
- The debug web build shows no `Files` tab and the Library behaves exactly as before.
- Originals are never written to; served object URLs are revoked on book close.
- `npm run build` and `npm run lint` stay clean; no new UI kit or premature NgRx.
