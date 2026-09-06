# Library folder scan — pick a root, then scan to build a book/chapter tree

## Context

The shelf today is either a preset manifest or an ad-hoc file browser you roam manually. You want the
model of a real reader app:

> **Pick one folder (the library root) → Scan it → its contents become a browsable book/chapter tree on the shelf.**

The file browser's only remaining job is *choosing the root*. There is no ad-hoc roaming. Scanning
recurses the root and builds the same `FsFolder` tree the shelf already navigates, so the existing
discover → scan → register pipeline and the fs-path resolver all reuse cleanly.

We already have the pieces:
- Tauri fs commands: `pick_directory`, `list_directory`, `read_file`, `open_archive` (`lib.rs`).
- `FilePageService` / `ScanEnhancementService.displayUrlFor` resolve a real fs path or extracted
  archive path into a drawable URL for the reader and canvas.
- `ScannerService` + `ShelfService` already discover/scan/register and show covers.
- A `PreferencesService` can persist the chosen root.
- The folder/archive → `Book` builder already exists in `FileBrowserService`.

## The tree model (from your answers)

- **Single root**, persisted via Preferences. Re-pick replaces it; a "Clear library" forgets it.
- **Pick sets the root; you press Scan manually** to build the books. Scan always re-scans the
  current root (no need to re-pick), so newly added folders are picked up on the next Scan.
- **Recursion is shallow / one level deep for books:**
  - A **book** = a folder that directly contains readable images. Clicking it **opens the reader**.
  - A folder that contains *subfolders* (rather than images) is a **series** — clicking it
    **navigates into** the series to reveal its books. (We descend one level to reach books; deeper
    nesting is not flattened.)
  - Archives (CBZ/zip): **deferred / out of scope for now** — only folders of images are books. The
    Rust `open_archive` command stays available but the scanner ignores archives for the moment.
- **Covers:** show a folder icon until scanned, then the real first-page thumbnail (resolved through
  the existing resolver).

## Decisions

- **D1 Single root** (persisted). Multi-root is a later extension.
- **D2 Manual Scan** after pick.
- **D3 Remove the roaming UI** (`FileBrowserComponent` + `browsing` toggle); `openFolder()` only sets
  the root and triggers discover + scan.
- **D4 Recursion:** a folder holding images directly is a **book** (openable, opens the reader). A
  folder holding subfolders is a **series** (navigable). Descend one level to reach books; do not
  flatten deeper nesting. Archives are ignored for now.
- **D5 Covers:** folder icon pre-scan; post-scan the first page is resolved via `FilePageService`
  (the `convertFileSrc` fast path when present, blob fallback otherwise — only the cover image is
  preloaded, not every page).

## Implementation base

- **`LibraryRootService`** (Preferences): `root: string | null`, `setRoot`, `clear`, persisted.
  Web/debug keeps the preset (or none).
- **`FileSystemLibraryScanner implements LibraryScannerPort`**:
  - `discover()` reads the configured root via `list_directory`, builds an `FsFolder` tree
    recursively (cap recursion depth to avoid runaway). Leaf folders with images get `isBook = true`
    and `imageUrls` = the image paths (raw fs paths). Folders with subfolders are navigable
    (`isBook = false`). Archives are leaves.
  - `scan()` walks the tree and, for every leaf book (chapter), registers a `Book` on `ShelfService`
    with `pages` = its images (and `coverUrl = imageUrls[0]`), so covers + open-by-id work.
  - Ids are path-based and prefixed (e.g. `fs:<rootHash>:<chapterPath>`) so the shelf can tell fs
    books from preset ones and resolve their covers through `FilePageService`.
- **Provider wiring:** on Tauri, `LIBRARY_SCANNER` → `FileSystemLibraryScanner` (reads root from
  `LibraryRootService`); on web, keep `AssetsPresetScanner`.
- **`BookshelfPage`**:
  - `openFolder()` → pick → `rootService.setRoot(path)` → `scanner.discover()` → `scanner.scan()`.
  - `onTileClick` gains fs behavior: if the node has child folders → `navigate` (into chapters);
    else if it is a scanned leaf book → `bookstore.openBook` (build from `imageUrls`). This reuses
    the existing `currentPath`/children navigation for descending book → chapters.
  - `Scan` with no root set prompts for a folder first.
  - `coverFor(child)` resolves an fs cover through `FilePageService` (tracks its `revision` so the
    cover re-renders once the blob/asset URL is ready).
- **Book opening** reuses the existing folder/archive `Book` builder (extract to a shared helper;
  delete `FileBrowserService`/`FileBrowserComponent`).
- **Empty / no-root state** copy: "Tap **Open folder** to choose your library", and `Scan` with no
  root triggers `openFolder()`.

## Work (checklist)

- [ ] `LibraryRootService` (Preferences) + provider.
- [ ] `FileSystemLibraryScanner` (discover + scan/register image-folder books) via Tauri fs commands.
- [ ] Wire `LIBRARY_SCANNER` per platform; keep preset fallback for web.
- [ ] `BookshelfPage`: `openFolder()` sets root + scans; `onTileClick` navigates books / opens chapters;
      `Scan` prompts for root; empty-state copy.
- [ ] Cover resolution for fs paths via `FilePageService` in the shelf.
- [ ] Remove `FileBrowserComponent` + `browsing` toggle; extract shared folder/archive → `Book` builder.
- [ ] `npm run build` + `npm run lint` clean; verify pick → scan → book → chapter → reader on `tauri dev`.

## Resolved

- Book = folder of images; folder with subfolders = series (navigate, one level). (Can revisit later.)
- Scan re-runs on the current root; no re-pick needed to pick up new folders.
- CBZ/archive handling deferred — folders of images only for now.
