// plugin_bridge.cpp — JNI entry points for the RealEsrgan Capacitor plugin.
//
// Bridges the Angular/TS layer to nihui's RealSR ncnn engine (vendored from
// tumuyan/RealSR-NCNN-Android, which adds Real-ESRGAN support to
// realsr-ncnn-vulkan). Image decode/encode uses stb (header-only); inference
// uses the `RealSR` class. Both source and destination are plain file paths
// resolved by the Java layer (which copies content:// URIs to the app cache
// first — see RealEsrganPlugin.java).
//
// Vendoring checklist (see README.md "Vendoring"):
//   1. realsr.h / realsr.cpp            ← from RealSR-NCNN-Android-CLI/RealSR/src/main/jni
//   2. realsr_preproc*.comp.hex.h,
//      realsr_postproc*.comp.hex.h      ← same folder
//   3. stb_image.h / stb_image_write.h  ← https://github.com/nothings/stb (drop in this jni/ dir)
//   4. ncnn prebuilt libs + Vulkan       ← ncnn-android-vulkan-shared (libncnn.so, libvulkan.so)
//   5. model weights                      ← assets/models-realesrgan/{models-Real-ESRGAN,
//                                            models-Real-ESRGANv2-anime}/x{2,4}.{param,bin}

#include <jni.h>
#include <string>
#include <unordered_map>
#include <atomic>
#include <memory>
#include <mutex>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <vector>
#include <android/log.h>

#include "realsr.h"  // vendored RealSR class
#include "cpu.h"     // ncnn::set_cpu_powersave / set_omp_num_threads
#include "gpu.h"     // ncnn::get_gpu_count

// stb image decode/encode (header-only; implementation defined once here).
#define STB_IMAGE_IMPLEMENTATION
#include "stb_image.h"
#define STB_IMAGE_WRITE_IMPLEMENTATION
#include "stb_image_write.h"

static const char* TAG = "RealEsrgan";

#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

static double nowMs() {
    return std::chrono::duration<double, std::milli>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}

// Per-job cancellation flags. Checked before/after each page so a cancel
// request abandons the in-flight page and never publishes a partial output.
// For finer-grained (between-tile) cancellation, patch realsr.cpp's
// RealSR::process loop to consult this flag — see README "Vendoring".
static std::mutex g_jobsMutex;
static std::unordered_map<std::string, std::atomic<bool>*> g_jobs;

static std::atomic<bool>* jobFlag(const std::string& jobId) {
    std::lock_guard<std::mutex> lock(g_jobsMutex);
    auto it = g_jobs.find(jobId);
    if (it != g_jobs.end()) return it->second;
    auto* flag = new std::atomic<bool>(false);
    g_jobs[jobId] = flag;
    return flag;
}

// Map a model id + scale to the ncnn param/model filenames under modelDir.
// Folder names follow RealSR-NCNN-Android's asset layout:
//   realesrgan-x4          → models-Real-ESRGAN/x4.{param,bin}
//   realesrgan-v2-anime-x2 → models-Real-ESRGANv2-anime/x2.{param,bin}  (default)
static bool resolveModelPaths(const std::string& modelDir, const std::string& model,
                              int scale, std::string& param, std::string& bin) {
    std::string folder;
    if (model == "realesrgan-x4") {
        folder = "models-Real-ESRGAN";
    } else {
        // Default: Real-ESRGANv2-anime (native 2x, also ships x4).
        folder = "models-Real-ESRGANv2-anime";
    }
    std::string base = modelDir + "/" + folder + "/x" + std::to_string(scale);
    param = base + ".param";
    bin = base + ".bin";
    return true;
}

// Tile size in source pixels. `realsr.cpp` submits and waits after EVERY tile
// when there is more than one tile per row, so a small tile turns a page into
// thousands of GPU round-trips: measured on a Dimensity 900 / Mali-G68, 32 px
// took 40 s per 1200x1800 page where 256 px took 12.6 s. Upstream's own default
// is "whole image", which is too much VRAM on a phone, so 0 means 256 here.
// Large tiles also remove the block seams that 32 px tiling leaves behind.
static const int kDefaultTileSize = 256;
static const int kMinTileSize = 32;
static const int kMaxTileSize = 512;  // 512 at 64ch fp16 ≈ 33 MB per GPU blob

