# Model weights

Place bundled ncnn model weights here. **Do not commit large binaries**; fetch
them at build time from tumuyan/RealSR-NCNN-Android's `assets.zip` (or
`huggingface.co/tumuyan2/realsr-models`). The folder names below are matched
**exactly** by `plugin_bridge.cpp`'s `resolveModelPaths`, so keep them verbatim.

```
models-Real-ESRGANv2-anime/   # default 2× net (also ships x4)
  x2.bin
  x2.param
  x4.bin
  x4.param
models-Real-ESRGAN/          # generic 4× fallback
  x4.bin
  x4.param
```

The CMake `POST_BUILD` step copies these folders into the native library dir, so
at runtime the bridge resolves e.g.
`<nativeLibDir>/models-Real-ESRGANv2-anime/x2.param`.

**Do NOT add MangaJaNai / AnimeJaNai weights here** — they are CC-BY-NC-SA-4.0
(non-commercial) and must not be redistributed in the app.
