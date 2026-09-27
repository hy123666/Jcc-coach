package ai.codex.jcccompanion;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.res.Configuration;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.util.Log;
import android.view.WindowManager;

import org.json.JSONObject;

import java.util.concurrent.atomic.AtomicLong;

public class CaptureService extends Service {
    static final String EXTRA_RESULT_CODE = "result_code";
    static final String EXTRA_RESULT_DATA = "result_data";
    static final String EXTRA_MATCH_SESSION_ID = "match_session_id";
    static final String EXTRA_CAPTURE_SESSION_ID = "capture_session_id";
    static final String EXTRA_EMIT_HOST = "emit_host";
    static final String EXTRA_EMIT_PORT = "emit_port";
    static final String EXTRA_GAME_PACKAGE = "game_package";
    static final String EXTRA_ENABLE_MUMU_BRIDGE = "enable_mumu_bridge";

    private static final String TAG = "JccCaptureService";
    private static final String CHANNEL_ID = "jcc-runtime-capture";
    private static final int NOTIFICATION_ID = 8302;
    private static final int MAX_IMAGES = 2;
    private static final long FOREGROUND_GUARD_PERIOD_MS = 2000;
    private static final long FOREGROUND_GUARD_LOOKBACK_MS = 8000;
    private static final long FOREGROUND_GUARD_START_GRACE_MS = 25000;
    private static final long FOREGROUND_EXIT_GRACE_MS = 12000;

    private HandlerThread captureThread;
    private Handler captureHandler;
    private MediaProjection projection;
    private VirtualDisplay virtualDisplay;
    private ImageReader imageReader;
    private RuntimeEmitter emitter;
    private FrameAnalyzer frameAnalyzer;
    private final AtomicLong frameSeq = new AtomicLong();
    private String matchSessionId;
    private String captureSessionId;
    private String gamePackage;
    private int width;
    private int height;
    private int densityDpi;
    private ForegroundAppGuard foregroundAppGuard;
    private MuMuNemuInitBridge muMuBridge;
    private long captureStartedAtMs;
    private boolean targetGameSeenInForeground;
    private long targetGameLeftAtMs;
    private boolean foregroundGuardUnavailableReported;
    private final Runnable foregroundGuardTick = new Runnable() {
        @Override
        public void run() {
            checkForegroundGame();
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        startForeground(NOTIFICATION_ID, buildNotification());
        startCapture(intent);
        return START_STICKY;
    }

    private void startCapture(Intent intent) {
        stopCapture();
        matchSessionId = intent.getStringExtra(EXTRA_MATCH_SESSION_ID);
        captureSessionId = intent.getStringExtra(EXTRA_CAPTURE_SESSION_ID);
        gamePackage = intent.getStringExtra(EXTRA_GAME_PACKAGE);
        if (gamePackage == null || gamePackage.isEmpty()) {
            gamePackage = "unknown";
        }
        String host = valueOr(intent.getStringExtra(EXTRA_EMIT_HOST), "10.0.2.2");
        int port = intent.getIntExtra(EXTRA_EMIT_PORT, 49377);
        boolean enableMuMuBridge = intent.getBooleanExtra(EXTRA_ENABLE_MUMU_BRIDGE, false);

        captureThread = new HandlerThread("jcc-capture");
        captureThread.start();
        captureHandler = new Handler(captureThread.getLooper());
        emitter = new RuntimeEmitter(host, port);
        emitter.start();
        frameAnalyzer = new FrameAnalyzer(this);
        foregroundAppGuard = new ForegroundAppGuard(this);
        captureStartedAtMs = SystemClock.elapsedRealtime();
        targetGameSeenInForeground = false;
        targetGameLeftAtMs = 0;
        foregroundGuardUnavailableReported = false;
        if (enableMuMuBridge) {
            muMuBridge = new MuMuNemuInitBridge(new MuMuNemuInitBridge.Sink() {
                @Override
                public void emitStatus(String status, String detail, double confidence) {
                    emitMuMuBridgeStatus(status, detail, confidence);
                }

                @Override
                public void emitGiMessage(String pluginName, String params) {
                    emitMuMuGiMessage(pluginName, params);
                }
            });
            muMuBridge.start();
        } else {
            emitMuMuBridgeStatus("mumu_bridge_disabled", "Enable explicitly only when testing MuMu NemuInit callback access.", 1.0);
        }

        DisplayMetrics metrics = new DisplayMetrics();
        WindowManager windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
        windowManager.getDefaultDisplay().getRealMetrics(metrics);
        width = metrics.widthPixels;
        height = metrics.heightPixels;
        densityDpi = metrics.densityDpi;

        int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0);
        Intent resultData = intent.getParcelableExtra(EXTRA_RESULT_DATA);
        MediaProjectionManager projectionManager = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        projection = projectionManager.getMediaProjection(resultCode, resultData);
        if (projection == null) {
            stopSelf();
            return;
        }
        projection.registerCallback(new MediaProjection.Callback() {
            @Override
            public void onStop() {
                stopCapture();
            }
        }, captureHandler);

        imageReader = ImageReader.newInstance(width, height, android.graphics.PixelFormat.RGBA_8888, MAX_IMAGES);
        imageReader.setOnImageAvailableListener(this::onImageAvailable, captureHandler);
        virtualDisplay = projection.createVirtualDisplay(
                "jcc-runtime-capture",
                width,
                height,
                densityDpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                imageReader.getSurface(),
                null,
                captureHandler
        );
        captureHandler.postDelayed(foregroundGuardTick, FOREGROUND_GUARD_PERIOD_MS);
    }

