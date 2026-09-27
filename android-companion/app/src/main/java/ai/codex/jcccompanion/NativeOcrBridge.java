package ai.codex.jcccompanion;

import android.content.res.AssetManager;
import android.graphics.Bitmap;

import org.json.JSONObject;

final class NativeOcrBridge {
    private static boolean attempted;
    private static boolean loaded;
    private static String unavailableReason = "";

    private NativeOcrBridge() {
    }

    static JSONObject statusJson(AssetManager assets) {
        ensureLoaded();
        JSONObject root = new JSONObject();
        try {
            root.put("library", "jcc_ocr");
            boolean canRun = loaded && nativeCanRun(assets);
            root.put("available", canRun);
            root.put("role", "product_native_ocr_adapter");
            root.put("backend", "ppocrv5_ncnn_mobile");
            root.put("model_set", "PP-OCRv5_mobile_det+rec");
            root.put("text_recognition_active", canRun);
            root.put("text_recognition_engine", canRun ? "jcc_native_ppocrv5_ncnn_mobile" : "mlkit_fallback");
            if (loaded) {
                root.put("version", nativeVersion());
                root.put("load_code", nativeLoadCode());
            } else {
                root.put("unavailable_reason", unavailableReason);
            }
        } catch (Exception ignored) {
        }
        return root;
    }

    static JSONObject recognizeBitmap(AssetManager assets, Bitmap bitmap) {
        ensureLoaded();
        if (!loaded) {
            JSONObject root = new JSONObject();
            try {
                root.put("engine", "jcc_native_ppocrv5_ncnn_mobile");
                root.put("available", false);
                root.put("unavailable_reason", unavailableReason);
            } catch (Exception ignored) {
            }
            return root;
        }
        try {
            return new JSONObject(nativeRecognizeBitmap(assets, bitmap));
        } catch (Throwable error) {
            JSONObject root = new JSONObject();
            try {
                root.put("engine", "jcc_native_ppocrv5_ncnn_mobile");
                root.put("available", false);
                root.put("error", error.getClass().getSimpleName());
                root.put("message", String.valueOf(error.getMessage()));
            } catch (Exception ignored) {
            }
            return root;
        }
    }

    private static synchronized void ensureLoaded() {
        if (attempted) return;
        attempted = true;
        try {
            System.loadLibrary("jcc_ocr");
            loaded = true;
        } catch (Throwable error) {
            loaded = false;
            unavailableReason = error.getClass().getSimpleName() + ":" + String.valueOf(error.getMessage());
        }
    }

    private static native String nativeVersion();

    private static native boolean nativeCanRun(AssetManager assets);

    private static native int nativeLoadCode();

    private static native String nativeRecognizeBitmap(AssetManager assets, Bitmap bitmap);
}
