package ai.codex.jcccompanion;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.media.projection.MediaProjectionManager;
import android.os.Bundle;
import android.provider.Settings;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.UUID;

public class MainActivity extends Activity {
    private static final int REQUEST_CAPTURE = 8301;
    private static final String PREFS = "jcc_runtime_companion";
    private MediaProjectionManager projectionManager;
    private String pendingMatchSessionId;
    private String pendingCaptureSessionId;
    private EditText hostInput;
    private EditText portInput;
    private TextView status;
    private CheckBox mumuBridgeInput;
    private SharedPreferences prefs;
    private ForegroundAppGuard foregroundAppGuard;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        projectionManager = (MediaProjectionManager) getSystemService(MEDIA_PROJECTION_SERVICE);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        foregroundAppGuard = new ForegroundAppGuard(this);
        setContentView(buildLayout());
    }

    private LinearLayout buildLayout() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        root.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("JCC Runtime Companion");
        title.setTextSize(20);
        root.addView(title);

        TextView body = new TextView(this);
        body.setText("Starts a match-isolated MediaProjection session. Frames stay memory-only; the app streams structured runtime observations to the desktop agent.");
        body.setTextSize(14);
        body.setPadding(0, dp(12), 0, dp(12));
        root.addView(body);

        hostInput = new EditText(this);
        hostInput.setHint("Desktop host");
        hostInput.setSingleLine(true);
        hostInput.setText(prefs.getString("host", getString(getResources().getIdentifier("default_runtime_host", "string", getPackageName()))));
        root.addView(hostInput);

        portInput = new EditText(this);
        portInput.setHint("Desktop port");
        portInput.setSingleLine(true);
        portInput.setInputType(android.text.InputType.TYPE_CLASS_NUMBER);
        portInput.setText(String.valueOf(prefs.getInt("port", 49377)));
        root.addView(portInput);

        mumuBridgeInput = new CheckBox(this);
        mumuBridgeInput.setText("Enable MuMu NemuInit bridge probe");
        mumuBridgeInput.setChecked(prefs.getBoolean("enable_mumu_bridge", false));
        root.addView(mumuBridgeInput);

        Button start = new Button(this);
        start.setText("Start New Match Session");
        start.setOnClickListener(view -> requestCapture());
        root.addView(start);

        Button usageAccess = new Button(this);
        usageAccess.setText("Grant Game Exit Detection");
        usageAccess.setOnClickListener(view -> startActivity(new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)));
        root.addView(usageAccess);

        Button stop = new Button(this);
        stop.setText("Stop Capture");
        stop.setOnClickListener(view -> {
            stopService(new Intent(this, CaptureService.class));
            setStatus("Stopped. Start a new match session before the next game.");
        });
        root.addView(stop);

        status = new TextView(this);
        status.setTextSize(13);
        status.setPadding(0, dp(12), 0, 0);
        setStatus("Idle. Start a new match session for each game.");
        root.addView(status);
        return root;
    }

    private void requestCapture() {
        if (foregroundAppGuard != null && !foregroundAppGuard.hasUsageAccess()) {
            setStatus("Capture can start now. Game-exit auto stop needs Usage Access: tap Grant Game Exit Detection and enable JCC Companion when convenient.");
        }
        pendingMatchSessionId = "match:" + System.currentTimeMillis() + ":" + UUID.randomUUID();
        pendingCaptureSessionId = "capture:" + System.currentTimeMillis() + ":" + UUID.randomUUID();
        prefs.edit()
                .putString("host", hostInput.getText().toString().trim())
                .putInt("port", parsePort())
                .putBoolean("enable_mumu_bridge", mumuBridgeInput != null && mumuBridgeInput.isChecked())
                .apply();
        setStatus("Waiting for screen-capture authorization...\nmatch_session_id=" + pendingMatchSessionId);
        Intent request = projectionManager.createScreenCaptureIntent();
        startActivityForResult(request, REQUEST_CAPTURE);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_CAPTURE || resultCode != RESULT_OK || data == null) {
            return;
        }
        Intent service = new Intent(this, CaptureService.class);
        service.putExtra(CaptureService.EXTRA_RESULT_CODE, resultCode);
        service.putExtra(CaptureService.EXTRA_RESULT_DATA, data);
        service.putExtra(CaptureService.EXTRA_MATCH_SESSION_ID, pendingMatchSessionId);
        service.putExtra(CaptureService.EXTRA_CAPTURE_SESSION_ID, pendingCaptureSessionId);
        service.putExtra(CaptureService.EXTRA_EMIT_HOST, hostInput.getText().toString().trim());
        service.putExtra(CaptureService.EXTRA_EMIT_PORT, parsePort());
        service.putExtra(CaptureService.EXTRA_GAME_PACKAGE, "com.tencent.jkchess");
        service.putExtra(CaptureService.EXTRA_ENABLE_MUMU_BRIDGE, mumuBridgeInput != null && mumuBridgeInput.isChecked());
        startForegroundService(service);
        setStatus("Capturing and streaming structured observations.\nmatch_session_id=" + pendingMatchSessionId + "\ncapture_session_id=" + pendingCaptureSessionId);
    }

    private int dp(int value) {
        return (int) (value * getResources().getDisplayMetrics().density + 0.5f);
    }

    private int parsePort() {
        try {
            return Integer.parseInt(portInput.getText().toString().trim());
        } catch (Exception ignored) {
            return 49377;
        }
    }

    private void setStatus(String value) {
        if (status != null) {
            status.setText(value);
        }
    }
}