static int resolveTileSize(int requested) {
    if (requested <= 0) return kDefaultTileSize;
    if (requested < kMinTileSize) return kMinTileSize;
    if (requested > kMaxTileSize) return kMaxTileSize;
    return requested;
}

// One engine for the whole process. Constructing RealSR compiles the Vulkan
// pre/post pipelines and net.load() reads + uploads the weights — about 0.85 s
// per page, every page, if rebuilt. Pages are processed one at a time, so keep
// the instance alive and rebuild only when the model or GPU changes. The mutex
// doubles as the GPU lock: a second concurrent enhancePage call waits.
static std::mutex g_engineMutex;
static std::unique_ptr<RealSR> g_engine;
static std::string g_engineKey;

static RealSR* acquireEngine(const std::string& param, const std::string& bin,
                             int gpuid, int threads) {
    const std::string key = param + "|" + std::to_string(gpuid);
    if (g_engine && g_engineKey == key) {
        LOGI("engine reused (cached)");
        return g_engine.get();
    }
    g_engine.reset();
    g_engineKey.clear();

    const double t0 = nowMs();
    std::unique_ptr<RealSR> engine(new RealSR(gpuid, false /*tta*/, threads));
    if (engine->load(param.c_str(), bin.c_str()) != 0) {
        LOGE("model load FAILED: %s", param.c_str());
        return nullptr;
    }
    LOGI("engine loaded in %.0fms", nowMs() - t0);
    g_engine = std::move(engine);
    g_engineKey = key;
    return g_engine.get();
}

// Output size after the width cap is applied.
static void cappedSize(int w, int h, int maxWidth, int* ow, int* oh) {
    if (maxWidth > 0 && w > maxWidth) {
        *ow = maxWidth;
        *oh = (int)std::lround((double)h * maxWidth / (double)w);
        if (*oh < 1) *oh = 1;
    } else {
        *ow = w;
        *oh = h;
    }
}

// Area-average downscale of an interleaved RGB8 buffer.
//
// Point sampling aliases badly when a detailed page shrinks, and manga line art
// is exactly the content that shows it: hairlines turn into moiré. Averaging
// every source pixel that falls inside a destination pixel keeps the result
// clean, and costs one pass over the source.
static void downscaleRgb(const unsigned char* src, int sw, int sh,
                         unsigned char* dst, int dw, int dh) {
    for (int y = 0; y < dh; y++) {
        const int y0 = (int)((int64_t)y * sh / dh);
        int y1 = (int)((int64_t)(y + 1) * sh / dh);
        if (y1 <= y0) y1 = y0 + 1;
        for (int x = 0; x < dw; x++) {
            const int x0 = (int)((int64_t)x * sw / dw);
            int x1 = (int)((int64_t)(x + 1) * sw / dw);
            if (x1 <= x0) x1 = x0 + 1;
            int r = 0, g = 0, b = 0, n = 0;
            for (int sy = y0; sy < y1; sy++) {
                const unsigned char* row = src + (size_t)sy * (size_t)sw * 3;
                for (int sx = x0; sx < x1; sx++) {
                    r += row[sx * 3 + 0];
                    g += row[sx * 3 + 1];
                    b += row[sx * 3 + 2];
                    n++;
                }
            }
            unsigned char* out = dst + ((size_t)y * (size_t)dw + x) * 3;
            out[0] = (unsigned char)(r / n);
            out[1] = (unsigned char)(g / n);
            out[2] = (unsigned char)(b / n);
        }
    }
}

