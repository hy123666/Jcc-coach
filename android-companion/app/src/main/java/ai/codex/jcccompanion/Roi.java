package ai.codex.jcccompanion;

import android.graphics.Rect;

import org.json.JSONException;
import org.json.JSONObject;

final class Roi {
    final String group;
    final String name;
    final int slot;
    final float x;
    final float y;
    final float w;
    final float h;

    Roi(String group, String name, int slot, float x, float y, float w, float h) {
        this.group = group;
        this.name = name;
        this.slot = slot;
        this.x = x;
        this.y = y;
        this.w = w;
        this.h = h;
    }

    Rect toRect(int width, int height) {
        int left = clamp(Math.round(x * width), 0, width - 1);
        int top = clamp(Math.round(y * height), 0, height - 1);
        int right = clamp(Math.round((x + w) * width), left + 1, width);
        int bottom = clamp(Math.round((y + h) * height), top + 1, height);
        return new Rect(left, top, right, bottom);
    }

    JSONObject toJson() throws JSONException {
        JSONObject json = new JSONObject();
        json.put("group", group);
        json.put("name", name);
        if (slot >= 0) json.put("slot", slot);
        json.put("x", x);
        json.put("y", y);
        json.put("w", w);
        json.put("h", h);
        return json;
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }
}
