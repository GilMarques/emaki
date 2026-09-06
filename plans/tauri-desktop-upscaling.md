# Tauri 2 desktop plan — AI scan enhancement (OpenViewer)

## Goal & scope

Ship OpenViewer as a **desktop application** using **Tauri 2**, reusing the existing
Angular 20 shell unchanged. Upscaling runs **locally in Rust via ONNX Runtime
(`ort`)**, executing Real-ESRGAN ONNX models with GPU acceleration where available
(DirectML on Windows, CUDA on Linux) and CPU fallback.

Targets: **Linux (Fedora primary) + Windows**. Support both an easy-install package
(`.rpm` on Fedora) and a **portable executable** (`.exe` on Windows, `.AppImage`
on Linux) with no installer.

This plan is the desktop companion to `real-esrgan-mobile-upscaling.md`. The
JavaScript layer is already backend-agnostic (`ScanEnhancementBackend` +
`SCAN_ENHANCEMENT_BACKENDS` token in `core/native/scan-enhancement-backend.ts`),
so this plan only adds a **`TauriRealEsrganBackend` adapter** plus the Rust
command/engine — no changes to `ScanEnhancementService`, the UI, or the queue.

## Architecture

```
Angular (src/)  ──build──▶  dist/
        │  invokes ScanEnhancementService (unchanged)
        ▼
RealEsrganPluginService (selector, unchanged)
        │  picks first available ScanEnhancementBackend
        ▼
TauriRealEsrganBackend  ──invoke('enhance_page', …)──▶  Rust command
        │                                                  │
        ▼                                                  ▼
   Tauri webview                              src-tauri: ort (ONNX Runtime)
                                            loads Real-ESRGAN .onnx, runs EP
```

- **Frontend stays the same** Angular app. Tauri serves `dist/` instead of a
  mobile WebView. `Capacitor.isNativePlatform()` is `false` inside Tauri, so the
  Capacitor adapter is unavailable and the selector falls through to the Tauri
  adapter (registered via the DI token).
- **One inference engine**: `ort` (safe Rust wrapper for ONNX Runtime 1.28,
  current `2.0.0-rc.x`). Models are standard **ONNX**, shared with the future
  web (onnxruntime-web) and Android (ncnn) paths.

## Phase 0 — Scaffold the Tauri shell (latest Tauri 2)

Add `src-tauri/` to the repo root (sibling of `src/`). Required pieces:

- `src-tauri/Cargo.toml` — `tauri` (2.x), `tauri-build`, `serde`, `tokio`, `ort`,
  `anyhow`. Set `tauri` features for the plugins we use (none required for basic
  commands; add `tauri-plugin-fs` later only if needed).
- `src-tauri/tauri.conf.json` (excerpt below). Key points verified against current
  Tauri 2 docs:
  - `frontendDist`: `"../dist/open-viewer"` (Angular output; adjust to the real
    `outputPath`).
  - `devUrl`: `"http://localhost:4200"`, `beforeDevCommand`: `"npm start"`,
    `beforeBuildCommand`: `"npm run build"`.
  - `bundle.targets`: Linux → `["deb","rpm","appimage"]`, Windows → `["nsis"]`
    (MSI needs Windows to build; see Phase 4/5).
  - `bundle.linux.rpm` / `bundle.linux.appimage` left at defaults.
  - `bundle.windows.webviewInstallMode`: `"skip"` is **not** recommended; use
    `"downloadBootstrapper"` (small, fetches WebView2 only if missing — and
    Win10/11 already have it).

```jsonc
{
  "productName": "OpenViewer",
  "identifier": "com.openviewer.app",
  "build": { "beforeDevCommand": "npm start", "beforeBuildCommand": "npm run build",
             "devUrl": "http://localhost:4200", "frontendDist": "../dist/open-viewer" },
  "app": { "windows": [{ "title": "OpenViewer", "width": 1024, "height": 768 }] },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": ["icons/icon.png"],
    "linux": { "rpm": { "epoch": 0, "release": "1" } },
    "windows": {
      "webviewInstallMode": { "type": "downloadBootstrapper" },
      "nsis": { "installMode": "perMachine" }
    }
  }
}
```

- `src-tauri/capabilities/default.json` — Tauri 2 grants all registered custom
  commands to all windows by default, so our `enhance_page` / `get_capabilities`
  / `cancel_page` need **no extra permission entries**. Only add entries if we
  later use plugins (e.g. `tauri-plugin-fs`).
- `src-tauri/build.rs` — standard `tauri_build::build()`.

Run with `npm run tauri dev` (launches Angular dev server + Tauri window).

## Phase 1 — Rust backend: commands + ONNX Runtime engine

`src-tauri/src/lib.rs` registers commands via
`tauri::generate_handler![get_capabilities, enhance_page, cancel_page]` and
manages shared state: a loaded `ort::Session` (load once, reused) and an active-job
table keyed by `job_id` holding an `Arc<AtomicBool>` cancellation flag.