    private void onImageAvailable(ImageReader reader) {
        Image image = null;
        try {
            image = reader.acquireLatestImage();
            if (image == null) {
                return;
            }
            long seq = frameSeq.incrementAndGet();
            long now = System.currentTimeMillis();
            long monotonic = SystemClock.elapsedRealtime();
            int orientation = getResources().getConfiguration().orientation == Configuration.ORIENTATION_LANDSCAPE ? 90 : 0;
            emitter.emit(RuntimeMessage.frameMeta(matchSessionId, captureSessionId, seq, monotonic, gamePackage, width, height, orientation, now));
            if (frameAnalyzer != null) {
                frameAnalyzer.analyze(image, seq, new FrameAnalyzer.Emitter() {
                    @Override
                    public void emitRoi(JSONObject observations) {
                        try {
                            emitter.emit(RuntimeMessage.roiObservations(matchSessionId, captureSessionId, seq, monotonic, gamePackage, width, height, orientation, now, observations));
                        } catch (Exception error) {
                            Log.w(TAG, "ROI emit failed", error);
                        }
                    }

                    @Override
                    public void emitOcr(JSONObject blocks) {
                        try {
                            emitter.emit(RuntimeMessage.ocrTextBlocks(matchSessionId, captureSessionId, seq, monotonic, gamePackage, width, height, orientation, System.currentTimeMillis(), blocks));
                        } catch (Exception error) {
                            Log.w(TAG, "OCR emit failed", error);
                        }
                    }
                });
            }
            if (seq == 1 || seq % 60 == 0) {
                emitter.emit(RuntimeMessage.heartbeat(matchSessionId, captureSessionId, seq, monotonic, gamePackage, width, height, orientation, now));
            }
            if (seq == 1) {
                JSONObject observation = new JSONObject();
                observation.put("kind", "capture_started");
                observation.put("confidence", 1.0);
                emitter.emit(RuntimeMessage.semanticObservation(matchSessionId, captureSessionId, seq, monotonic, gamePackage, width, height, orientation, now, observation));
            }
        } catch (Exception error) {
            Log.w(TAG, "frame handling failed", error);
        } finally {
            if (image != null) {
                image.close();
            }
        }
    }

    private void checkForegroundGame() {
        if (captureHandler == null || foregroundAppGuard == null) {
            return;
        }
        if (!foregroundAppGuard.hasUsageAccess()) {
            if (!foregroundGuardUnavailableReported) {
                emitForegroundGuardStatus("foreground_guard_unavailable_usage_access_required", null, 0.45);
                foregroundGuardUnavailableReported = true;
            }
            captureHandler.postDelayed(foregroundGuardTick, FOREGROUND_GUARD_PERIOD_MS);
            return;
        }
        String foregroundPackage = foregroundAppGuard.latestForegroundPackage(FOREGROUND_GUARD_LOOKBACK_MS);
        long elapsed = SystemClock.elapsedRealtime() - captureStartedAtMs;
        if (gamePackage != null && gamePackage.equals(foregroundPackage)) {
            targetGameSeenInForeground = true;
            targetGameLeftAtMs = 0;
            emitForegroundGuardStatus("target_game_foreground", foregroundPackage, 0.88);
            captureHandler.postDelayed(foregroundGuardTick, FOREGROUND_GUARD_PERIOD_MS);
            return;
        }
        if (elapsed < FOREGROUND_GUARD_START_GRACE_MS || !targetGameSeenInForeground) {
            captureHandler.postDelayed(foregroundGuardTick, FOREGROUND_GUARD_PERIOD_MS);
            return;
        }
        if (targetGameLeftAtMs == 0) {
            targetGameLeftAtMs = SystemClock.elapsedRealtime();
            emitForegroundGuardStatus("target_game_left_foreground_candidate", foregroundPackage, 0.72);
            captureHandler.postDelayed(foregroundGuardTick, FOREGROUND_GUARD_PERIOD_MS);
            return;
        }
        if (SystemClock.elapsedRealtime() - targetGameLeftAtMs < FOREGROUND_EXIT_GRACE_MS) {
            captureHandler.postDelayed(foregroundGuardTick, FOREGROUND_GUARD_PERIOD_MS);
            return;
        }
        emitCaptureStopped("target_game_left_foreground", foregroundPackage);
        stopSelf();
    }

