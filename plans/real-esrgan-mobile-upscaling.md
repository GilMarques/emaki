# Real-ESRGAN mobile scan enhancement plan

## Goal

Add an opt-in, fully local AI enhancement feature to OpenViewer. When a book is open and the user enables enhancement, pages remain readable immediately from their original sources while enhanced page derivatives are generated progressively on the device.

The first implementation targets Android through a tracked Capacitor native plugin and keeps the native boundary suitable for iOS. Use the official Real-ESRGAN models through a mobile inference implementation; do not embed Python, PyTorch, or a network service in the app.

## Repository constraints and current integration points

- App: Angular 20 + Ionic 8 + Capacitor 8; Android first, iOS later.
- `src/app/core/models/book.model.ts` currently models each page as an immutable `Page` with a source `url`.
- `BookstoreService` owns the open book and current index as Angular signals.
- `BookSpreadComponent` mounts `BookFlipService`.
- `BookFlipService` currently loads every page URL and calls the vendored page-flip library's `loadFromImages`; the public API has no image replacement method.
- `QuickActionsModalComponent` already owns the reader quick-action tabs and is the correct entry point for an enhancement toggle.
- `SettingsService` persists global display/filter settings. Do not silently add an always-on, battery-heavy global preference in the first pass; enhancement starts only after an explicit reader action.
- The current reader performance rules prohibit decoding full high-resolution pages in main memory and require a 60 fps interaction path.
- `android/` and `ios/` are generated Capacitor projects. Native implementation belongs in a tracked plugin package; do not hand-edit generated platform output.
- Existing uncommitted work on `master` is unrelated and must remain untouched. This plan is on branch `feat/upscaling` in worktree `../open-viewer-real-esrgan-plan`.

## Decisions

1. **Runtime / backend strategy:** the JavaScript service depends only on a backend-agnostic `ScanEnhancementBackend` interface (`getCapabilities` / `enhancePage` / `cancelPage`). Concrete backends are swappable adapters selected at runtime by a `RealEsrganPluginService` registry, so no feature code is tied to one runtime. Primary shipping target is **desktop (Tauri 2) using ONNX Runtime** (Vulkan/CoreML/CPU) with the Real-ESRGAN Compact ONNX models. The **debug web app** gets an in-browser **WebGPU backend (`onnxruntime-web`)** so the pipeline is exercisable without a native toolchain. The **Android ncnn Capacitor plugin** (RealSR-NCNN-Android) is a future mobile adapter, not the first deliverable. Keep the viewer independent of any single backend so Core ML / other runtimes can be added later.
2. **Initial model:** ship one official, conservative model first, chosen for OpenViewer's comic/book content. Default to `Real-ESRGANv2-anime x2` (native 2x ncnn, small, line-art/manga tuned) as the primary enhancement path; keep `realesrnet-x4plus` / `realesrgan-x4plus` as a generic photo/illustration fallback. Native 2x models are available, so implement 2x directly rather than x4 + downscale. Expose the adapter's model identifier so additional models can be evaluated later. Do not bundle multiple large weights until size, thermal behavior, and redistribution terms are verified. Explicitly exclude MangaJaNai / AnimeJaNai weights: they are CC-BY-NC-SA-4.0 (non-commercial) and may not be redistributed in the app; the adapter stays model-agnostic so a user can supply NC-licensed weights themselves.
3. **Scale:** default to 2x output using the native 2x ncnn model. Keep 4x available via the x4 model for the photo/illustration fallback, offered only after device benchmarks. Never repeatedly upscale a derivative.
4. **Processing:** one page at a time, tile-based, cancellable, resumable, and never on the UI thread. Start with the visible page and its neighbors, then process the rest of the book.
5. **Data safety:** originals are immutable. Enhanced output is a separate local derivative. The reader falls back to the original page whenever enhancement is unavailable or fails.
6. **Refresh strategy:** because page-flip exposes `loadFromImages` but no image-source mutation API, add a source-revision refresh path in `BookFlipService`/`BookSpreadComponent`. Coalesce completed pages and refresh only at a safe idle/read state while preserving the logical current index. Do not modify the vendored page-flip library in the first pass.

