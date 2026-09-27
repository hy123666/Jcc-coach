package ai.codex.jcccompanion;

import android.content.Context;
import android.content.res.AssetManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Rect;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

final class ChampionTemplateMatcher {
    private static final int HASH_SIZE = 8;
    private static final int DHASH_WIDTH = 9;
    private static final int DHASH_HEIGHT = 8;
    private static final int HIST_BINS = 4;
    private static final int TOP_K = 5;

    private static final class Template {
        final String id;
        final String name;
        final long averageHash;
        final long differenceHash;
        final double[] rgbHistogram;
        final int[] centerPixels;

        Template(String id, String name, Feature feature) {
            this.id = id;
            this.name = name;
            this.averageHash = feature.averageHash;
            this.differenceHash = feature.differenceHash;
            this.rgbHistogram = feature.rgbHistogram;
            this.centerPixels = feature.centerPixels;
        }
    }

    private static final class Feature {
        final long averageHash;
        final long differenceHash;
        final double[] rgbHistogram;
        final int[] centerPixels;

        Feature(long averageHash, long differenceHash, double[] rgbHistogram, int[] centerPixels) {
            this.averageHash = averageHash;
            this.differenceHash = differenceHash;
            this.rgbHistogram = rgbHistogram;
            this.centerPixels = centerPixels;
        }
    }

    private static final class Candidate {
        final Template template;
        final double score;
        final double hashScore;
        final double dHashScore;
        final double histogramScore;
        final double centerScore;
        final int hashDistance;
        final int dHashDistance;

        Candidate(Template template, double score, double hashScore, double dHashScore, double histogramScore, double centerScore, int hashDistance, int dHashDistance) {
            this.template = template;
            this.score = score;
            this.hashScore = hashScore;
            this.dHashScore = dHashScore;
            this.histogramScore = histogramScore;
            this.centerScore = centerScore;
            this.hashDistance = hashDistance;
            this.dHashDistance = dHashDistance;
        }
    }

    private final ChampionCatalog catalog;
    private final List<Template> templates = new ArrayList<>();

    ChampionTemplateMatcher(Context context) {
        catalog = ChampionCatalog.load(context);
        loadTemplates(context);
    }

    JSONObject match(Roi roi, Bitmap crop) throws JSONException {
        JSONObject json = new JSONObject();
        json.put("roi_group", roi.group);
        json.put("roi_name", roi.name);
        if (roi.slot >= 0) json.put("slot", roi.slot);
        json.put("catalog_hero_count", catalog.heroes.size());
        json.put("template_count", templates.size());
        json.put("matcher_version", "multi_feature_v2");
        json.put("crop_profile", cropProfile(roi));
        if (templates.isEmpty()) {
            json.put("identity_status", "no_templates");
            json.put("confidence", 0.0);
            return json;
        }

        Bitmap normalized = normalizeCrop(roi, crop);
        Feature feature = computeFeature(normalized);
        normalized.recycle();

        List<Candidate> candidates = new ArrayList<>();
        for (Template template : templates) {
            int hashDistance = Long.bitCount(feature.averageHash ^ template.averageHash);
            int dHashDistance = Long.bitCount(feature.differenceHash ^ template.differenceHash);
            double hashScore = 1.0 - (hashDistance / 64.0);
            double dHashScore = 1.0 - (dHashDistance / 64.0);
            double histogramScore = histogramSimilarity(feature.rgbHistogram, template.rgbHistogram);
            double centerScore = centerSimilarity(feature.centerPixels, template.centerPixels);
            double score = (hashScore * 0.30) + (dHashScore * 0.25) + (histogramScore * 0.25) + (centerScore * 0.20);
            insertCandidate(candidates, new Candidate(template, score, hashScore, dHashScore, histogramScore, centerScore, hashDistance, dHashDistance));
        }

        Candidate best = candidates.get(0);
        Candidate second = candidates.size() > 1 ? candidates.get(1) : null;
        double scoreMargin = second == null ? 0.0 : best.score - second.score;
        int distanceMargin = second == null ? 0 : second.hashDistance - best.hashDistance;
        String status = best.score >= minCandidateScore(roi) && scoreMargin >= 0.025 ? "candidate" : "low_confidence";

        json.put("identity_status", status);
        json.put("hero_id", best.template.id);
        json.put("hero_name", best.template.name);
        json.put("hash_distance", best.hashDistance);
        json.put("second_best_hash_distance", second == null ? JSONObject.NULL : second.hashDistance);
        json.put("hash_distance_margin", distanceMargin);
        json.put("dhash_distance", best.dHashDistance);
        json.put("combined_score", round(best.score));
        json.put("score_margin", round(scoreMargin));
        json.put("confidence", round(Math.max(0.0, Math.min(0.99, best.score))));
        json.put("feature_scores", scoresJson(best));
        json.put("top_candidates", candidatesJson(candidates));
        return json;
    }

