package com.openviewer.realesrgan;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.util.Log;

import androidx.core.content.ContextCompat;

import java.io.File;
import java.io.IOException;

/**
 * Capacitor bridge for the local ncnn upscaler. The heavy lifting lives in
 * {@code libreal_esrgan.so} (plugin_bridge.cpp + vendored RealSR module). This
 * class only marshals arguments, resolves content/SAF URIs to file paths, and
 * returns typed results/errors. It never uploads anything.
 */
@CapacitorPlugin(name = "RealEsrgan")
public class RealEsrganPlugin extends Plugin {

    private static final String TAG = "RealEsrgan";

    static {
        System.loadLibrary("real_esrgan");
    }

    // Native entry points. URIs are already resolved to file paths by the time
    // they cross the JNI boundary.
    private native String nativeGetCapabilities();

    private native String nativeEnhancePage(
            String modelDir,
            String sourcePath,
            String destinationPath,
            int scale,
            String model,
            int tileSize,
            int denoise,
            String jobId);

    private native boolean nativeCancelPage(String jobId);

    @PluginMethod
    public void getCapabilities(PluginCall call) {
        long t0 = System.nanoTime();
        try {
            String json = nativeGetCapabilities();
            Log.i(TAG, "getCapabilities -> " + json + " (" + ms(t0) + "ms)");
            call.resolve(new JSObject(json));
        } catch (Throwable e) {
            Log.e(TAG, "getCapabilities FAILED", e);
            call.reject("capabilities_failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void enhancePage(PluginCall call) {
        long t0 = System.nanoTime();
        String sourceUri = call.getString("sourceUri", "");
        String destinationUri = call.getString("destinationUri", "");
        int scale = call.getInt("scale", 2);
        String model = call.getString("model", "realesrgan-v2-anime-x2");
        int tileSize = call.getInt("tileSize", 0);
        int denoise = call.getInt("denoise", 0);
        String jobId = call.getString("jobId", "");
        Log.i(TAG, "enhancePage() source=" + sourceUri + " dest=" + destinationUri
                + " scale=" + scale + " model=" + model + " tileSize=" + tileSize + " denoise=" + denoise);

        if (sourceUri.isEmpty() || destinationUri.isEmpty() || jobId.isEmpty()) {
            Log.e(TAG, "enhancePage() invalid_args (missing required arg)");
            call.reject("invalid_args", "sourceUri, destinationUri and jobId are required.");
            return;
        }

        // Resolve BOTH ends to real file paths the ncnn .so can open:
        //  - source `content://` URIs (Android scoped storage) are copied to cache.
        //  - destination `enhanced/...` (or `enhanced://...`) is placed under the
        //    app cache so it survives and can be served back to the reader.
        String srcPath = resolveSourcePath(sourceUri);
        String dstPath = resolveDestinationPath(destinationUri);
        Log.i(TAG, "enhancePage() srcPath=" + srcPath + " dstPath=" + dstPath);
        if (srcPath == null) {
            Log.e(TAG, "enhancePage() invalid_source: " + sourceUri);
            call.reject("invalid_source", "Could not resolve source URI: " + sourceUri);
            return;
        }

        try {
            String modelDir = ensureModelsDir();
            Log.i(TAG, "enhancePage() modelDir=" + modelDir);
            Log.i(TAG, "enhancePage() calling nativeEnhancePage");
            String json = nativeEnhancePage(modelDir, srcPath, dstPath, scale, model, tileSize, denoise, jobId);
            Log.i(TAG, "enhancePage() native done -> " + json + " (" + ms(t0) + "ms total)");
            call.resolve(new JSObject(json));
        } catch (Throwable e) {
            Log.e(TAG, "enhancePage() FAILED after " + ms(t0) + "ms: " + e.getMessage(), e);
            call.reject(e.getMessage());
        }
    }

    /**
     * Make the Real-ESRGAN weights readable as a real path for ncnn. The models
     * ship inside the APK as Android assets (`assets/models-realesrgan/`); ncnn
     * cannot open asset streams, so copy them once into the app cache and return
     * that directory. The bridge resolves `<dir>/models-Real-ESRGANv2-anime/x2.param`.
     */
    private String ensureModelsDir() {
        File modelsDir = new File(getContext().getCacheDir(), "models");
        try {
            String[] roots = getContext().getAssets().list("models-realesrgan");
            if (roots == null || roots.length == 0) {
                Log.w(TAG, "ensureModelsDir: no models-realesrgan assets found");
                return modelsDir.getAbsolutePath();
            }
            boolean complete = true;
            for (String root : roots) {
                String[] files = getContext().getAssets().list("models-realesrgan/" + root);
                if (files == null || files.length == 0) {
                    complete = false;
                    break;
                }
                for (String f : files) {
                    if (!new File(modelsDir, root + "/" + f).exists()) {
                        complete = false;
                        break;
                    }
                }
            }
            if (!complete) {
                for (String root : roots) {
                    copyAssetDir("models-realesrgan/" + root, new File(modelsDir, root));
                }
                Log.i(TAG, "ensureModelsDir: copied model weights to " + modelsDir);
            }
        } catch (IOException e) {
            Log.e(TAG, "ensureModelsDir FAILED", e);
        }
        return modelsDir.getAbsolutePath();
    }

    private void copyAssetDir(String assetPath, File destDir) throws IOException {
        String[] files = getContext().getAssets().list(assetPath);
        if (files == null || files.length == 0) return;
        if (!destDir.exists() && !destDir.mkdirs()) {
            throw new IOException("cannot create " + destDir);
        }
        for (String f : files) {
            String full = assetPath + "/" + f;
            try (java.io.InputStream in = getContext().getAssets().open(full);
                 java.io.FileOutputStream out = new java.io.FileOutputStream(new File(destDir, f))) {
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            }
        }
    }

    @PluginMethod
    public void cancelPage(PluginCall call) {
        String jobId = call.getString("jobId", "");
        Log.i(TAG, "cancelPage() jobId=" + jobId);
        boolean cancelled = nativeCancelPage(jobId);
        Log.i(TAG, "cancelPage() cancelled=" + cancelled);
        JSObject ret = new JSObject();
        ret.put("cancelled", cancelled);
        call.resolve(ret);
    }

    /** Start the foreground service so a batch keeps running in the background. */
    @PluginMethod
    public void startForeground(PluginCall call) {
        int done = call.getInt("done", 0);
        int total = call.getInt("total", 0);
        Log.i(TAG, "startForeground() done=" + done + " total=" + total);
        try {
            EnhanceForegroundService.setProgress(done, total);
            Intent i = new Intent(getContext(), EnhanceForegroundService.class);
            ContextCompat.startForegroundService(getContext(), i);
            call.resolve();
        } catch (Throwable e) {
            Log.e(TAG, "startForeground() FAILED: " + e.getMessage(), e);
            call.reject(e.getMessage());
        }
    }

    /** Push new progress into the foreground notification. */
    @PluginMethod
    public void updateForeground(PluginCall call) {
        int done = call.getInt("done", 0);
        int total = call.getInt("total", 0);
        EnhanceForegroundService.setProgress(done, total);
        call.resolve();
    }

    /** Stop the foreground service once the batch is done / paused / cancelled. */
    @PluginMethod
    public void stopForeground(PluginCall call) {
        Log.i(TAG, "stopForeground()");
        getContext().stopService(new Intent(getContext(), EnhanceForegroundService.class));
        call.resolve();
    }

    private static long ms(long startNanos) {
        return (System.nanoTime() - startNanos) / 1_000_000L;
    }

    /**
     * Resolve a SOURCE URI to a path ncnn can read. `file://` → strip scheme;
     * `content://` (Android scoped storage / SAF) → copy to the app cache and
     * return that path, because ncnn needs a real fd/path and cannot open a
     * content URI directly. Returns null if the URI cannot be resolved.
     */
    private String resolveSourcePath(String uri) {
        if (uri == null) return null;
        if (uri.startsWith("file://")) {
            return uri.substring("file://".length());
        }
        if (uri.startsWith("content://")) {
            try {
                return copyContentToCache(uri, "src_" + System.nanoTime());
            } catch (Throwable e) {
                return null;
            }
        }
        return uri; // already a bare path
    }

    /**
     * Resolve a DESTINATION URI to a real file path under the app cache. The TS
     * layer passes `enhanced/<hash>.png` (or `enhanced://<hash>.png`); we place
     * the derivative in `<cache>/enhanced/<hash>.png` so it is readable by the
     * reader's blob-URL resolver and is cleared with the app cache.
     */
    private String resolveDestinationPath(String uri) {
        if (uri == null) return null;
        String name = uri;
        if (uri.startsWith("enhanced://")) {
            name = uri.substring("enhanced://".length());
        } else if (uri.startsWith("enhanced/")) {
            name = uri.substring("enhanced/".length());
        }
        File dir = new File(getContext().getCacheDir(), "enhanced");
        // noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return new File(dir, name).getAbsolutePath();
    }

    /** Stream a content:// URI to a temp file in the app cache; return its path. */
    private String copyContentToCache(String contentUri, String prefix) throws Exception {
        android.content.ContentResolver cr = getContext().getContentResolver();
        android.net.Uri src = android.net.Uri.parse(contentUri);
        String ext = "png";
        String type = cr.getType(src);
        if (type != null) {
            if (type.contains("jpeg")) ext = "jpg";
            else if (type.contains("webp")) ext = "webp";
        }
        File out = new File(getContext().getCacheDir(), prefix + "." + ext);
        try (java.io.InputStream in = cr.openInputStream(src);
             java.io.FileOutputStream fos = new java.io.FileOutputStream(out)) {
            if (in == null) throw new Exception("cannot open content stream");
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) fos.write(buf, 0, n);
        }
        return out.getAbsolutePath();
    }
}