## Implementation phases

### Phase 1 — Native plugin and model contract

**Files / areas**

- New tracked native plugin package, for example `native/real-esrgan/`.
- New Angular wrapper under `src/app/core/native/real-esrgan.plugin.ts`.
- `package.json` and Capacitor plugin registration as required by the chosen local plugin layout.
- `.gitignore` changes only if needed to keep the tracked plugin source while continuing to ignore generated Capacitor output.

**Implementation base**

Build the native plugin on top of [tumuyan/RealSR-NCNN-Android](https://github.com/tumuyan/RealSR-NCNN-Android)'s `RealSR` module, which is nihui's `realsr-ncnn-vulkan` with Real-ESRGAN support already integrated (`RealSR-NCNN-Android-CLI/RealSR/src/main/jni/realsr.{h,cpp}` and the Vulkan compute shaders `realsr_preproc/postproc*.comp.hex.h`). This is a proven Android ncnn/Vulkan path (also used by Hentoid's AI_Upscale) and avoids writing the inference layer from scratch.

- Fork only the `RealSR` module's JNI sources; do **not** pull the whole multi-engine app (Anime4k, RealCUGAN, MNN, SRMD, waifu2x, etc.).
- Replace the CLI `main.cpp` executable with a JNI wrapper exposing `getCapabilities()`, `enhancePage()`, and `cancelPage()`. Change the CMake target from `add_executable` to `add_library(... SHARED)` and register a Capacitor Android plugin (`@Plugin` + `@NativeMethod`).
- Reuse the prebuilt Vulkan ncnn from `3rdparty/ncnn-android-vulkan-shared` (`libncnn.so`) and the module's existing OpenCV / libwebp / stb image IO.
- The repo's `RealSR::process()` tile loop has **no cancellation flag**; add a `std::atomic<bool>` checked between tiles and surfaced through `cancelPage(jobId)` so an in-flight page is abandoned and no partial output is published as complete.
- Keep the bridge URI-based: the Java plugin layer resolves a content/SAF URI to a file path and passes it to native. The source is only read and output is written to a separate derivative path, keeping originals immutable.
- Bundle model weights under `src/main/assets/models-realesrgan/` with a checksum and version, reusing the repo's `x2.bin`/`x2.param` + `x4.bin`/`x4.param` asset layout. Default model = `Real-ESRGANv2-anime x2`; `Real-ESRGAN x4` ships as the generic fallback.

**JavaScript abstraction (shared by every backend).** `core/native/scan-enhancement-backend.ts` defines `ScanEnhancementBackend` + the `SCAN_ENHANCEMENT_BACKENDS` multi-token. `RealEsrganPluginService` is a selector that merges built-in defaults (Capacitor adapter + web fallback) with any registered adapters and picks the first available. Adapters implemented so far: `CapacitorRealEsrganBackend` (the Android ncnn plugin above) and `WebFallbackBackend` (always unavailable — the slot for the future WebGPU/onnxruntime-web and Tauri/ORT adapters). Adding a desktop or in-browser backend is a new adapter file + a `multi: true` provider; the service and UI are untouched.

**Work**

- Add a typed Capacitor API with methods equivalent to:
  - `getCapabilities()` — available backend, model versions, maximum supported dimensions, and whether processing is available.
  - `enhancePage({ sourceUri, destinationUri, scale, model, tileSize, denoise })` — process one local page and return output metadata.
  - `cancelPage({ jobId })` — cancel the current native operation.
- Keep the bridge URI-based. It must work with local app files and user-selected SAF-backed files without assuming a raw filesystem path.
- Bundle or install the model locally as an app/native asset with a checksum and version. No page or model data may be uploaded.
- Implement Android first with ncnn and CPU fallback; use Vulkan only when the device reports a usable backend.
- Add the iOS plugin registration boundary without claiming iOS acceleration until an actual iOS implementation is benchmarked. The API must report unavailable rather than silently falling back to a remote path.
- Make native failures typed and actionable: unsupported format, insufficient storage, out of memory, cancellation, invalid source, and model unavailable.

**Acceptance**

- A native smoke harness can process one local JPEG/PNG page entirely offline and write a valid output file.
- The bridge returns deterministic metadata and a stable error shape.
- Cancellation stops work and does not publish a partial output as complete.
- Android builds do not require Python, PyTorch, CUDA, or network access at inference time.

### Phase 2 — Local derivative storage and queue

**Files / areas**

- `src/app/core/models/book.model.ts` only if a new persisted derivative type is needed; keep source `Page.url` unchanged.
- New `src/app/core/models/scan-enhancement.model.ts`.
- New `src/app/core/services/scan-enhancement.service.ts`.
- New `src/app/core/services/page-asset.service.ts` or equivalent local asset/cache service.
- `src/app/core/native/real-esrgan.plugin.ts`.

**Work**

- Define enhancement settings: enabled, model, scale, denoise strength, and output quality. Keep the initial UI to enabled plus a conservative default; expose advanced values only after benchmarking.
- Define per-book/per-page status: `pending`, `queued`, `processing`, `complete`, `paused`, `cancelled`, and `error`.
- Key cache entries by book identity, page index, source identity/hash, model version, and settings. A source or model change must invalidate the derivative.
- Store enhanced files in app-owned persistent storage using `@capacitor/filesystem` or the established native storage path. Keep temporary tiles in cache storage and remove them after completion.
- Process one page at a time. Bound decoded dimensions and tile size before handing work to native code.
- Queue priority:
  1. current page;
  2. next and previous pages;
  3. pages adjacent to the visible window;
  4. remaining pages in reading order.
- Deduplicate queued work and persist completion after every page so an interrupted book resumes without restarting.
- On book close, book switch, disable, or source change, cancel or invalidate in-flight work. Completion from an old book must never update the new book.
- Expose signal-based queue state for progress, current page, errors, pause/resume, and cancellation.

**Acceptance**

- Enabling enhancement for an open book creates queued work without blocking book navigation.
- Reopening the same book reuses valid derivatives and does not re-run the model.
- A changed source, model, or setting creates a new cache key.
- Queue state survives process interruption at page boundaries.
- Originals remain byte-for-byte untouched.

### Phase 3 — Reader integration and progressive replacement

**Files / areas**

- `src/app/features/viewer/quick-actions-modal.component.ts`.
- New `src/app/features/viewer/enhancement-settings.component.ts`.
- `src/app/features/viewer/viewer.page.ts` and `.html`.
- `src/app/features/viewer/book-spread.component.ts`.
- `src/app/core/services/bookstore.service.ts`.
- `src/app/core/services/book-flip.service.ts`.
- `src/app/core/models/book.model.ts` only if a display-source type is required.

**Work**

- Add an `Enhance scans` quick-action section with an explicit enable/disable control, progress, pause/resume, and a link to enhancement settings.
- Keep the original page visible immediately after book load. Show a subtle per-page state such as `Original`, `Enhancing`, or `Enhanced`; do not put a blocking spinner over the reader.
- Introduce a display-source mapping separate from the immutable source URL. `BookFlipService` should resolve `enhancedUrl ?? originalUrl` when building rendered pages.
- When derivatives complete, notify the reader through a revision signal. Coalesce multiple completions, defer refresh during an active fold/flip gesture, preserve the logical page index, and avoid stale callbacks.
- For the first implementation, refresh the page-flip image list only when safe. Measure the cost of its current all-page load before considering a vendor extension for per-page replacement.
- Ensure magnifier and page-size calculations use the currently displayed asset's natural dimensions while preserving the original fallback path.
- Disable or pause enhancement when the user leaves the book, switches books, or explicitly turns the feature off.

**Acceptance**

- The feature can be enabled only when a book is open.
- Current and nearby pages visibly switch to enhanced derivatives as they complete without navigating to the wrong page or losing the current index.
- Rapid page turns, close/reopen, and book switching do not display a derivative from another page or book.
- Disabling enhancement immediately falls back to original sources and stops new work.
- Reader gestures remain responsive while enhancement runs.

### Phase 4 — Lifecycle, battery, and storage policy

**Files / areas**

- `src/app/core/services/scan-enhancement.service.ts`.
- Native plugin package and platform adapters.
- `src/app/features/viewer/enhancement-settings.component.ts`.
- `src/app/features/preferences/` only if durable preferences are added after the first pass.

**Work**

- Foreground behavior: start the prioritized queue as soon as the user enables the feature.
- Android: use a foreground/native worker while active and WorkManager-compatible resumption for deferred work. Respect cancellation and low-battery constraints.
- iOS: add resumable page-boundary processing through the platform background-processing mechanism when the iOS adapter exists; treat execution as interruptible and best effort.
- Pause on thermal throttling, low battery, memory pressure, or user request. Resume without losing completed pages.
- Add a storage budget and derivative cleanup policy. Never delete originals; evict only reproducible derivatives and report when storage prevents completion.
- Keep full-resolution processing out of the reader's main memory. Thumbnails/previews may be generated separately from full-resolution export derivatives.

**Acceptance**

- A long book can be interrupted and resumed without corruption.
- Processing pauses under configured battery/thermal/memory conditions.
- Storage pressure produces an explicit status instead of silently discarding originals or partial results.
- The reader remains usable while background processing is active.

### Phase 5 — Verification and model promotion

**Files / areas**

- Co-located unit tests for each new service/model/wrapper.
- Native plugin tests and a small offline fixture set kept out of production assets where appropriate.
- Existing viewer smoke-test path.

**Work**

- Test queue ordering, deduplication, cache invalidation, cancellation, resume, stale completion rejection, and fallback behavior.
- Test model output dimensions, output-file validity, and preservation of the original source.
- Benchmark representative low-, mid-, and high-tier Android devices with portrait pages, landscape pages, large pages, noisy scans, and already-sharp scans.
- Measure first enhanced-page latency, pages/minute, peak memory, output storage, battery/thermal behavior, and UI frame stability.
- Compare `realesrnet-x4plus` with `realesrgan-x4plus` on text-heavy pages and photographs. Promote the sharper GAN model only if it does not materially alter text and the device cost is acceptable.
- Validate Android emulator/device behavior through the actual Capacitor app. Add iOS verification only after the native adapter exists.
- Review upstream code, model weights, ncnn, and bundled dependency licenses before distribution. Repository code license and model-weight redistribution terms must both be recorded. Any NC/non-commercial weight (e.g. MangaJaNai, AnimeJaNai, CC-BY-NC-SA-4.0) must fail the redistribution check and never be bundled.

**Acceptance**

- Unit tests fail for each identified queue/cache/lifecycle regression.
- Offline native smoke processing succeeds on the supported Android device range.
- Visual comparison confirms that text-heavy pages retain character shapes and that the original remains available.
- No claim of iOS support is made until an iOS device has exercised the native path.

## Explicit non-goals for the first release

- Cloud enhancement, remote inference, or automatic page upload.
- Python/PyTorch execution inside the mobile app.
- Always-on enhancement for every book without an explicit user action.
- Replacing or deleting original pages.
- Large transformer/GAN model bundles before mobile benchmarks.
- OCR rewriting or “correction” of page pixels.
- Editing generated `android/` or `ios/` output directly.

## Source references

- [Real-ESRGAN official repository](https://github.com/xinntao/Real-ESRGAN)
- [Real-ESRGAN model zoo](https://github.com/xinntao/Real-ESRGAN/blob/master/docs/model_zoo.md)
- [Real-ESRGAN ncnn/Vulkan implementation](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan)
- [Tencent ncnn](https://github.com/Tencent/ncnn)
- [ONNX Runtime execution providers](https://onnxruntime.ai/docs/execution-providers/)
- [Apple Core ML](https://developer.apple.com/documentation/coreml)
- [Google LiteRT](https://developers.google.com/edge/litert)
- [Android WorkManager](https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started)
- [Apple BGProcessingTask](https://developer.apple.com/documentation/backgroundtasks/bgprocessingtask)
