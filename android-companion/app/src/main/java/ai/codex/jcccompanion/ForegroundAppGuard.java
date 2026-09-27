package ai.codex.jcccompanion;

import android.app.AppOpsManager;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.os.Process;

final class ForegroundAppGuard {
    private final Context context;
    private final UsageStatsManager usageStatsManager;
    private final String ownPackage;

    ForegroundAppGuard(Context context) {
        this.context = context.getApplicationContext();
        this.usageStatsManager = (UsageStatsManager) context.getSystemService(Context.USAGE_STATS_SERVICE);
        this.ownPackage = context.getPackageName();
    }

    boolean hasUsageAccess() {
        AppOpsManager appOps = (AppOpsManager) context.getSystemService(Context.APP_OPS_SERVICE);
        int mode = appOps.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                ownPackage
        );
        return mode == AppOpsManager.MODE_ALLOWED;
    }

    String latestForegroundPackage(long lookbackMs) {
        if (!hasUsageAccess() || usageStatsManager == null) {
            return null;
        }
        long now = System.currentTimeMillis();
        long from = Math.max(0, now - Math.max(lookbackMs, 1000));
        UsageEvents events = usageStatsManager.queryEvents(from, now);
        UsageEvents.Event event = new UsageEvents.Event();
        String latest = null;
        long latestAt = 0;
        while (events.hasNextEvent()) {
            events.getNextEvent(event);
            if (event.getEventType() != UsageEvents.Event.MOVE_TO_FOREGROUND) {
                continue;
            }
            if (event.getTimeStamp() >= latestAt) {
                latestAt = event.getTimeStamp();
                latest = event.getPackageName();
            }
        }
        return latest;
    }
}