    private void loadTemplates(Context context) {
        try {
            Map<String, ChampionCatalog.Hero> heroById = new HashMap<>();
            for (ChampionCatalog.Hero hero : catalog.heroes) {
                heroById.put(hero.id, hero);
            }
            AssetManager assets = context.getAssets();
            String[] files = assets.list("champion_icons");
            if (files == null) return;
            for (String file : files) {
                if (!file.endsWith(".png")) continue;
                String id = file.substring(0, file.length() - 4);
                ChampionCatalog.Hero hero = heroById.get(id);
                if (hero == null) continue;
                try (InputStream input = assets.open("champion_icons/" + file)) {
                    Bitmap bitmap = BitmapFactory.decodeStream(input);
                    if (bitmap == null) continue;
                    templates.add(new Template(hero.id, hero.name, computeFeature(bitmap)));
                    bitmap.recycle();
                }
            }
        } catch (Exception ignored) {
            templates.clear();
        }
    }

    private static Bitmap normalizeCrop(Roi roi, Bitmap crop) {
        Rect rect = contentRect(roi, crop.getWidth(), crop.getHeight());
        Bitmap content = Bitmap.createBitmap(crop, rect.left, rect.top, rect.width(), rect.height());
        Bitmap square = squareCenterCrop(content);
        content.recycle();
        Bitmap scaled = Bitmap.createScaledBitmap(square, 48, 48, true);
        square.recycle();
        return scaled;
    }

    private static Rect contentRect(Roi roi, int width, int height) {
        if ("shop_slots".equals(roi.group)) {
            return makeRect(width, height, 0.08f, 0.05f, 0.84f, 0.70f);
        }
        if ("bench_slots".equals(roi.group)) {
            return makeRect(width, height, 0.08f, 0.02f, 0.84f, 0.84f);
        }
        if ("board_slots".equals(roi.group)) {
            return makeRect(width, height, 0.12f, 0.00f, 0.76f, 0.78f);
        }
        return makeRect(width, height, 0.05f, 0.05f, 0.90f, 0.90f);
    }

    private static Rect makeRect(int width, int height, float x, float y, float w, float h) {
        int left = Math.max(0, Math.min(width - 1, Math.round(width * x)));
        int top = Math.max(0, Math.min(height - 1, Math.round(height * y)));
        int right = Math.max(left + 1, Math.min(width, Math.round(width * (x + w))));
        int bottom = Math.max(top + 1, Math.min(height, Math.round(height * (y + h))));
        return new Rect(left, top, right, bottom);
    }

    private static Bitmap squareCenterCrop(Bitmap source) {
        int side = Math.min(source.getWidth(), source.getHeight());
        int left = (source.getWidth() - side) / 2;
        int top = (source.getHeight() - side) / 2;
        return Bitmap.createBitmap(source, left, top, side, side);
    }

    private static Feature computeFeature(Bitmap source) {
        return new Feature(
                averageHash(source),
                differenceHash(source),
                rgbHistogram(source),
                centerPixels(source)
        );
    }

    private static long averageHash(Bitmap source) {
        Bitmap scaled = Bitmap.createScaledBitmap(source, HASH_SIZE, HASH_SIZE, true);
        int[] values = new int[HASH_SIZE * HASH_SIZE];
        int sum = 0;
        int index = 0;
        for (int y = 0; y < HASH_SIZE; y += 1) {
            for (int x = 0; x < HASH_SIZE; x += 1) {
                int color = scaled.getPixel(x, y);
                int gray = gray(color);
                values[index++] = gray;
                sum += gray;
            }
        }
        int avg = sum / values.length;
        long hash = 0;
        for (int i = 0; i < values.length; i += 1) {
            if (values[i] >= avg) hash |= (1L << i);
        }
        scaled.recycle();
        return hash;
    }

    private static long differenceHash(Bitmap source) {
        Bitmap scaled = Bitmap.createScaledBitmap(source, DHASH_WIDTH, DHASH_HEIGHT, true);
        long hash = 0;
        int bit = 0;
        for (int y = 0; y < DHASH_HEIGHT; y += 1) {
            for (int x = 0; x < DHASH_WIDTH - 1; x += 1) {
                if (gray(scaled.getPixel(x, y)) >= gray(scaled.getPixel(x + 1, y))) {
                    hash |= (1L << bit);
                }
                bit += 1;
            }
        }
        scaled.recycle();
        return hash;
    }

