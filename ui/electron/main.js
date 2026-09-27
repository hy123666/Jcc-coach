import { app, BrowserWindow, ipcMain, screen } from "electron";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { RuntimeDaemonClient } from "./runtime-daemon-client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const appUserModelId = "com.jcc.runtime";
const appLaunchId = randomUUID();
let mainWindow = null;
let runtimeDaemonClient = null;
let daemonEventForwarder = null;
let daemonSupervisorStarted = false;
let rendererRecoveryTimer = null;
let windowVisibilityTimer = null;
let mainWindowContentLoaded = false;
let windowActivationServer = null;
let cleanWindowClosePromise = null;
const windowVisibilityTimeoutMs = 8_000;
const windowActivationPipe = `\\\\.\\pipe\\jcc-runtime-ui-${os.userInfo().username.replace(/[^a-z0-9_.-]/gi, "_")}`;

// TESTABLE_CLEAN_WINDOW_CLOSE_START
async function runCleanWindowClose({ cleanup, stopDaemon, close }) {
  const cleanupResult = await cleanup();
  if (cleanupResult?.ok !== true) return cleanupResult || { ok: false, status: "runtime_cleanup_failed" };
  await stopDaemon();
  close();
  return {
    ...cleanupResult,
    ok: true,
    status: "window_closed_cleanly",
  };
}
// TESTABLE_CLEAN_WINDOW_CLOSE_END

async function closeWindowThroughRuntime(window) {
  if (cleanWindowClosePromise) return cleanWindowClosePromise;
  const client = getDaemonClient();
  cleanWindowClosePromise = runCleanWindowClose({
    cleanup: () => client.action("shutdown", { reason: "close_window" }),
    stopDaemon: () => client.stop(),
    close: () => window?.close(),
  });
  try {
    return await cleanWindowClosePromise;
  } finally {
    cleanWindowClosePromise = null;
  }
}

// TESTABLE_DAEMON_FORWARDER_START
function createRetryableDaemonEventForwarder({ ensureStarted, subscribe, onEvent, onError }) {
  let started = false;
  let startPromise = null;
  let eventLoopPromise = null;

  const reset = (error = null) => {
    started = false;
    startPromise = null;
    eventLoopPromise = null;
    if (error) onError?.(error);
  };

  return {
    async ensure() {
      if (started) return;
      if (startPromise) return startPromise;
      const attempt = (async () => {
        await ensureStarted();
        const loop = subscribe(onEvent);
        eventLoopPromise = Promise.resolve(loop);
        started = true;
        void eventLoopPromise.then(
          () => reset(),
          (error) => reset(error),
        );
      })();
      startPromise = attempt;
      try {
        await attempt;
      } catch (error) {
        reset(error);
        throw error;
      } finally {
        if (startPromise === attempt) startPromise = null;
      }
    },
    isStarted() {
      return started;
    },
  };
}
// TESTABLE_DAEMON_FORWARDER_END

function getDaemonClient() {
  if (!runtimeDaemonClient) {
    runtimeDaemonClient = new RuntimeDaemonClient({
      repoRoot: app.isPackaged ? process.resourcesPath : repoRoot,
      electronDir: app.isPackaged ? path.join(process.resourcesPath, "ui", "electron") : __dirname,
      log: writeRuntimeLog,
    });
  }
  return runtimeDaemonClient;
}

async function ensureDaemonEventForwarding() {
  if (!daemonSupervisorStarted) {
    daemonSupervisorStarted = true;
    getDaemonClient().startSupervisor({
      onReconnect: async (event) => {
        let bootstrap = null;
        try {
          bootstrap = await getDaemonClient().action("bootstrap", { app_launch_id: appLaunchId });
        } catch (error) {
          bootstrap = { ok: false, error: error?.message || String(error) };
        }
        writeRuntimeLog("daemon-reconnected", {
          ...event,
          bootstrap_ok: bootstrap?.ok === true,
        });
        mainWindow?.webContents.send("jcc-runtime:event", {
          schema: "jcc-runtime-daemon-event-v1",
          type: "daemon_reconnected",
          payload: {
            ...event,
            process_recovered: true,
            bootstrap_ok: bootstrap?.ok === true,
            bootstrap_error: bootstrap?.ok === false ? bootstrap.error || null : null,
          },
          observed_at: new Date().toISOString(),
        });
      },
    });
  }
  if (!daemonEventForwarder) {
    const client = getDaemonClient();
    daemonEventForwarder = createRetryableDaemonEventForwarder({
      ensureStarted: () => client.ensureStarted(),
      subscribe: (onEvent) => client.subscribe(onEvent),
      onEvent: (runtimeEvent) => {
        writeRuntimeLog("daemon-event", { type: runtimeEvent?.type || null });
        mainWindow?.webContents.send("jcc-runtime:event", runtimeEvent);
      },
      onError: (error) => {
        writeRuntimeLog("daemon-event-forwarding-failed", { error: error?.message || String(error) });
      },
    });
  }
  await daemonEventForwarder.ensure();
}

