# Emaki

A fast, no-nonsense book and comic reader for mobile (and eventually desktop). Built on Angular + Ionic + Capacitor so the chrome stays web-native and the renderer can graduate to native code where it matters.

Inspired by Perfect Viewer's "does the basics, does them well" philosophy. Designed for books first, comics second.

## Features (planned)

- Local file browsing with Android 11+ scoped storage (SAF)
- Image viewer: paginated, vertical scroll (webtoon), horizontal scroll
- Smooth pinch / pan / fling with 60fps target
- LTR / RTL reading, brightness / contrast / gamma, white-border crop
- EPUB rendering
- Archive support: CBZ / ZIP, CBR, 7Z, CBT / TAR
- PDF / XPS / DJVU via plugin (later)
- Bookshelf, favorites, bookmarks, recent files
- Network sources (later): SMB / CIFS, FTP, SFTP, FTPS, OPDS
- Cloud sources (later): Google Drive, Dropbox, OneDrive
- Page cache, slideshow, Chromecast (later)

## v1 scope

Local files + bookshelf + image / comic viewer (paginated + vertical) + EPUB + bookmarks. Everything else is deferred — see `AGENTS.md` for the full scope lock.

## Stack

| Layer        | Choice                                                              |
| ------------ | ------------------------------------------------------------------- |
| UI           | Angular 20 (standalone, signals) + Ionic 8 (Angular SDK)            |
| Native       | Capacitor 8                                                         |
| Storage      | Dexie (IndexedDB); Capacitor Filesystem + `@capacitor-community/saf` |
| Formats      | `pdfjs-dist`, `epub.js`, `unzipit`, `libunrar.js`, `7z-wasm`        |
| Image engine | v1: OffscreenCanvas + WebGL Lanczos. v2: native plugin.             |
| Desktop      | Tauri 2 (later) or Electron                                          |

## Prerequisites

- Node.js 20+
- npm 10+
- Android Studio (for Android builds)
- Xcode (for iOS builds, macOS only)

## Getting started

```bash
# Install deps
npm install

# Run in the browser (dev server at http://localhost:4200)
npm start

# Build for production (output in www/)
npm run build

# Sync the web build into the native projects
npx cap sync

# Open Android Studio
npx cap open android

# Open Xcode (macOS only)
npx cap open ios
```

## Scripts

| Script            | What it does                                 |
| ----------------- | -------------------------------------------- |
| `npm start`       | Dev server with hot reload                    |
| `npm run build`   | Production build to `www/`                   |
| `npm run watch`   | Dev build, watch mode                         |
| `npm test`        | Unit tests (Karma + Jasmine)                 |
| `npm run lint`    | Lint with Angular ESLint                     |

## Project layout

```
src/
├── app/
│   ├── core/        # singletons: services, guards, native plugin wrappers
│   ├── features/    # route-level pages (bookshelf, reader, settings)
│   ├── shared/      # presentational components, directives, pipes
│   └── app.routes.ts
├── assets/
├── environments/
└── theme/           # Ionic SCSS overrides
```

New features go in `src/app/features/<name>/`. Cross-feature shared bits move to `shared/`. Native plugin wrappers go in `core/native/`.

## Contributing

Read `AGENTS.md` first — it has the conventions, scope rules, and performance budget that govern this repo. tl;dr:

- Standalone components, signals for state, `inject()` over constructor DI.
- Strict TypeScript. No `*ngIf` / `*ngFor` — use `@if` / `@for`.
- v1 is local files + viewer + EPUB only. Don't sneak in network/cloud/PDF features.
- Smoke-test on a real device before claiming done.

## License

TBD.