    private static double[] rgbHistogram(Bitmap source) {
        double[] histogram = new double[HIST_BINS * HIST_BINS * HIST_BINS];
        Bitmap scaled = Bitmap.createScaledBitmap(source, 32, 32, true);
        for (int y = 0; y < scaled.getHeight(); y += 1) {
            for (int x = 0; x < scaled.getWidth(); x += 1) {
                int color = scaled.getPixel(x, y);
                int r = Math.min(HIST_BINS - 1, Color.red(color) * HIST_BINS / 256);
                int g = Math.min(HIST_BINS - 1, Color.green(color) * HIST_BINS / 256);
                int b = Math.min(HIST_BINS - 1, Color.blue(color) * HIST_BINS / 256);
                histogram[(r * HIST_BINS * HIST_BINS) + (g * HIST_BINS) + b] += 1.0;
            }
        }
        scaled.recycle();
        double total = 32.0 * 32.0;
        for (int i = 0; i < histogram.length; i += 1) histogram[i] /= total;
        return histogram;
    }

    private static int[] centerPixels(Bitmap source) {
        Bitmap scaled = Bitmap.createScaledBitmap(source, 16, 16, true);
        int[] pixels = new int[16 * 16];
        int index = 0;
        for (int y = 0; y < 16; y += 1) {
            for (int x = 0; x < 16; x += 1) {
                pixels[index++] = scaled.getPixel(x, y);
            }
        }
        scaled.recycle();
        return pixels;
    }

    private static double histogramSimilarity(double[] a, double[] b) {
        double intersection = 0.0;
        for (int i = 0; i < a.length; i += 1) {
            intersection += Math.min(a[i], b[i]);
        }
        return Math.max(0.0, Math.min(1.0, intersection));
    }

    private static double centerSimilarity(int[] a, int[] b) {
        double total = 0.0;
        int count = Math.min(a.length, b.length);
        for (int i = 0; i < count; i += 1) {
            int dr = Color.red(a[i]) - Color.red(b[i]);
            int dg = Color.green(a[i]) - Color.green(b[i]);
            int db = Color.blue(a[i]) - Color.blue(b[i]);
            total += Math.sqrt((dr * dr) + (dg * dg) + (db * db));
        }
        double avg = count == 0 ? 441.0 : total / count;
        return Math.max(0.0, Math.min(1.0, 1.0 - (avg / 441.0)));
    }

    private static int gray(int color) {
        return (int) (0.299 * Color.red(color) + 0.587 * Color.green(color) + 0.114 * Color.blue(color));
    }

    private static void insertCandidate(List<Candidate> candidates, Candidate candidate) {
        for (int i = 0; i < candidates.size(); i += 1) {
            Candidate existing = candidates.get(i);
            if (!existing.template.name.equals(candidate.template.name)) continue;
            if (candidate.score > existing.score) {
                candidates.remove(i);
                insertCandidate(candidates, candidate);
            }
            return;
        }
        int index = 0;
        while (index < candidates.size() && candidates.get(index).score >= candidate.score) {
            index += 1;
        }
        candidates.add(index, candidate);
        if (candidates.size() > TOP_K) candidates.remove(candidates.size() - 1);
    }

    private static double minCandidateScore(Roi roi) {
        if ("shop_slots".equals(roi.group)) return 0.68;
        if ("bench_slots".equals(roi.group)) return 0.70;
        if ("board_slots".equals(roi.group)) return 0.70;
        return 0.70;
    }

    private static JSONObject scoresJson(Candidate candidate) throws JSONException {
        JSONObject json = new JSONObject();
        json.put("average_hash", round(candidate.hashScore));
        json.put("difference_hash", round(candidate.dHashScore));
        json.put("rgb_histogram", round(candidate.histogramScore));
        json.put("center_pixels", round(candidate.centerScore));
        return json;
    }

    private static JSONArray candidatesJson(List<Candidate> candidates) throws JSONException {
        JSONArray array = new JSONArray();
        for (Candidate candidate : candidates) {
            JSONObject json = new JSONObject();
            json.put("hero_id", candidate.template.id);
            json.put("hero_name", candidate.template.name);
            json.put("score", round(candidate.score));
            json.put("hash_distance", candidate.hashDistance);
            json.put("dhash_distance", candidate.dHashDistance);
            array.put(json);
        }
        return array;
    }

    private static String cropProfile(Roi roi) {
        if ("shop_slots".equals(roi.group)) return "shop_card_portrait_v2";
        if ("bench_slots".equals(roi.group)) return "bench_portrait_core_v2";
        if ("board_slots".equals(roi.group)) return "board_portrait_core_v2";
        return "generic_portrait_core_v2";
    }

    private static double round(double value) {
        return Math.round(value * 1000.0) / 1000.0;
    }
}
