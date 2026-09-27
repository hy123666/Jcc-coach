package ai.codex.jcccompanion;

import android.content.Context;
import android.content.res.AssetManager;
import android.graphics.Bitmap;
import android.graphics.Rect;

import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

final class OcrAnalyzer implements AutoCloseable {
    private static final String ENGINE_NAME = "jcc_mlkit_chinese_text_recognition";
    private static final String FAST_ENGINE_NAME = "jcc_fast_native_ppocrv5_roi_ocr";

    interface Callback {
        void onOcr(JSONObject blocks);
    }

    private final TextRecognizer recognizer = TextRecognition.getClient(new ChineseTextRecognizerOptions.Builder().build());
    private final AtomicBoolean busy = new AtomicBoolean(false);
    private final AssetManager assets;

    OcrAnalyzer(Context context) {
        assets = context.getAssets();
    }

    void analyze(Bitmap frame, List<Roi> rois, Callback callback) {
        if (!busy.compareAndSet(false, true)) {
            frame.recycle();
            return;
        }
        JSONArray output = new JSONArray();
        try {
            for (Roi roi : rois) {
                Rect rect = clamp(roi.toRect(frame.getWidth(), frame.getHeight()), frame.getWidth(), frame.getHeight());
                if (rect.width() <= 0 || rect.height() <= 0) continue;
                Bitmap crop = Bitmap.createBitmap(frame, rect.left, rect.top, rect.width(), rect.height());
                try {
                    JSONObject nativeBlocks = NativeOcrBridge.recognizeBitmap(assets, crop);
                    JSONArray nativeLines = collectNativeLines(nativeBlocks);
                    try {
                        JSONObject row = new JSONObject();
                        row.put("roi", roi.toJson());
                        row.put("ocr_mode", "fast_native_roi");
                        row.put("text", joinLines(nativeLines));
                        row.put("line_count", nativeLines.length());
                        row.put("lines", nativeLines);
                        row.put("native_blocks", nativeBlocks);
                        output.put(row);
                    } catch (Exception ignored) {
                    }
                } finally {
                    crop.recycle();
                }
            }
            try {
                JSONObject root = new JSONObject();
                root.put("engine", FAST_ENGINE_NAME);
                root.put("fallback_engine", ENGINE_NAME);
                root.put("engine_scope", "product_default_multi_abi");
                root.put("critical_sheet_enabled", false);
                root.put("mlkit_enabled", false);
                root.put("roi_count", output.length());
                root.put("native_ocr", NativeOcrBridge.statusJson(assets));
                root.put("blocks", output);
                callback.onOcr(root);
            } catch (Exception ignored) {
            }
        } finally {
            frame.recycle();
            busy.set(false);
        }
    }

    private static Rect clamp(Rect rect, int width, int height) {
        return new Rect(
                Math.max(0, Math.min(width, rect.left)),
                Math.max(0, Math.min(height, rect.top)),
                Math.max(0, Math.min(width, rect.right)),
                Math.max(0, Math.min(height, rect.bottom))
        );
    }

    private static int countLines(Text text) {
        int count = 0;
        for (Text.TextBlock block : text.getTextBlocks()) {
            count += block.getLines().size();
        }
        return count;
    }

    private static JSONArray collectLines(Text text) {
        JSONArray lines = new JSONArray();
        for (Text.TextBlock block : text.getTextBlocks()) {
            for (Text.Line line : block.getLines()) {
                lines.put(line.getText());
            }
        }
        return lines;
    }

    private static JSONArray collectNativeLines(JSONObject nativeBlocks) {
        JSONArray lines = new JSONArray();
        JSONArray blocks = nativeBlocks.optJSONArray("blocks");
        if (blocks == null) return lines;
        for (int i = 0; i < blocks.length(); i += 1) {
            JSONObject block = blocks.optJSONObject(i);
            if (block == null) continue;
            String text = block.optString("text", "").trim();
            if (!text.isEmpty()) lines.put(text);
        }
        return lines;
    }

    private static String joinLines(JSONArray lines) {
        StringBuilder builder = new StringBuilder();
        for (int i = 0; i < lines.length(); i += 1) {
            String text = lines.optString(i, "").trim();
            if (text.isEmpty()) continue;
            if (builder.length() > 0) builder.append('\n');
            builder.append(text);
        }
        return builder.toString();
    }

    @Override
    public void close() {
        recognizer.close();
    }
}
