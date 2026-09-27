package ai.codex.jcccompanion;

import android.util.Log;

import java.io.BufferedWriter;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

final class RuntimeEmitter implements AutoCloseable {
    private static final String TAG = "JccRuntimeEmitter";
    private static final int MAX_QUEUE_SIZE = 512;

    private final String host;
    private final int port;
    private final LinkedBlockingQueue<String> queue = new LinkedBlockingQueue<>(MAX_QUEUE_SIZE);
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private volatile boolean running;
    private Socket socket;
    private BufferedWriter writer;

    RuntimeEmitter(String host, int port) {
        this.host = host;
        this.port = port;
    }

    void start() {
        running = true;
        executor.submit(this::loop);
    }

    void emit(String jsonLine) {
        if (!running) {
            return;
        }
        if (!queue.offer(jsonLine)) {
            queue.poll();
            queue.offer(jsonLine);
        }
    }

    private void loop() {
        while (running) {
            try {
                ensureConnected();
                String line = queue.poll(1, TimeUnit.SECONDS);
                if (line != null) {
                    writer.write(line);
                    writer.write('\n');
                    writer.flush();
                }
            } catch (Exception error) {
                Log.w(TAG, "runtime emitter reconnecting after error", error);
                closeSocket();
                sleepQuietly(1000);
            }
        }
        closeSocket();
    }

    private void ensureConnected() throws IOException {
        if (socket != null && socket.isConnected() && !socket.isClosed()) {
            return;
        }
        socket = new Socket();
        socket.connect(new InetSocketAddress(host, port), 1500);
        writer = new BufferedWriter(new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8));
    }

    private void closeSocket() {
        if (writer != null) {
            try {
                writer.close();
            } catch (IOException ignored) {
            }
            writer = null;
        }
        if (socket != null) {
            try {
                socket.close();
            } catch (IOException ignored) {
            }
            socket = null;
        }
    }

    private static void sleepQuietly(long millis) {
        try {
            Thread.sleep(millis);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    @Override
    public void close() {
        running = false;
        executor.shutdownNow();
        closeSocket();
    }
}
