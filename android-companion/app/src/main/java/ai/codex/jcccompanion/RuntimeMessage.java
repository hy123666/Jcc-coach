package ai.codex.jcccompanion;

import org.json.JSONException;
import org.json.JSONObject;

final class RuntimeMessage {
    private RuntimeMessage() {
    }

    static String frameMeta(
            String matchSessionId,
            String captureSessionId,
            long frameSeq,
            long monotonicMs,
            String gamePackage,
            int width,
            int height,
            int orientation,
            long observedAtEpochMs
    ) throws JSONException {
        JSONObject root = base("frame_meta", matchSessionId, captureSessionId, frameSeq, monotonicMs, gamePackage, width, height, orientation, observedAtEpochMs);
        root.put("storage_policy", "no_frame_or_screenshot_persistence");
        root.put("payload_policy", "metadata_only_mvp");
        return root.toString();
    }

    static String heartbeat(
            String matchSessionId,
            String captureSessionId,
            long frameSeq,
            long monotonicMs,
            String gamePackage,
            int width,
            int height,
            int orientation,
            long observedAtEpochMs
    ) throws JSONException {
        JSONObject root = base("heartbeat", matchSessionId, captureSessionId, frameSeq, monotonicMs, gamePackage, width, height, orientation, observedAtEpochMs);
        root.put("status", "capturing");
        return root.toString();
    }

    static String semanticObservation(
            String matchSessionId,
            String captureSessionId,
            long frameSeq,
            long monotonicMs,
            String gamePackage,
            int width,
            int height,
            int orientation,
            long observedAtEpochMs,
            JSONObject observation
    ) throws JSONException {
        JSONObject root = base("semantic_observations", matchSessionId, captureSessionId, frameSeq, monotonicMs, gamePackage, width, height, orientation, observedAtEpochMs);
        root.put("observations", observation);
        root.put("promotion_status", "candidate_only");
        return root.toString();
    }

    static String captureStopped(
            String matchSessionId,
            String captureSessionId,
            long frameSeq,
            long monotonicMs,
            String gamePackage,
            int width,
            int height,
            int orientation,
            long observedAtEpochMs,
            String reason,
            String foregroundPackage
    ) throws JSONException {
        JSONObject root = base("capture_stopped", matchSessionId, captureSessionId, frameSeq, monotonicMs, gamePackage, width, height, orientation, observedAtEpochMs);
        root.put("reason", reason);
        root.put("foreground_package", foregroundPackage == null ? JSONObject.NULL : foregroundPackage);
        root.put("storage_policy", "no_frame_or_screenshot_persistence");
        return root.toString();
    }

    static String roiObservations(
            String matchSessionId,
            String captureSessionId,
            long frameSeq,
            long monotonicMs,
            String gamePackage,
            int width,
            int height,
            int orientation,
            long observedAtEpochMs,
            JSONObject observations
    ) throws JSONException {
        JSONObject root = base("roi_observations", matchSessionId, captureSessionId, frameSeq, monotonicMs, gamePackage, width, height, orientation, observedAtEpochMs);
        root.put("observations", observations);
        root.put("promotion_status", "candidate_only");
        return root.toString();
    }

    static String ocrTextBlocks(
            String matchSessionId,
            String captureSessionId,
            long frameSeq,
            long monotonicMs,
            String gamePackage,
            int width,
            int height,
            int orientation,
            long observedAtEpochMs,
            JSONObject blocks
    ) throws JSONException {
        JSONObject root = base("ocr_text_blocks", matchSessionId, captureSessionId, frameSeq, monotonicMs, gamePackage, width, height, orientation, observedAtEpochMs);
        root.put("blocks", blocks);
        root.put("promotion_status", "candidate_only");
        return root.toString();
    }

    static String mumuGiMessage(
            String matchSessionId,
            String captureSessionId,
            long frameSeq,
            long monotonicMs,
            String gamePackage,
            int width,
            int height,
            int orientation,
            long observedAtEpochMs,
            String pluginName,
            String params
    ) throws JSONException {
        JSONObject root = base("mumu_gi_message", matchSessionId, captureSessionId, frameSeq, monotonicMs, gamePackage, width, height, orientation, observedAtEpochMs);
        root.put("source", "mumu_nemuinit_bridge");
        root.put("plugin_name", pluginName);
        root.put("params", params);
        root.put("payload_policy", "structured_text_only_no_screenshot");
        root.put("promotion_status", "candidate_only_until_local_scope_proven");
        return root.toString();
    }

    private static JSONObject base(
            String type,
            String matchSessionId,
            String captureSessionId,
            long frameSeq,
            long monotonicMs,
            String gamePackage,
            int width,
            int height,
            int orientation,
            long observedAtEpochMs
    ) throws JSONException {
        JSONObject root = new JSONObject();
        root.put("schema", "jcc-android-companion-runtime-intake-v1");
        root.put("type", type);
        root.put("match_session_id", matchSessionId);
        root.put("capture_session_id", captureSessionId);
        root.put("frame_seq", frameSeq);
        root.put("monotonic_ms", monotonicMs);
        root.put("observed_at_epoch_ms", observedAtEpochMs);
        root.put("game_package", gamePackage);

        JSONObject resolution = new JSONObject();
        resolution.put("width", width);
        resolution.put("height", height);
        root.put("resolution", resolution);
        root.put("orientation", orientation);
        return root;
    }
}