function writeRuntimeLog(event, payload = {}) {
  const logDir = path.join(os.tmpdir(), "jcc-runtime-ui");
  fs.mkdirSync(logDir, { recursive: true });
  fs.appendFileSync(
    path.join(logDir, "electron.log"),
    `${new Date().toISOString()} ${JSON.stringify({ event, ...payload })}\n`,
    "utf8"
  );
}

function loadMainWindowContent(reason = "initial") {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (process.env.VITE_DEV_SERVER_URL) {
    writeRuntimeLog("load-url", { url: process.env.VITE_DEV_SERVER_URL, reason });
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    const file = path.join(__dirname, "../dist/index.html");
    writeRuntimeLog("load-file", { file, reason });
    mainWindow.loadFile(file);
  }
}

function recoverRenderer(reason, details = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (rendererRecoveryTimer) return;
  writeRuntimeLog("renderer-recovery-scheduled", { reason, details });
  rendererRecoveryTimer = setTimeout(() => {
    rendererRecoveryTimer = null;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    loadMainWindowContent(`renderer-recovery:${reason}`);
  }, 500);
}

function clearWindowVisibilityTimer() {
  if (!windowVisibilityTimer) return;
  clearTimeout(windowVisibilityTimer);
  windowVisibilityTimer = null;
}

function revealMainWindow(reason) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  clearWindowVisibilityTimer();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  writeRuntimeLog("window-visible", {
    reason,
    visible: mainWindow.isVisible(),
    focused: mainWindow.isFocused(),
  });
  return mainWindow.isVisible();
}

function startWindowActivationServer() {
  if (windowActivationServer) return;
  windowActivationServer = net.createServer((socket) => {
    let request = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.setTimeout(3_000, () => socket.destroy());
    socket.on("data", (chunk) => {
      if (handled) return;
      request += chunk;
      if (!request.includes("\n")) return;
      handled = true;
      if (request.split("\n", 1)[0].trim() !== "activate") {
        socket.end(`${JSON.stringify({ ok: false, error: "unsupported_activation_request" })}\n`);
        return;
      }
      const visible = revealMainWindow("desktop-launcher-activation");
      socket.end(`${JSON.stringify({
        ok: visible,
        visible,
        focused: mainWindow?.isFocused?.() || false,
        pid: process.pid,
      })}\n`);
    });
    socket.on("error", (error) => {
      writeRuntimeLog("window-activation-socket-error", { error: error?.message || String(error) });
    });
  });
  windowActivationServer.on("error", (error) => {
    writeRuntimeLog("window-activation-server-error", { error: error?.message || String(error) });
  });
  windowActivationServer.listen(windowActivationPipe, () => {
    writeRuntimeLog("window-activation-server-ready", { pipe: windowActivationPipe });
  });
}

function stopWindowActivationServer() {
  const server = windowActivationServer;
  windowActivationServer = null;
  try { server?.close(); } catch {}
}

