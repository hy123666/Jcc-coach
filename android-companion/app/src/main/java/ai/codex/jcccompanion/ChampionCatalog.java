package ai.codex.jcccompanion;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.Charset;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

final class ChampionCatalog {
    static final class Hero {
        final String id;
        final String name;
        final int cost;

        Hero(String id, String name, int cost) {
            this.id = id;
            this.name = name;
            this.cost = cost;
        }
    }

    final List<Hero> heroes;

    private ChampionCatalog(List<Hero> heroes) {
        this.heroes = heroes;
    }

    static ChampionCatalog load(Context context) {
        try {
            JSONObject root = new JSONObject(readAsset(context, "jcc_catalog.json"));
            JSONArray array = root.getJSONArray("heroes");
            List<Hero> heroes = new ArrayList<>();
            for (int i = 0; i < array.length(); i += 1) {
                JSONObject row = array.getJSONObject(i);
                heroes.add(new Hero(row.getString("id"), normalizeName(row.getString("name")), row.optInt("cost", 0)));
            }
            return new ChampionCatalog(heroes);
        } catch (Exception error) {
            throw new IllegalStateException("failed to load champion catalog", error);
        }
    }

    private static String normalizeName(String value) {
        if (!looksLikeGbkMojibake(value)) {
            return value;
        }
        try {
            return new String(value.getBytes(Charset.forName("GB18030")), StandardCharsets.UTF_8);
        } catch (Exception ignored) {
            return value;
        }
    }

    private static boolean looksLikeGbkMojibake(String value) {
        return value.contains("澶")
                || value.contains("╃")
                || value.contains("绾")
                || value.contains("鍗")
                || value.contains("濞")
                || value.contains("鐟")
                || value.contains("");
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