    private void emitForegroundGuardStatus(String kind, String foregroundPackage, double confidence) {
        if (emitter == null) {
            return;
        }
        try {
            JSONObject observation = new JSONObject();
            observation.put("kind", kind);
            observation.put("foreground_package", foregroundPackage == null ? JSONObject.NULL : foregroundPackage);
            observation.put("target_game_package", gamePackage);
            observation.put("confidence", confidence);
            emitter.emit(RuntimeMessage.semanticObservation(
                    matchSessionId,
                    captureSessionId,
                    frameSeq.get(),
                    SystemClock.elapsedRealtime(),
                    gamePackage,
                    width,
                    height,
                    getOrientation(),
                    System.currentTimeMillis(),
                    observation
            ));
        } catch (Exception error) {
            Log.w(TAG, "foreground guard status emit failed", error);
        }
    }

    private void emitMuMuBridgeStatus(String status, String detail, double confidence) {
        if (emitter == null) {
            return;
        }
        try {
            emitter.emit(RuntimeMessage.semanticObservation(
                    matchSessionId,
                    captureSessionId,
                    frameSeq.get(),
                    SystemClock.elapsedRealtime(),
                    gamePackage,
                    width,
                    height,
                    getOrientation(),
                    System.currentTimeMillis(),
                    MuMuNemuInitBridge.statusPayload(status, detail, confidence)
            ));
        } catch (Exception error) {
            Log.w(TAG, "MuMu bridge status emit failed", error);
        }
    }

    private void emitMuMuGiMessage(String pluginName, String params) {
        if (emitter == null) {
            return;
        }
        try {
            emitter.emit(RuntimeMessage.mumuGiMessage(
                    matchSessionId,
                    captureSessionId,
                    frameSeq.get(),
                    SystemClock.elapsedRealtime(),
                    gamePackage,
                    width,
                    height,
                    getOrientation(),
                    System.currentTimeMillis(),
                    pluginName,
                    params
            ));
        } catch (Exception error) {
            Log.w(TAG, "MuMu GI message emit failed", error);
        }
    }

    private void emitCaptureStopped(String reason, String foregroundPackage) {
        if (emitter == null) {
            return;
        }
        try {
            emitter.emit(RuntimeMessage.captureStopped(
                    matchSessionId,
                    captureSessionId,
                    frameSeq.get(),
                    SystemClock.elapsedRealtime(),
                    gamePackage,
                    width,
                    height,
                    getOrientation(),
                    System.currentTimeMillis(),
                    reason,
                    foregroundPackage
            ));
        } catch (Exception error) {
            Log.w(TAG, "capture stopped emit failed", error);
        }
    }

    private int getOrientation() {
        return getResources().getConfiguration().orientation == Configuration.ORIENTATION_LANDSCAPE ? 90 : 0;
    }

    private void stopCapture() {
        if (captureHandler != null) {
            captureHandler.removeCallbacks(foregroundGuardTick);
        }
        if (virtualDisplay != null) {
            virtualDisplay.release();
            virtualDisplay = null;
        }
        if (imageReader != null) {
            imageReader.close();
            imageReader = null;
        }
        if (projection != null) {
            projection.stop();
            projection = null;
        }
        if (emitter != null) {
            emitter.close();
            emitter = null;
        }
        if (frameAnalyzer != null) {
            frameAnalyzer.close();
            frameAnalyzer = null;
        }
        if (muMuBridge != null) {
            muMuBridge.close();
            muMuBridge = null;
        }
        if (captureThread != null) {
            captureThread.quitSafely();
            captureThread = null;
            captureHandler = null;
        }
    }

    @Override
    public void onDestroy() {
        stopCapture();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private Notification buildNotification() {
        return new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(getApplicationInfo().icon == 0 ? android.R.drawable.presence_video_online : getApplicationInfo().icon)
                .setContentTitle(getString(getResources().getIdentifier("capture_notification_title", "string", getPackageName())))
                .setContentText(getString(getResources().getIdentifier("capture_notification_text", "string", getPackageName())))
                .setOngoing(true)
                .build();
    }

    private void createNotificationChannel() {
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, getString(getResources().getIdentifier("capture_channel_name", "string", getPackageName())), NotificationManager.IMPORTANCE_LOW);
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(channel);
    }

    private static String valueOr(String value, String fallback) {
        return value == null || value.isEmpty() ? fallback : value;
    }
}
