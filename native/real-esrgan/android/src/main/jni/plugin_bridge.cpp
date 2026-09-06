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
#include <mutex>
#include <chrono>
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

// Run one page through the ncnn RealSR engine. Returns 0 on success, or a
// negative code when cancelled. Throws std::runtime_error with a typed prefix
// ("model-unavailable:", "process-failed:", "cancelled:") for the Java layer.
static int runRealSR(const std::string& src, const std::string& dst, int gpuid, int threads,
                     int scale, int tileSize, const std::string& param, const std::string& bin,
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

    LOGI("creating RealSR gpuid=%d threads=%d", gpuid, threads);
    RealSR sr(gpuid, false /*tta*/, threads);
    // RealSR does NOT initialize these in its constructor — the caller must.
    // Garbage scale/tilesize → division by zero or an absurd allocation, so a
    // page would hang or OOM instead of finishing.
    sr.scale = scale;
    sr.tilesize = tileSize > 0 ? tileSize : 32;
    sr.prepadding = 0;
    LOGI("sr.scale=%d sr.tilesize=%d sr.prepadding=%d", sr.scale, sr.tilesize, sr.prepadding);

    const double tLoad = nowMs();
    if (sr.load(param.c_str(), bin.c_str()) != 0) {
        LOGE("model load FAILED: %s", param.c_str());
        throw std::runtime_error("model-unavailable:failed to load " + param);
    }
    LOGI("model loaded in %.0fms", nowMs() - tLoad);

    const double tProc = nowMs();
    // RealSR::process() writes INTO the caller's outimage — it must be
    // pre-allocated at w*scale × h*scale, else it memcpy's into a null/garbage
    // buffer and SIGSEGVs inside VkCompute::submit_and_wait(). Match the engine's
    // expected layout (elemsize 3, elempack 3 = interleaved RGB).
    ncnn::Mat out;
    out.create(w * scale, h * scale, (size_t)3, 3);
    if (sr.process(in, out) != 0) {
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
    const double tEnc = nowMs();
    // RealSR::process leaves `out.data` as interleaved RGB (3 bytes/pixel).
    // Save it directly — re-running out.to_pixels() would reinterpret that
    // buffer as planar float channels and produce a corrupted (black/red) PNG.
    if (stbi_write_png(dst.c_str(), ow, oh, 3, out.data, ow * 3) == 0) {
        LOGE("failed to encode %s", dst.c_str());
        throw std::runtime_error("process-failed:failed to encode " + dst);
    }
    LOGI("encoded %s in %.0fms (page total %.0fms)", dst.c_str(), nowMs() - tEnc, nowMs() - tStart);
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
Java_com_openviewer_realesrgan_RealEsrganPlugin_nativeEnhancePage(
    JNIEnv* env, jobject /*thiz*/,
    jstring modelDir, jstring sourcePath, jstring destinationPath,
    jint scale, jstring model, jint tileSize, jint denoise, jstring jobId) {

    const char* modelDirC = env->GetStringUTFChars(modelDir, nullptr);
    const char* srcC = env->GetStringUTFChars(sourcePath, nullptr);
    const char* dstC = env->GetStringUTFChars(destinationPath, nullptr);
    const char* modelC = env->GetStringUTFChars(model, nullptr);
    const char* jobC = env->GetStringUTFChars(jobId, nullptr);

    std::string errKind = "unknown";
    std::string errMsg;
    std::string result;

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
        LOGI("model paths: %s / %s", param.c_str(), bin.c_str());

        std::atomic<bool>* cancelled = jobFlag(jobC);
        cancelled->store(false);

        int rc = runRealSR(srcC, dstC, gpuid, threads, scale, tileSize, param, bin, cancelled);
        if (rc < 0) {
            // Cancelled: remove any partial destination and report cancellation.
            std::remove(dstC);
            errKind = "cancelled";
            throw std::runtime_error("cancelled");
        }

        result = "{\"destinationUri\":\"" + std::string(dstC) + "\","
                 "\"width\":" + std::to_string(0) + ","
                 "\"height\":" + std::to_string(0) + ","
                 "\"model\":\"" + std::string(modelC) + "\","
                 "\"scale\":" + std::to_string(scale) + "}";
        LOGI("enhancePage done in %.0fms", nowMs() - tStart);
    } catch (const std::exception& e) {
        errMsg = e.what();
        LOGE("enhancePage failed after %.0fms: %s", nowMs() - tStart, errMsg.c_str());
    }

    env->ReleaseStringUTFChars(modelDir, modelDirC);
    env->ReleaseStringUTFChars(sourcePath, srcC);
    env->ReleaseStringUTFChars(destinationPath, dstC);
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
