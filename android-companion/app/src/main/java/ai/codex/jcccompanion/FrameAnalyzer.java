package ai.codex.jcccompanion;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Rect;
import android.media.Image;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.util.HashSet;
import java.util.Set;

final class FrameAnalyzer implements AutoCloseable {
    private static final int ROI_SAMPLE_PERIOD = 15;
    private static final int OCR_SAMPLE_PERIOD = 30;

    interface Emitter {
        void emitRoi(JSONObject observations);
        void emitOcr(JSONObject blocks);
    }

    private final RoiLayout layout;
    private final ChampionTemplateMatcher matcher;
    private final OcrAnalyzer ocrAnalyzer;

    FrameAnalyzer(Context context) {
        layout = RoiLayout.load(context);
        matcher = new ChampionTemplateMatcher(context);
        ocrAnalyzer = new OcrAnalyzer(context);
    }

    void analyze(Image image, long frameSeq, Emitter emitter) {
        if (frameSeq % ROI_SAMPLE_PERIOD != 0 && frameSeq != 1) return;
        Bitmap frame = imageToBitmap(image);
        try {
            JSONObject root = new JSONObject();
            root.put("layout_id", layout.layoutId);
            root.put("storage_policy", "no_frame_or_screenshot_persistence");
            JSONArray occupancy = buildOccupancy(frame);
            root.put("screen_state_candidate", buildScreenStateCandidate(occupancy));
            root.put("slot_occupancy", occupancy);
            root.put("identity_candidates", buildIdentityCandidates(frame, occupancy));
            root.put("scoreboard_candidates", buildScoreboardCandidates(frame));
            emitter.emitRoi(root);
            if (frameSeq == 1 || frameSeq % OCR_SAMPLE_PERIOD == 0) {
                ocrAnalyzer.analyze(frame.copy(Bitmap.Config.ARGB_8888, false), layout.ocr, emitter::emitOcr);
            }
        } catch (Exception error) {
            // Frame-level failures should not stop capture.
        } finally {
            frame.recycle();
        }
    }

    private JSONArray buildOccupancy(Bitmap frame) throws Exception {
        JSONArray rows = new JSONArray();
        for (Roi roi : layout.occupancy) {
            JSONObject row = roi.toJson();
            Rect rect = roi.toRect(frame.getWidth(), frame.getHeight());
            PixelStats stats = PixelStats.from(frame, rect);
            boolean occupied = isOccupied(roi, stats);
            row.put("occupied_candidate", occupied);
            row.put("confidence", occupancyConfidence(roi, stats, occupied));
            row.put("calibration_profile", calibrationProfile(roi));
            row.put("avg_luma", stats.avgLuma);
            row.put("variance", stats.variance);
            row.put("saturation", stats.saturation);
            rows.put(row);
        }
        return rows;
    }

    private JSONArray buildIdentityCandidates(Bitmap frame, JSONArray occupancy) throws Exception {
        JSONArray rows = new JSONArray();
        Set<String> occupiedSlots = new HashSet<>();
        for (int i = 0; i < occupancy.length(); i += 1) {
            JSONObject row = occupancy.getJSONObject(i);
            int slot = row.optInt("slot", -1);
            if (slot >= 0 && row.optBoolean("occupied_candidate")) {
                occupiedSlots.add(row.optString("group") + ":" + slot);
            }
        }
        for (Roi roi : layout.occupancy) {
            if (!"shop_slots".equals(roi.group) && !"bench_slots".equals(roi.group) && !"board_slots".equals(roi.group)) continue;
            if (roi.slot < 0 || !occupiedSlots.contains(roi.group + ":" + roi.slot)) continue;
            Rect rect = roi.toRect(frame.getWidth(), frame.getHeight());
            Bitmap crop = Bitmap.createBitmap(frame, rect.left, rect.top, rect.width(), rect.height());
            try {
                rows.put(matcher.match(roi, crop));
            } finally {
                crop.recycle();
            }
        }
        return rows;
    }

    private JSONArray buildScoreboardCandidates(Bitmap frame) throws Exception {
        JSONArray rows = new JSONArray();
        int rowCount = 8;
        float baseX = 0.895f;
        float baseY = 0.115f;
        float rowW = 0.10f;
        float rowH = 0.055f;
        double bestScore = -1.0;
        int bestIndex = -1;
        JSONObject[] candidates = new JSONObject[rowCount];
        for (int i = 0; i < rowCount; i += 1) {
            float y = baseY + (i * rowH);
            Roi rowRoi = new Roi("scoreboard_rows", "scoreboard_row", i, baseX, y, rowW, rowH);
            Roi avatarRoi = new Roi("scoreboard_avatars", "scoreboard_avatar", i, baseX + 0.002f, y + 0.004f, rowW * 0.33f, rowH * 0.78f);
            Roi hpRoi = new Roi("scoreboard_hp", "scoreboard_hp", i, baseX + 0.055f, y + 0.006f, rowW * 0.40f, rowH * 0.70f);
            Rect rowRect = rowRoi.toRect(frame.getWidth(), frame.getHeight());
            Rect avatarRect = avatarRoi.toRect(frame.getWidth(), frame.getHeight());
            PixelStats rowStats = PixelStats.from(frame, rowRect);
            PixelStats avatarStats = PixelStats.from(frame, avatarRect);
            double score = (avatarStats.variance / 2400.0 * 0.45) + (avatarStats.saturation * 0.35) + (rowStats.avgLuma / 255.0 * 0.20);
            score = Math.max(0.0, Math.min(1.0, score));
            JSONObject row = new JSONObject();
            row.put("slot", i);
            row.put("row_roi", rowRoi.toJson());
            row.put("avatar_roi", avatarRoi.toJson());
            row.put("hp_roi", hpRoi.toJson());
            row.put("avatar_size_score", score);
            row.put("avatar_variance", avatarStats.variance);
            row.put("avatar_saturation", avatarStats.saturation);
            row.put("row_luma", rowStats.avgLuma);
            row.put("binding_status", "scoreboard_row_candidate");
            candidates[i] = row;
            if (score > bestScore) {
                bestScore = score;
                bestIndex = i;
            }
        }
        for (int i = 0; i < rowCount; i += 1) {
            JSONObject row = candidates[i];
            row.put("local_player_candidate", i == bestIndex && bestScore >= 0.42);
            row.put("confidence", i == bestIndex ? Math.min(0.82, bestScore) : Math.min(0.35, row.optDouble("avatar_size_score")));
            rows.put(row);
        }
        return rows;
    }