// Expand interleaved RGB8 into the RGBA byte order Android's ARGB_8888
// bitmaps expect (R,G,B,A per pixel).
static void writeRgba(const unsigned char* rgb, int w, int h, unsigned char* dst) {
    const size_t n = (size_t)w * (size_t)h;
    for (size_t i = 0; i < n; i++) {
        dst[i * 4 + 0] = rgb[i * 3 + 0];
        dst[i * 4 + 1] = rgb[i * 3 + 1];
        dst[i * 4 + 2] = rgb[i * 3 + 2];
        dst[i * 4 + 3] = 255;
    }
}

// Run one page through the ncnn RealSR engine. Returns 0 on success, or a
// negative code when cancelled. Throws std::runtime_error with a typed prefix
// ("process-failed:", "cancelled:") for the Java layer.
//
// The pixels are NOT encoded here: they are handed to Java as an RGBA buffer
// so the platform encoder (Skia/libwebp) can write them. stb can only write
// PNG/JPEG, and a baseline JPEG at the same perceptual quality costs ~40%
// more bytes than WebP.
static int runRealSR(const std::string& src, RealSR* sr, int maxWidth,
                     unsigned char* rgbaOut, size_t rgbaCapacity,
                     int* outWidth, int* outHeight,
                     std::atomic<bool>* cancel) {
    const double tStart = nowMs();
    int w = 0, h = 0, c = 0;
    unsigned char* rgb = stbi_load(src.c_str(), &w, &h, &c, 3);
    if (rgb == nullptr) {
        LOGE("decode failed for %s", src.c_str());
        throw std::runtime_error("process-failed:failed to decode " + src);
    }
    LOGI("decoded %dx%d (%dch) in %.0fms", w, h, c, nowMs() - tStart);

    // Wrap the raw interleaved RGB as elempack=3. RealSR::process() derives
    // `channels = inimage.elempack` and strides rows by w*channels bytes, so the
    // input MUST be elempack 3. from_pixels(PIXEL_RGB) returns elempack 1, which
    // makes process() read only the red channel → black-with-noise output.
    // `in` wraps `rgb`, so rgb must stay alive until process() returns.
    ncnn::Mat in(w, h, rgb, (size_t)3, 3);
    if (in.empty()) {
        throw std::runtime_error("process-failed:invalid input tensor");
    }

    const int scale = sr->scale;
    LOGI("running RealSR scale=%d tilesize=%d prepadding=%d",
         sr->scale, sr->tilesize, sr->prepadding);

    const double tProc = nowMs();
    // RealSR::process() writes INTO the caller's outimage — it must be
    // pre-allocated at w*scale × h*scale, else it memcpy's into a null/garbage
    // buffer and SIGSEGVs inside VkCompute::submit_and_wait(). Match the engine's
    // expected layout (elemsize 3, elempack 3 = interleaved RGB).
    ncnn::Mat out;
    out.create(w * scale, h * scale, (size_t)3, 3);
    if (sr->process(in, out) != 0) {
        stbi_image_free(rgb);
        LOGE("RealSR::process FAILED");
        throw std::runtime_error("process-failed:RealSR::process failed");
    }
    // `in` wrapped the stb buffer — safe to release now that inference is done.
    stbi_image_free(rgb);
    LOGI("process %dx%d -> %dx%d (c=%d elempack=%d) in %.0fms",
         w, h, out.w, out.h, out.c, out.elempack, nowMs() - tProc);
    if (cancel->load()) {
        // Cancelled mid-flight: drop the partial output, signal cancellation.
        return -1;
    }

    const int ow = out.w;
    const int oh = out.h;
    *outWidth = ow;
    *outHeight = oh;
    const double tEnc = nowMs();
    // RealSR::process leaves `out.data` as interleaved RGB (3 bytes/pixel).
    // Save it directly — re-running out.to_pixels() would reinterpret that
    // buffer as planar float channels and produce a corrupted (black/red) image.
    //
    // Apply the width cap here, before the pixels cross into Java: the model's
    // own output is 2× the source, which overshoots what any screen resolves
    // (a 1080p tablet shows a page ~1200 px wide, ~1800 px at 1.5× zoom), so
    // the extra pixels are pure disk cost. Shrinking here also keeps the
    // buffer that crosses the bridge as small as possible.
    std::vector<unsigned char> shrunk;
    const unsigned char* outRgb = (const unsigned char*)out.data;
    int cappedW = ow;
    int cappedH = oh;
    if (maxWidth > 0 && ow > maxWidth) {
        cappedSize(ow, oh, maxWidth, &cappedW, &cappedH);
        shrunk.resize((size_t)cappedW * cappedH * 3);
        const double tScale = nowMs();
        downscaleRgb(outRgb, ow, oh, shrunk.data(), cappedW, cappedH);
        LOGI("downscaled %dx%d -> %dx%d in %.0fms", ow, oh, cappedW, cappedH, nowMs() - tScale);
        outRgb = shrunk.data();
    }

    const size_t need = (size_t)cappedW * cappedH * 4;
    if (rgbaOut == nullptr || rgbaCapacity < need) {
        throw std::runtime_error("process-failed:output buffer too small");
    }
    writeRgba(outRgb, cappedW, cappedH, rgbaOut);
    *outWidth = cappedW;
    *outHeight = cappedH;
    LOGI("pixels ready %dx%d in %.0fms (page total %.0fms)",
         cappedW, cappedH, nowMs() - tEnc, nowMs() - tStart);
    return 0;
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_openviewer_realesrgan_RealEsrganPlugin_nativeGetCapabilities(JNIEnv* env, jobject /*thiz*/) {
    ncnn::set_cpu_powersave(0);
    int gpuCount = ncnn::get_gpu_count();
    bool vulkan = gpuCount > 0;
    LOGI("getCapabilities gpu_count=%d backend=%s", gpuCount, vulkan ? "vulkan" : "cpu");
    // Default (first) is the 2x anime net — the fast, mobile-friendly default.
    std::string json = "{\"available\":true,";
    json += "\"backend\":\"" + std::string(vulkan ? "vulkan" : "cpu") + "\",";
    json += "\"models\":[\"realesrgan-v2-anime-x2\",\"realesrgan-x4\"],";
    json += "\"maxDimension\":4096}";
    return env->NewStringUTF(json.c_str());
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_openviewer_realesrgan_RealEsrganPlugin_nativePlan(
    JNIEnv* env, jobject /*thiz*/,
    jstring sourcePath, jint scale, jint maxWidth) {

    const char* srcC = env->GetStringUTFChars(sourcePath, nullptr);
    int w = 0, h = 0, c = 0;
    // stbi_info reads the image header only — no pixel work at all.
    const int ok = stbi_info(srcC, &w, &h, &c);
    env->ReleaseStringUTFChars(sourcePath, srcC);
    if (!ok || w <= 0 || h <= 0) {
        jclass ex = env->FindClass("java/lang/RuntimeException");
        env->ThrowNew(ex, "invalid-source:cannot read image header");
        return nullptr;
    }
    int ow = 0, oh = 0;
    cappedSize(w * scale, h * scale, maxWidth, &ow, &oh);
    std::string json = "{\"width\":" + std::to_string(ow) +
                       ",\"height\":" + std::to_string(oh) + "}";
    return env->NewStringUTF(json.c_str());
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_openviewer_realesrgan_RealEsrganPlugin_nativeEnhancePage(
    JNIEnv* env, jobject /*thiz*/,
    jstring modelDir, jstring sourcePath,
    jint scale, jstring model, jint tileSize, jint denoise, jstring jobId,
    jint maxWidth, jobject buffer) {

    const char* modelDirC = env->GetStringUTFChars(modelDir, nullptr);
    const char* srcC = env->GetStringUTFChars(sourcePath, nullptr);
    const char* modelC = env->GetStringUTFChars(model, nullptr);
    const char* jobC = env->GetStringUTFChars(jobId, nullptr);

    // The caller allocates a direct buffer sized for the capped output; the
    // pixels are written straight into it, so nothing is copied twice.
    unsigned char* rgbaOut = nullptr;
    size_t rgbaCapacity = 0;
    if (buffer != nullptr) {
        rgbaOut = (unsigned char*)env->GetDirectBufferAddress(buffer);
        rgbaCapacity = (size_t)env->GetDirectBufferCapacity(buffer);
    }

    std::string errKind = "unknown";
    std::string errMsg;
    std::string result;
    int outW = 0;
    int outH = 0;

    const double tStart = nowMs();
    int gpuid = 0;  // 0 = first Vulkan GPU. (CPU fallback would be -1.)
    int gpuCount = ncnn::get_gpu_count();
    if (gpuCount <= 0) {
        // No Vulkan device → force CPU path so a page still processes instead
        // of failing on a missing GPU.
        gpuid = -1;
        LOGW("no Vulkan GPU (count=%d) → using CPU fallback", gpuCount);
    }
    int threads = ncnn::get_cpu_count();
    if (threads < 1) threads = 1;
    if (threads > 8) threads = 8;
    LOGI("enhancePage backend=%s gpuid=%d threads=%d (job=%s)", gpuid == -1 ? "cpu" : "vulkan", gpuid, threads, jobC);

    try {
        std::string param, bin;
        if (!resolveModelPaths(modelDirC, modelC, scale, param, bin)) {
            errKind = "model-unavailable";
            throw std::runtime_error("unknown model: " + std::string(modelC));
        }
        const int tile = resolveTileSize(tileSize);
        LOGI("model paths: %s / %s (tile=%d maxWidth=%d)", param.c_str(), bin.c_str(), tile, maxWidth);

        std::atomic<bool>* cancelled = jobFlag(jobC);
        cancelled->store(false);

        // Held for the whole page: a second enhancePage call waits instead of
        // racing the shared engine's Vulkan device.
        std::lock_guard<std::mutex> engineLock(g_engineMutex);
        RealSR* sr = acquireEngine(param, bin, gpuid, threads);
        if (sr == nullptr) {
            errKind = "model-unavailable";
            throw std::runtime_error("failed to load " + param);
        }
        // RealSR does NOT initialize these in its constructor, and they are
        // per-page settings even though the engine is cached.
        sr->scale = scale;
        sr->tilesize = tile;
        sr->prepadding = 0;

        int rc = runRealSR(srcC, sr, maxWidth, rgbaOut, rgbaCapacity, &outW, &outH, cancelled);
        if (rc < 0) {
            errKind = "cancelled";
            throw std::runtime_error("cancelled");
        }

        result = "{\"width\":" + std::to_string(outW) + ","
                 "\"height\":" + std::to_string(outH) + ","
                 "\"model\":\"" + std::string(modelC) + "\","
                 "\"scale\":" + std::to_string(scale) + "}";
        LOGI("enhancePage done in %.0fms", nowMs() - tStart);
    } catch (const std::exception& e) {
        errMsg = e.what();
        LOGE("enhancePage failed after %.0fms: %s", nowMs() - tStart, errMsg.c_str());
    }

    env->ReleaseStringUTFChars(modelDir, modelDirC);
    env->ReleaseStringUTFChars(sourcePath, srcC);
    env->ReleaseStringUTFChars(model, modelC);
    env->ReleaseStringUTFChars(jobId, jobC);

    if (result.empty()) {
        // Throw a Java exception carrying the typed kind; the Java side rejects.
        jclass ex = env->FindClass("java/lang/RuntimeException");
        std::string msg = errKind + ":" + errMsg;
        env->ThrowNew(ex, msg.c_str());
        return nullptr;
    }
    return env->NewStringUTF(result.c_str());
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_openviewer_realesrgan_RealEsrganPlugin_nativeCancelPage(JNIEnv* env, jobject /*thiz*/,
                                                               jstring jobId) {
    const char* jobC = env->GetStringUTFChars(jobId, nullptr);
    std::lock_guard<std::mutex> lock(g_jobsMutex);
    auto it = g_jobs.find(jobC);
    bool found = false;
    if (it != g_jobs.end()) {
        it->second->store(true);
        found = true;
    }
    env->ReleaseStringUTFChars(jobId, jobC);
    return found ? JNI_TRUE : JNI_FALSE;
}
