# AGENTS.md — Emaki

Guidance for AI coding agents and contributors working on this repo.

## Project

**Emaki** — cross-platform book/comic reader. Initially mobile (Android first), eventually desktop. Inspired by Perfect Viewer; ships EPUB, images, archives (CBZ/CBR/7Z), with PDF/DJVU later via plugins.

## Stack

| Layer            | Choice                                                              |
| ---------------- | ------------------------------------------------------------------- |
| UI framework     | Angular 20 (standalone components, signals) + Ionic 8 (Angular SDK) |
| Native runtime   | Capacitor 8                                                         |
| Local DB         | Dexie (IndexedDB; native SQLite via `capacitor-sqlite` if needed)   |
| State            | Angular signals (no NgRx unless complexity demands it)              |
| Formats          | `pdfjs-dist` (PDF), `epub.js` (EPUB), `unzipit` (CBZ/ZIP), `libunrar.js` (CBR), `7z-wasm` (7z) |
| Image rendering  | v1: `OffscreenCanvas` + WebGL Lanczos. v2: native Capacitor plugin wrapping `BitmapRegionDecoder` / `ImageDecoder` / `CGImageSource` |
| Network sources  | `smb2`/`@marsaud/smb2` (SMB), `jsftp`, `ssh2-sftp-client`, OPDS = HTTP + Atom |
| Cloud            | Official REST APIs + Capacitor `Browser` for OAuth                  |
| Desktop (later)  | Tauri 2 (preferred) or Electron; reuse Angular shell                |

## Repo layout

```
emaki/
├── src/
│   ├── app/
│   │   ├── core/           # singletons: services, guards, interceptors
│   │   ├── features/       # route-level pages (bookshelf, reader, settings)
│   │   ├── shared/         # presentational components, directives, pipes
│   │   └── app.routes.ts
│   ├── assets/
│   ├── environments/
│   └── theme/              # Ionic SCSS overrides
├── android/                # Capacitor Android project (gitignored, generated)
├── ios/                    # Capacitor iOS project (gitignored, generated)
├── capacitor.config.ts
└── package.json
```

New pages go in `src/app/features/<name>/` with sub-`.routes.ts`. Feature-local components stay co-located; cross-feature shared bits move to `shared/`.

## Commands

```bash
npm start              # ng serve (web dev server, port 4200)
npm run build          # production build → www/
npm run watch          # dev build, watch mode
npm test               # ng test (Karma + Jasmine)
npm run lint           # ng lint
npx cap sync            # copy www/ + plugin changes into native projects
npx cap open android    # open Android Studio
npx cap open ios        # open Xcode
```

Always run `npx cap sync` after any change to `www/` output or `capacitor.config.ts`.

## Conventions

- **Standalone components only.** No NgModules unless wrapping a third-party library that requires it.
- **Signals for local state.** `signal()`, `computed()`, `effect()`. No `BehaviorSubject` for UI state.
- **`inject()` over constructor DI.**
- **Templates**: control flow via `@if` / `@for` / `@switch` (Angular 17+ built-ins). No `*ngIf`, `*ngFor`.
- **Files**: `kebab-case.ts` for filenames, `PascalCase` for classes, one top-level export per file when practical.
- **Strict TS**: `strict: true` is on. Don't loosen it.
- **Styling**: prefer Ionic's CSS variables and Shadow Parts (`::part(...)`) over deep selectors. SCSS per component.
- **No new dependencies without justification.** If you must add one, justify in the PR.

## Native / Capacitor rules

- **Android 11+ scoped storage** is a hard requirement. Use `@capacitor-community/saf` for user-picked folder access; never assume raw filesystem paths.
- All native plugins are accessed through typed wrappers in `src/app/core/native/`. Do not call `Plugins.X` from feature code directly.
- iOS background downloads, file picker, and document browser go through Capacitor plugins — no direct UIDocumentPickerViewController calls without a wrapper.
- The **reader view itself must run inside a native plugin host**, not an Ionic page, once we ship v2 of the image renderer. v1 ships in Ionic to validate the UX.

## Performance rules

- Never decode a full hi-res page in main memory. v1 caps decoded width at 2× display width.
- Pinch/pan in the reader must hold 60fps. Use `requestAnimationFrame`, `OffscreenCanvas` + a Web Worker for decode.
- Page cache: LRU of 5 pages (prev/current/next + neighbors). Evict aggressively.
- No `<img>` for page content in the reader — `<canvas>` only.

## Testing

- Unit tests co-located: `foo.ts` → `foo.spec.ts`.
- One observable contract per test. Cover boundaries, transitions, errors; skip plumbing.
- Smoke test any UI change in a real device or emulator before claiming "done" — Karma tests don't catch gesture regressions.

## Things to avoid

- Adding Tailwind, Sass mixin libraries, or UI kits on top of Ionic. Use what Ionic gives you.
- Reaching for NgRx prematurely. Signals + services cover ~90% of cases.
- Wrapping every third-party JS lib in a wrapper before we know we need to. `pdfjs-dist`, `epub.js`, `unzipit` are fine to call directly from feature code in v1; promote to a service once a second feature needs them.
- Touching `android/` or `ios/` by hand for anything not plugin-related — these are generated by `cap sync`.

## Scope discipline

- v1 = local files + bookshelf + image/comic viewer (paginated + vertical) + EPUB + bookmarks. Stop there.
- SMB/SFTP/OPDS/cloud/PDF/DJVU/colorization/Chromecast are deferred. Don't sneak them in.

## Definition of done

- Feature builds cleanly (`npm run build`) and lints clean (`npm run lint`).
- Smoke-tested on a real Android device or emulator via `npx cap run android`.
- No new TODOs left in shipped code. Stubs are not "done" — say so or finish them.