```rust
#[tauri::command]
async fn get_capabilities(state: tauri::State<'_, AppState>) -> Capabilities {
    Capabilities { available: true, backend: state.backend_name(), models: state.model_ids(), max_dimension: 4096 }
}

#[tauri::command]
async fn enhance_page(source_uri: String, destination_uri: String, scale: u32, model: String,
                      tile_size: u32, denoise: u32, job_id: String,
                      state: tauri::State<'_, AppState>) -> Result<EnhanceResult, String> {
    // Resolve source → bytes (read file / app data path).
    // Tile the image, run the ort Session per tile (see Phase 2 for EP selection),
    // check state.cancelled(job_id) between tiles, write destination.
    // Return { destination_uri, width, height, model, scale }.
}

#[tauri::command]
async fn cancel_page(job_id: String, state: tauri::State<'_, AppState>) -> CancelResult {
    CancelResult { cancelled: state.cancel(job_id) }
}
```

Engine notes (verified against `ort` 2.x docs):

- `ort` default enables `download-binaries` (fetches prebuilt ONNX Runtime from
  pyke CDN at build) + `copy-dylibs` (symlinks the `.dll`/`.so` next to the
  binary so they load in dev). **For release we must bundle the ORT dylibs**
  (`libonnxruntime*.so` / `onnxruntime.dll` + EP helper dylibs) into the app
  resources and set `ORT_DYLIB_PATH` (or place them beside the exe — ORT searches
  the executable directory). Call out as an explicit packaging step.
- Enable EP features with `lax-feature-matching` so a single crate config grabs
  the closest prebuilt on each OS:
  `ort = { version = "2", features = ["directml", "coreml", "cuda", "lax-feature-matching"] }`.
  Prebuilt combos are `directml`/`coreml` (Windows/mac), `cuda`/`tensorrt`
  (Linux/Win), `webgpu`. With lax matching: Windows → DirectML build, Linux →
  CUDA build, macOS → CoreML build; CPU always available as fallback.
- Register EP at session build time and **fall back to CPU on error**:
  try `DirectML` (Windows) / `CUDA` (Linux if present) via
  `SessionBuilder::with_execution_providers`, catch, retry with `CPUExecutionProvider`.
  (WebGPU EP exists but is flagged experimental — defer it.)
- Keep the model `Session` in `AppState` (it is `Send+Sync`); per-call clone the
  session for thread-safe inference, or guard with a `Mutex`.

## Phase 2 — Model (Real-ESRGAN ONNX)

- Default model: a **BSD-3-Clause** Real-ESRGAN ONNX (the upstream
  `xinntao/Real-ESRGAN` project is BSD-3-Clause, not Apache-2.0 — both are fully
  permissive; the plan's earlier "Apache-2.0" note was incorrect). Concretely,
  `realesrgan-x4` is fetched from `qualcomm/Real-ESRGAN-x4plus`' ONNX export via
  `scripts/fetch-realesrgan-models.sh` (pinned SHA-256). Ship `x4` as the
  general default; add an `x2` variant later if needed.
  - **Fixed-input caveat (confirmed):** `real_esrgan_x4plus.onnx` accepts a
    *fixed* input `image: [1,3,128,128]` and returns `upscaled_image:
    [1,3,512,512]` (4×). The Rust engine (`src-tauri/src/engine.rs`) currently
    runs whole-image inference and will fail on this model — it MUST tile the
    source into 128×128 windows (stitch 512×512 outputs) before this is usable
    end-to-end. Track as the first task after the shell builds.
- **Exclude** MangaJaNai / AnimeJaNai ONNX — they are **CC-BY-NC-SA-4.0
  (non-commercial)** and must not be redistributed.
- Place weights in `src-tauri/resources/models/`; reference by id from the
  frontend `EnhancementModelId`. Record checksum + version.

## Phase 3 — Angular `TauriRealEsrganBackend` adapter

New file `core/native/tauri-real-esrgan.backend.ts` implementing
`ScanEnhancementBackend`. It calls Tauri's `invoke` (prefer detecting the global
`window.__TAURI__` so the web/debug build never hard-imports `@tauri-apps/api`;
optionally set `app.withGlobalTauri` or import `@tauri-apps/api/core`):

```ts
export class TauriRealEsrganBackend implements ScanEnhancementBackend {
  readonly id = 'tauri';
  isAvailable() { return typeof (window as any).__TAURI__ !== 'undefined'; }
  getCapabilities() { return invoke('get_capabilities'); }
  enhancePage(args: EnhancePageArgs) { return invoke('enhance_page', args as any); }
  cancelPage(jobId: string) { return invoke('cancel_page', { jobId }); }
}
```

Register it in `src/main.ts` so the selector prefers it:

```ts
providers: [ …, { provide: SCAN_ENHANCEMENT_BACKENDS, useClass: TauriRealEsrganBackend, multi: true } ]
```

Because `SCAN_ENHANCEMENT_BACKENDS` merges by id (injected adapters win), the
Tauri adapter is selected over the web fallback automatically when running under
Tauri — **no other app code changes**.

