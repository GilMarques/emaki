# Real-ESRGAN native plugin (OpenViewer)

Capacitor plugin that performs **fully local** AI upscaling of book/comic pages
on Android using ncnn (Vulkan + CPU fallback). It reuses
[tumuyan/RealSR-NCNN-Android](https://github.com/tumuyan/RealSR-NCNN-Android)'s
`RealSR` module — nihui's `realsr-ncnn-vulkan` with **Real-ESRGAN support**
already integrated.

> **Status (2026-08-29): bridge written, NOT yet built/verified on a device.**
> The JNI layer (`plugin_bridge.cpp`), the Java plugin (`RealEsrganPlugin.java`),
> and the CMake glue are in place. What remains is to **vendor the ncnn engine +
> weights** (steps below) and compile with the Android NDK. No device build is
> possible in the desktop dev environment, so treat the integration notes as the
> authoritative checklist to run on a real machine with Android Studio + NDK.

## Why RealSR-NCNN-Android

- Proven Android ncnn/Vulkan path; the same `RealSR` class also powers Hentoid's
  `AI_Upscale`. We are **not** writing the inference layer from scratch.
- Bundles **native 2× ncnn models** (`models-Real-ESRGANv2-anime/x2.bin`+`x2.param`)
  — so OpenViewer uses 2× directly instead of upscaling x4 and downscaling.
- Models ship as plain ncnn `.bin`/`.param`; no Python/PyTorch at runtime.

## Default model

The 2× net (`Real-ESRGANv2-anime`) is the **default** on mobile, matching the
desktop (Tauri/ONNX) default. `nativeGetCapabilities` reports
`["realesrgan-v2-anime-x2","realesrgan-x4"]` (2× first); the TS layer snaps its
selection to the first bundled model, so 2× is chosen out of the box. The reader's
enhancement sheet (quick-actions → "Enhance scans") lets the user switch to 4×.

## What the bridge does (already implemented)

- `nativeGetCapabilities` — reports `available`/`backend` (`vulkan` if
  `ncnn::get_gpu_count() > 0`, else `cpu`) and the two model ids.
- `nativeEnhancePage` — resolves model + source + destination paths, decodes the
  source with **stb**, runs `RealSR::process`, encodes the upscaled PNG with
  **stb_image_write**, and returns a result JSON. Vulkan is used when present
  (`gpuid = 0`); the old CPU-only `gpuid = -1` is gone.
- `nativeCancelPage` — sets a per-job `std::atomic<bool>` so an in-flight page is
  abandoned (coarse: checked before/after the page; see "Cancellation" below for
  the finer-grained between-tile edit).
- Java `RealEsrganPlugin` — copies `content://` (scoped-storage) source URIs to the
  app cache so ncnn can open them, and maps the `enhanced/<hash>.png` destination
  to `<cache>/enhanced/<hash>.png`.

## Vendoring (build prerequisite)

You need the ncnn engine sources + the RealSR module + the model weights. The
fastest correct path is to use tumuyan's prebuilt **`assets.zip`** from the
[release page](https://github.com/tumuyan/RealSR-NCNN-Android/releases) (it
contains `libncnn.so`, `libomp.so`, `libc++_shared.so`, the `realsr-ncnn` ELF, and
the model folders), then adapt it to a *shared library* (we need `libreal_esrgan.so`,
not the CLI ELF).

### 1. ncnn + Vulkan loader
Copy from `ncnn-android-vulkan-shared` (or the `assets.zip` `realsr/` folder) into
`android/src/main/jniLibs/<abi>/` (we target `arm64-v8a` per `build.gradle`):
- `libncnn.so`
- `libvulkan.so` (Vulkan loader; the system also provides one, but shipping it is
  safest on older devices)
- `libomp.so` (OpenMP)
- `libc++_shared.so` (C++ runtime)

### 2. RealSR module (the inference code)
From `RealSR-NCNN-Android-CLI/RealSR/src/main/jni/`, copy into
`android/src/main/jni/`:
- `realsr.h`, `realsr.cpp`
- `realsr_preproc.comp.hex.h`, `realsr_postproc.comp.hex.h`
- `realsr_preproc_tta.comp.hex.h`, `realsr_postproc_tta.comp.hex.h`

`plugin_bridge.cpp` already `#include "realsr.h"` and calls `RealSR(gpuid, tta,
threads)` → `load(param, bin)` → `process(in, out)`. Keep `realsr.cpp` as-is
(its `main()` is unused; we only need the class + compute shaders).

### 3. stb (image decode/encode)
Drop `stb_image.h` and `stb_image_write.h` (from
[nothings/stb](https://github.com/nothings/stb)) into `android/src/main/jni/`.
`plugin_bridge.cpp` `#define`s the implementations and includes them; the jni dir
is already on the include path.

### 4. Model weights (matches upstream folder names exactly)
Create `android/src/main/assets/models-realesrgan/` with these folders (names
**must** match — the bridge resolves `models-Real-ESRGAN` and
`models-Real-ESRGANv2-anime`):
```
models-realesrgan/
├─ models-Real-ESRGAN/
│   ├─ x4.bin
│   └─ x4.param
└─ models-Real-ESRGANv2-anime/
    ├─ x2.bin
    ├─ x2.param
    ├─ x4.bin
    └─ x4.param
```
Pull `x4.bin/x4.param` and `models-Real-ESRGANv2-anime/x2.bin/x2.param` (and the
optional `x4`) from tumuyan's `assets.zip` (or `huggingface.co/tumuyan2/realsr-models`).
**Do not** bundle MangaJaNai/AnimeJaNai weights (CC-BY-NC-SA-4.0, non-commercial).
The CMake `POST_BUILD` step copies these folders into the native library dir so the
bridge finds `<nativeLibDir>/models-Real-ESRGANv2-anime/x2.param` at runtime.

## Build

```
cd native/real-esrgan/android && ./gradlew assembleRelease
npx cap sync android
npx cap open android        # build + run on a device/emulator (needs NDK r25+)
```

`build.gradle` sets `minSdk 24`, `abiFilters "arm64-v8a"`, `ndkVersion "29.x"`.
CMake (`jni/CMakeLists.txt`) builds `libreal_esrgan.so` and copies the model
folders next to it. After `cap sync`, the JS layer picks the `capacitor` backend
automatically (`CapacitorRealEsrganBackend.isAvailable()` checks for the
`RealEsrgan` plugin).

## Remaining integration gaps to verify on a device

These are the "missing pieces" — none are in the engine, but they sit on the
TS ↔ native boundary and could not be exercised without a device:

1. **FileSystem round-trip.** On native, `PageAssetService.buildDestinationUri`
   returns `enhanced/<hash>.png`; the Java layer maps that to
   `<cache>/enhanced/<hash>.png` and the native result returns the **absolute**
   path. The reader resolves it via `FilePageService.displayUrl` →
   `FILE_SYSTEM_BROWSER.readFile`. Today `FILE_SYSTEM_BROWSER` is the **Tauri**
   implementation; on Capacitor there is no native FS port wired yet, so the
   enhanced blob URL may not resolve. Action: provide a Capacitor
   `FileSystemBrowser` (or have the plugin expose the bytes / use the Capacitor
   `Filesystem`/`asset` protocol) and confirm `readFile` accepts the absolute
   cache path the plugin returns.
2. **Source URIs.** Folder-of-images books on Android arrive as `content://`
   (SAF). `resolveSourcePath` copies them to cache — verified logic, but untested
   against a real picker. Confirm the copied bytes decode (stb) for the formats
   your library produces (jpg/png/webp).
3. **Pixel format.** `plugin_bridge.cpp` feeds `RealSR::process` an `ncnn::Mat`
   built with `PIXEL_RGB` from stb. Real-ESRGAN ncnn expects RGB input, so this is
   correct; if output looks color-inverted on first device test, switch to
   `PIXEL_BGR` (and the matching `to_pixels` call).
4. **Cancellation granularity.** `nativeCancelPage` sets the flag, but
   `RealSR::process` runs to completion before the flag is re-checked. For true
   mid-page cancellation, patch `realsr.cpp`'s `RealSR::process` tile loop to
   consult a `std::atomic<bool>*` (the same per-job flag passed into
   `nativeEnhancePage`): when set, `return -1` and the bridge deletes the partial
   output. This is the single "engine change" the original scaffold called out.

## License note

The bundled Real-ESRGAN ncnn weights are Apache-2.0-friendly (xinntao/Tencent).
ncnn is BSD-3-Clause; stb is MIT/Public Domain. Keep the non-commercial
MangaJaNai/AnimeJaNai weights out of the shipped plugin.