function armWindowVisibilityFallback() {
  clearWindowVisibilityTimer();
  windowVisibilityTimer = setTimeout(() => {
    windowVisibilityTimer = null;
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isVisible()) return;
    writeRuntimeLog("window-visibility-fallback", {
      content_loaded: mainWindowContentLoaded,
      loading_main_frame: mainWindow.webContents.isLoadingMainFrame(),
    });
    if (!mainWindowContentLoaded) {
      mainWindow.webContents.stop();
      loadMainWindowContent("window-visibility-timeout");
    }
    revealMainWindow("window-visibility-timeout");
  }, windowVisibilityTimeoutMs);
}

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const width = 396;
  const height = Math.min(980, workArea.height - 48);

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 340,
    maxWidth: 460,
    minHeight: 640,
    x: workArea.x + workArea.width - width - 24,
    y: workArea.y + 24,
    frame: false,
    show: false,
    alwaysOnTop: false,
    title: "JCC Runtime Sidecar",
    icon: path.join(__dirname, "../assets/jcc-runtime.png"),
    backgroundColor: "#080b10",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js")
    }
  });

  mainWindowContentLoaded = false;
  armWindowVisibilityFallback();

  mainWindow.once("ready-to-show", () => {
    writeRuntimeLog("ready-to-show");
    revealMainWindow("ready-to-show");
  });

  mainWindow.on("closed", () => {
    clearWindowVisibilityTimer();
    if (rendererRecoveryTimer) {
      clearTimeout(rendererRecoveryTimer);
      rendererRecoveryTimer = null;
    }
    mainWindow = null;
  });

  mainWindow.webContents.on("did-finish-load", async () => {
    mainWindowContentLoaded = true;
    revealMainWindow("did-finish-load");
    try {
      const rendererState = await mainWindow.webContents.executeJavaScript(`
        ({
          href: location.href,
          rootChildCount: document.getElementById("root")?.childElementCount ?? 0,
          hasAppShell: !!document.querySelector(".app-shell"),
          hasClosedPreview: !!document.querySelector(".closed-preview"),
          hasJccRuntime: !!window.jccRuntime,
          bodyText: document.body.innerText.slice(0, 180)
        })
      `);
      writeRuntimeLog("did-finish-load", { rendererState });
    } catch (error) {
      writeRuntimeLog("did-finish-load-inspection-failed", { error: error?.message || String(error) });
    }
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    writeRuntimeLog("did-fail-load", { errorCode, errorDescription, validatedURL });
    revealMainWindow("did-fail-load");
    recoverRenderer("did-fail-load", { errorCode, errorDescription, validatedURL });
  });

  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    writeRuntimeLog("render-process-gone", { details });
    if (details?.reason !== "clean-exit") {
      recoverRenderer("render-process-gone", details);
    }
  });

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    writeRuntimeLog("renderer-console", { level, message, line, sourceId });
  });

  loadMainWindowContent();
}

ipcMain.handle("jcc-runtime:action", async (event, action, payload) => {
  try {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (action === "closeWindow") {
      await ensureDaemonEventForwarding();
      return closeWindowThroughRuntime(window);
    }
    if (action === "minimizeWindow") {
      window?.minimize?.();
      return { ok: true, status: window?.minimize ? "minimized" : "preview_noop" };
    }
    if (action === "restartRuntimeDaemon") {
      const client = getDaemonClient();
      await client.restart();
      await ensureDaemonEventForwarding();
      return {
        ok: true,
        status: "runtime_daemon_restarted",
        daemon: client.info || null,
      };
    }
    await ensureDaemonEventForwarding();
    return await getDaemonClient().action(action, action === "bootstrap"
      ? { ...payload, app_launch_id: appLaunchId }
      : payload);
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error),
    };
  }
});

app.setAppUserModelId(appUserModelId);
const ownsSingleInstance = app.requestSingleInstanceLock();

if (!ownsSingleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      return;
    }
    revealMainWindow("second-instance");
  });

  app.whenReady().then(() => {
    if (app.isPackaged) {
      process.env.JCC_RUNTIME_REPO_ROOT = process.resourcesPath;
      process.env.JCC_OCR_PYTHON ||= path.join(process.resourcesPath, "ocr", "python", "python.exe");
      process.env.JCC_ADB ||= path.join(process.resourcesPath, "adb", "adb.exe");
      process.env.JCC_RUNTIME_DATA_DIR ||= path.join(app.getPath("userData"), "runtime-data");
    }
    startWindowActivationServer();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  stopWindowActivationServer();
  runtimeDaemonClient?.stopEvents?.();
  runtimeDaemonClient?.stop?.();
});