Derivative storage: `PageAssetService` currently falls back to an in-memory map
when `!Capacitor.isNativePlatform()`. Under Tauri that loses derivatives on
restart. Add a Tauri branch (write/read via `invoke` or `@tauri-apps/plugin-fs`
to the app data dir) — same pattern as the enhancement backend. (Phase 4 of the
mobile plan's storage policy applies unchanged.)

## Phase 4 — Packaging

### Linux (Fedora)

- Build natively on Fedora. Required system packages (Fedora names — note
  `webkit2gtk3-devel` was renamed; Tauri 2 needs the 4.1 API):
  `webkit2gtk4.1-devel`, `libappindicator-gtk3-devel`, `librsvg2-devel`,
  `patchelf`, `openssl-devel` (needed by openssl-sys via native-tls/ureq),
  `libstdc++-devel` (provides `libstdc++.so` for the final link — WebKitGTK is
  C++), plus
  `rpm-build` for `.rpm` and `fuse`/AppImage tooling (Tauri bundles `linuxdeploy`
  automatically). If a name fails to resolve, `dnf search webkit2gtk` / `dnf
  search appindicator` to find the current package.
  - **GCC 16 linker quirk (Fedora 44):** even with `libstdc++-devel`/`gcc-c++`
    installed, the `cc` linker may not search GCC's private libdir for
    `libstdc++.so`, so the final link fails with `cannot find -lstdc++`. Fix by
    pointing the linker at GCC's libdir:
    `export LIBRARY_PATH="$(dirname "$(gcc -print-file-name=libstdc++.so)")":$LIBRARY_PATH`
    (add to `~/.bashrc` to persist across shells). `cargo clean` is **not**
    required — only the final binary relinks; the dependency tree is unaffected.
- Outputs of `npm run tauri build`:
  - **`.rpm`** → native Fedora package. Install: `sudo dnf install ./openviewer-*.rpm`
    (or open in GNOME Software). Declares the webkit dependency; **easiest,
    most "native" install/open on Fedora.**
  - **`.AppImage`** → portable: `chmod +x OpenViewer.AppImage && ./OpenViewer.AppImage`.
    No install; great for "easy opening" and USB/portable use. (Still needs
    `webkit2gtk3` on the host, like most Electron/Tauri AppImages.)
- Recommend shipping **both**: `.rpm` as the primary Fedora artifact, `.AppImage`
  as the portable one.

### Windows (portable `.exe`)

- Tauri's `nsis` target produces a **setup** `-setup.exe` (installer), not a
  portable exe. For a "just the exe" build:
  - `npm run tauri build -- --no-bundle` (or `cargo tauri build --no-bundle`)
    produces `src-tauri/target/release/openviewer.exe` **plus** a `resources/`
    folder and the ORT dylibs.
  - Zip `openviewer.exe` + `resources/` + bundled `onnxruntime*.dll` → distribute
    as **`OpenViewer-portable.zip`**. Extract anywhere, double-click the exe.
  - **WebView2**: preinstalled on Windows 10/11, so no runtime download is
    needed in practice. (If targeting older/locked-down machines, switch
    `webviewInstallMode` to `offlineInstaller`/`fixedVersion` and accept the
    larger bundle.)
- MSI (`.msi`) can **only** be built on Windows (WiX). The NSIS setup exe can be
  cross-compiled, but the portable zip approach above needs no Windows build at all
  for *distribution* — only to *produce* the exe (see CI).

## Phase 5 — CI (build all targets without a Windows box locally)

Cross-compiling GUI binaries from one OS is painful; use GitHub Actions with three
runners (pattern from current Tauri docs):

- `ubuntu-latest` → build `deb`, `rpm`, `appimage`.
- `windows-latest` → build `nsis` (and the portable `--no-bundle` exe).
- `macos-latest` → (optional) `dmg` for future macOS support.

  Each job installs the right native deps (Linux: `webkit2gtk-4.1-dev`,
  `libappindicator3-dev`, `librsvg2-dev`, `libssl-dev`, `patchelf`, `rpm`); runs
`tauri build --target <triple>`; uploads the resulting installers/portable zip to
a GitHub Release. This is how you get a Windows portable `.exe` artifact without
owning a Windows machine (the runner builds it).

## Acceptance

- `npm run tauri dev` runs the full app on Fedora; enabling "Enhance scans"
  upscales the current book using ORT (GPU if available, else CPU).
- `npm run tauri build` on Fedora yields a working `.rpm` and `.AppImage`.
- A Windows portable `.exe` (zipped) opens and enhances pages on a Win10/11 box
  with no installer.
- Disabling enhancement falls back to originals; cancellation aborts the job and
  publishes no partial output.
- Models shipped are Apache-2.0 only; no NC-licensed weights bundled.

## Risks / non-goals

- `ort` is `2.0.0-rc.x` (pre-1.0) — pin a version and re-test on upgrade.
- WebGPU EP is experimental; not used for v1.
- Building the Windows artifact requires either a Windows CI runner or a Windows
  VM locally; it cannot be produced from Fedora directly (except the NSIS path,
  which still needs the Windows WebView2/CRT toolchain in practice).
- No auto-update in v1 (Tauri updater is a later add-on).
