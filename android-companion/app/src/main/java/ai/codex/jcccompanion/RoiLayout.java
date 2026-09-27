package ai.codex.jcccompanion;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

final class RoiLayout {
    final String layoutId;
    final List<Roi> all;
    final List<Roi> occupancy;
    final List<Roi> ocr;

    private RoiLayout(String layoutId, List<Roi> all, List<Roi> occupancy, List<Roi> ocr) {
        this.layoutId = layoutId;
        this.all = all;
        this.occupancy = occupancy;
        this.ocr = ocr;
    }

    static RoiLayout load(Context context) {
        try {
            JSONObject root = new JSONObject(readAsset(context, "jcc_roi_layout.json"));
            JSONObject regions = root.getJSONObject("regions");
            List<Roi> all = new ArrayList<>();
            addObjectGroup(all, "phase", regions.getJSONObject("phase"));
            addObjectGroup(all, "economy", regions.getJSONObject("economy"));
            addArrayGroup(all, "shop_slots", "shop_slot", regions.getJSONArray("shop_slots"));
            addArrayGroup(all, "bench_slots", "bench_slot", regions.getJSONArray("bench_slots"));
            JSONObject boardRegion = regions.getJSONObject("board_region");
            addSingle(all, "board", "board_region", -1, boardRegion);
            addBoardSlots(all, boardRegion);
            addArrayGroup(all, "augment_slots", "augment_slot", regions.getJSONArray("augment_slots"));

            List<Roi> occupancy = new ArrayList<>();
            for (Roi roi : all) {
                if ("shop_slots".equals(roi.group) || "bench_slots".equals(roi.group) || "board_slots".equals(roi.group)) {
                    occupancy.add(roi);
                }
            }
            List<Roi> ocr = new ArrayList<>();
            for (Roi roi : all) {
                if (isFastOcrRoi(roi)) {
                    ocr.add(roi);
                }
            }
            return new RoiLayout(root.optString("layout_id", "unknown"), all, occupancy, ocr);
        } catch (Exception error) {
            throw new IllegalStateException("failed to load ROI layout", error);
        }
    }

    private static void addObjectGroup(List<Roi> out, String group, JSONObject object) throws Exception {
        JSONArray names = object.names();
        if (names == null) return;
        for (int i = 0; i < names.length(); i += 1) {
            String name = names.getString(i);
            addSingle(out, group, name, -1, object.getJSONObject(name));
        }
    }

    private static void addArrayGroup(List<Roi> out, String group, String name, JSONArray array) throws Exception {
        for (int i = 0; i < array.length(); i += 1) {
            JSONObject object = array.getJSONObject(i);
            addSingle(out, group, name, object.optInt("slot", i), object);
        }
    }

    private static boolean isFastOcrRoi(Roi roi) {
        if ("phase".equals(roi.group)) {
            return "top_bar".equals(roi.name)
                    || "augment_trigger_text".equals(roi.name)
                    || "shop_band".equals(roi.name)
                    || "augment_cards".equals(roi.name);
        }
        if ("economy".equals(roi.group)) {
            return "level".equals(roi.name)
                    || "gold".equals(roi.name)
                    || "hp_scoreboard_candidate".equals(roi.name);
        }
        return false;
    }

    private static void addSingle(List<Roi> out, String group, String name, int slot, JSONObject object) {
        out.add(new Roi(
                group,
                name,
                slot,
                (float) object.optDouble("x"),
                (float) object.optDouble("y"),
                (float) object.optDouble("w"),
                (float) object.optDouble("h")
        ));
    }

    private static void addBoardSlots(List<Roi> out, JSONObject board) {
        float x = (float) board.optDouble("x");
        float y = (float) board.optDouble("y");
        float w = (float) board.optDouble("w");
        float h = (float) board.optDouble("h");
        int cols = 7;
        int rows = 4;
        float cellW = w / cols;
        float cellH = h / rows;
        float roiW = cellW * 0.62f;
        float roiH = cellH * 0.68f;
        for (int row = 0; row < rows; row += 1) {
            for (int col = 0; col < cols; col += 1) {
                int slot = row * cols + col;
                float cellX = x + (cellW * col);
                float cellY = y + (cellH * row);
                out.add(new Roi(
                        "board_slots",
                        "board_slot",
                        slot,
                        cellX + ((cellW - roiW) / 2.0f),
                        cellY + ((cellH - roiH) / 2.0f),
                        roiW,
                        roiH
                ));
            }
        }
    }

    private static String readAsset(Context context, String name) throws Exception {
        try (InputStream input = context.getAssets().open(name);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) >= 0) {
                output.write(buffer, 0, read);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }
}