    private static Bitmap imageToBitmap(Image image) {
        Image.Plane plane = image.getPlanes()[0];
        ByteBuffer buffer = plane.getBuffer();
        int pixelStride = plane.getPixelStride();
        int rowStride = plane.getRowStride();
        int rowPixels = rowStride / pixelStride;
        Bitmap padded = Bitmap.createBitmap(rowPixels, image.getHeight(), Bitmap.Config.ARGB_8888);
        padded.copyPixelsFromBuffer(buffer);
        if (rowPixels == image.getWidth()) return padded;
        Bitmap cropped = Bitmap.createBitmap(padded, 0, 0, image.getWidth(), image.getHeight());
        padded.recycle();
        return cropped;
    }

    private static JSONObject buildScreenStateCandidate(JSONArray occupancy) throws Exception {
        int occupied = 0;
        for (int i = 0; i < occupancy.length(); i += 1) {
            JSONObject row = occupancy.getJSONObject(i);
            if (row.optBoolean("occupied_candidate")) occupied += 1;
        }
        JSONObject state = new JSONObject();
        state.put("kind", occupied >= 3 ? "in_game_candidate" : "unknown_or_menu_candidate");
        state.put("occupied_roi_count", occupied);
        state.put("confidence", Math.min(0.95, occupied / 12.0));
        return state;
    }

    private static boolean isOccupied(Roi roi, PixelStats stats) {
        if ("board_slots".equals(roi.group)) {
            return stats.variance > 1800 || (stats.variance > 1300 && stats.saturation > 0.52);
        }
        if ("bench_slots".equals(roi.group)) {
            return stats.variance > 900 || (stats.variance > 560 && stats.saturation > 0.42);
        }
        if ("shop_slots".equals(roi.group)) {
            return stats.variance > 800 || (stats.variance > 450 && stats.saturation > 0.28);
        }
        return stats.variance > 900 || (stats.variance > 450 && stats.saturation > 0.22);
    }

    private static double occupancyConfidence(Roi roi, PixelStats stats, boolean occupied) {
        double varianceScale = "board_slots".equals(roi.group) ? 2600.0 : 1800.0;
        double raw = (stats.variance / varianceScale * 0.75) + (stats.saturation * 0.25);
        double bounded = Math.min(0.95, Math.max(0.05, raw));
        return occupied ? bounded : Math.min(0.35, bounded);
    }

    private static String calibrationProfile(Roi roi) {
        if ("board_slots".equals(roi.group)) return "board_strict_v2";
        if ("bench_slots".equals(roi.group)) return "bench_moderate_v2";
        if ("shop_slots".equals(roi.group)) return "shop_card_v2";
        return "generic_v2";
    }

    @Override
    public void close() {
        ocrAnalyzer.close();
    }

    private static final class PixelStats {
        final double avgLuma;
        final double variance;
        final double saturation;

        private PixelStats(double avgLuma, double variance, double saturation) {
            this.avgLuma = avgLuma;
            this.variance = variance;
            this.saturation = saturation;
        }

        static PixelStats from(Bitmap bitmap, Rect rect) {
            int stepX = Math.max(1, rect.width() / 16);
            int stepY = Math.max(1, rect.height() / 16);
            double sum = 0;
            double sum2 = 0;
            double sat = 0;
            int count = 0;
            for (int y = rect.top; y < rect.bottom; y += stepY) {
                for (int x = rect.left; x < rect.right; x += stepX) {
                    int color = bitmap.getPixel(x, y);
                    int r = Color.red(color);
                    int g = Color.green(color);
                    int b = Color.blue(color);
                    double luma = 0.299 * r + 0.587 * g + 0.114 * b;
                    sum += luma;
                    sum2 += luma * luma;
                    int max = Math.max(r, Math.max(g, b));
                    int min = Math.min(r, Math.min(g, b));
                    sat += max == 0 ? 0 : (max - min) / (double) max;
                    count += 1;
                }
            }
            double avg = count == 0 ? 0 : sum / count;
            double variance = count == 0 ? 0 : (sum2 / count) - (avg * avg);
            return new PixelStats(avg, Math.max(0, variance), count == 0 ? 0 : sat / count);
        }
    }
}
