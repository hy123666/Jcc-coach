package ai.codex.jcccompanion;

import android.os.Binder;
import android.os.IBinder;
import android.os.Parcel;
import android.os.RemoteException;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONObject;

import java.lang.reflect.Method;
import java.util.concurrent.atomic.AtomicBoolean;

final class MuMuNemuInitBridge implements AutoCloseable {
    private static final String TAG = "JccMuMuBridge";
    private static final String NEMUINIT_SERVICE = "nemuinit";
    private static final String NEMUINIT_DESCRIPTOR = "android.INemuInit";
    private static final String CALLBACK_DESCRIPTOR = "android.INemuInitProxyCallback";
    private static final int TRANSACTION_SET_NEMU_INIT_PROXY_CALLBACK = 3;
    private static final int TRANSACTION_HANDLE_NEMU_INIT_MESSAGE = 1;
    private static final int INTERFACE_TRANSACTION = 1598968902;

    interface Sink {
        void emitStatus(String status, String detail, double confidence);

        void emitGiMessage(String pluginName, String params);
    }

    private final Sink sink;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private IBinder service;
    private CallbackBinder callback;

    MuMuNemuInitBridge(Sink sink) {
        this.sink = sink;
    }

    void start() {
        if (!running.compareAndSet(false, true)) {
            return;
        }
        try {
            service = getService(NEMUINIT_SERVICE);
            if (service == null) {
                sink.emitStatus("mumu_nemuinit_service_missing", "ServiceManager.getService(\"nemuinit\") returned null", 0.2);
                return;
            }
            callback = new CallbackBinder();
            Parcel data = Parcel.obtain();
            Parcel reply = Parcel.obtain();
            try {
                data.writeInterfaceToken(NEMUINIT_DESCRIPTOR);
                data.writeStrongBinder(callback);
                boolean transactOk = service.transact(TRANSACTION_SET_NEMU_INIT_PROXY_CALLBACK, data, reply, 0);
                if (!transactOk) {
                    sink.emitStatus("mumu_bridge_callback_transact_failed", "setNemuInitProxyCallback transact returned false", 0.35);
                    return;
                }
                reply.readException();
                sink.emitStatus("mumu_bridge_callback_registered", "setNemuInitProxyCallback transaction completed", 0.78);
            } finally {
                reply.recycle();
                data.recycle();
            }
        } catch (Throwable error) {
            sink.emitStatus("mumu_bridge_callback_register_error", error.getClass().getSimpleName() + ": " + String.valueOf(error.getMessage()), 0.32);
            Log.w(TAG, "MuMu bridge registration failed", error);
        }
    }

    private static IBinder getService(String name) throws Exception {
        Class<?> serviceManager = Class.forName("android.os.ServiceManager");
        Method getService = serviceManager.getDeclaredMethod("getService", String.class);
        return (IBinder) getService.invoke(null, name);
    }

    @Override
    public void close() {
        running.set(false);
        callback = null;
        service = null;
    }

    private final class CallbackBinder extends Binder {
        @Override
        protected boolean onTransact(int code, Parcel data, Parcel reply, int flags) throws RemoteException {
            if (code == INTERFACE_TRANSACTION) {
                reply.writeString(CALLBACK_DESCRIPTOR);
                return true;
            }
            if (code != TRANSACTION_HANDLE_NEMU_INIT_MESSAGE) {
                return super.onTransact(code, data, reply, flags);
            }
            data.enforceInterface(CALLBACK_DESCRIPTOR);
            String pluginName = data.readString();
            String params = data.readString();
            String result = "";
            try {
                if ("gi_plugin_jkchess".equals(pluginName)) {
                    sink.emitGiMessage(pluginName, params == null ? "" : params);
                    result = "ok";
                }
            } catch (Throwable error) {
                result = "";
                Log.w(TAG, "MuMu bridge callback handling failed", error);
            }
            if (reply != null) {
                reply.writeNoException();
                reply.writeString(result);
            }
            return true;
        }
    }

    static JSONObject statusPayload(String status, String detail, double confidence) throws Exception {
        JSONObject observation = new JSONObject();
        observation.put("kind", status);
        observation.put("detail", detail == null ? JSONObject.NULL : detail);
        observation.put("source", "mumu_nemuinit_bridge");
        observation.put("confidence", confidence);
        observation.put("monotonic_ms", SystemClock.elapsedRealtime());
        return observation;
    }
}
