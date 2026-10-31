package com.openviewer.syncendpoint;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * The receiving end of the device-sync tunnel.
 *
 * <p>The phone opens a small HTTP endpoint on the LAN. Every body it accepts is
 * AES-256-GCM ciphertext, keyed with HKDF-SHA256 over the one-time pairing
 * secret — the endpoint serves whoever holds the secret and nobody else. Files
 * that arrive are written into the app's private storage, ready for the reader.
 */
@CapacitorPlugin(name = "SyncEndpoint")
public class SyncEndpointPlugin extends Plugin {

    private static final String PREFS = "emaki-sync-endpoint";
    private static final String KEY_COMPUTER_NAME = "computerName";
    private static final String KEY_COMPUTER_ID = "computerId";
    private static final String KEY_MODE = "mode";
    private static final String KEY_BOOKS = "books";

    /** Key-derivation parameters — must match {@code pairing.crypto.ts}. */
    static final String KEY_SALT = "emaki-pair-v1";
    static final String KEY_CONTROL = "emaki-sync-control";
    static final String KEY_FILES = "emaki-sync-files";

    private static final long PAIRING_TTL_MS = 15 * 60 * 1000L;

    private EndpointServer server;

    /** Open the endpoint and hand out a one-time pairing payload. */
    @PluginMethod
    public void start(PluginCall call) {
        try {
            stopQuietly();
            String mode = call.getString("mode", "home-network");
            EndpointServer endpoint = new EndpointServer(getContext(), mode, this::storePairing);
            server = endpoint;
            Payload payload = endpoint.start();
            JSObject result = new JSObject();
            result.put("id", endpoint.getDeviceId());
            result.put("name", deviceName());
            result.put("host", payload.host);
            result.put("port", payload.port);
            result.put("secret", Base64.encodeToString(endpoint.getSecret(), Base64.NO_WRAP));
            result.put("payload", payload.encoded);
            result.put("expiresAt", payload.expiresAt);
            call.resolve(result);
        } catch (Exception err) {
            call.reject("endpoint_failed: " + err.getMessage());
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopQuietly();
        call.resolve();
    }

    /** What the receiver currently knows: the paired computer and the books. */
    @PluginMethod
    public void status(PluginCall call) {
        try {
            SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            JSObject result = new JSObject();
            result.put("paired", prefs.getString(KEY_COMPUTER_NAME, null) != null);
            result.put("computerName", prefs.getString(KEY_COMPUTER_NAME, null));
            result.put("books", new JSONArray(prefs.getString(KEY_BOOKS, "[]")));
            call.resolve(result);
        } catch (Exception err) {
            call.reject("status_failed: " + err.getMessage());
        }
    }

    /** Forget the paired computer and the received books. */
    @PluginMethod
    public void forget(PluginCall call) {
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
        deleteRecursively(new File(syncedRoot()));
        call.resolve();
    }

    private void storePairing(Pairing pairing) {
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_COMPUTER_NAME, pairing.computerName)
                .putString(KEY_COMPUTER_ID, pairing.computerId)
                .putString(KEY_MODE, pairing.mode)
                .apply();
    }

    private String syncedRoot() {
        return getContext().getFilesDir() + "/emaki/synced";
    }

    private static String deviceName() {
        String model = Build.MODEL;
        return (model == null || model.isBlank()) ? "This phone" : model;
    }

    private void stopQuietly() {
        if (server != null) {
            server.close();
            server = null;
        }
    }

    @Override
    protected void handleOnDestroy() {
        stopQuietly();
        super.handleOnDestroy();
    }

    /** A computer that asked to be paired. */
    static final class Pairing {
        final String computerName;
        final String computerId;
        final String mode;

        Pairing(String computerName, String computerId, String mode) {
            this.computerName = computerName;
            this.computerId = computerId;
            this.mode = mode;
        }
    }

    /** What {@code start()} hands back to the web layer. */
    static final class Payload {
        final String host;
        final int port;
        final long expiresAt;
        final String encoded;

        Payload(String host, int port, long expiresAt, String encoded) {
            this.host = host;
            this.port = port;
            this.expiresAt = expiresAt;
            this.encoded = encoded;
        }
    }

    /**
     * A minimal HTTP/1.1 server. It only serves a handful of routes for one
     * client at a time, so a hand-rolled socket loop is enough — and it keeps
     * the plugin dependency-free.
     */
    static final class EndpointServer {

        private final Context context;
        private final String mode;
        private final java.util.function.Consumer<Pairing> onPair;

        private final String deviceId = UUID.randomUUID().toString();
        private final byte[] secret = new byte[32];
        private final SecureRandom random = new SecureRandom();

        private ServerSocket serverSocket;
        private ExecutorService pool;
        private volatile String pairedComputerId;
        private final Map<String, String> pendingBooks = new HashMap<>();

        EndpointServer(Context context, String mode, java.util.function.Consumer<Pairing> onPair) {
            this.context = context;
            this.mode = mode;
            this.onPair = onPair;
            random.nextBytes(secret);
        }

        String getDeviceId() {
            return deviceId;
        }

        byte[] getSecret() {
            return secret;
        }

        Payload start() throws IOException {
            ServerSocket socket = new ServerSocket(0);
            serverSocket = socket;
            pool = Executors.newFixedThreadPool(4);
            pool.submit(() -> acceptLoop(socket));

            String host = lanAddress();
            if (host == null) {
                host = "127.0.0.1";
            }
            long expiresAt = System.currentTimeMillis() + PAIRING_TTL_MS;
            return new Payload(host, socket.getLocalPort(), expiresAt,
                    encodePayload(host, socket.getLocalPort(), expiresAt));
        }

        void close() {
            try {
                if (serverSocket != null) {
                    serverSocket.close();
                }
            } catch (IOException ignored) {
                // Closing a closed socket is fine.
            }
            if (pool != null) {
                pool.shutdownNow();
            }
        }

        private void acceptLoop(ServerSocket socket) {
            while (!socket.isClosed()) {
                try {
                    Socket client = socket.accept();
                    pool.submit(() -> handle(client));
                } catch (IOException err) {
                    if (socket.isClosed()) {
                        return;
                    }
                }
            }
        }

        private void handle(Socket client) {
            try (Socket sock = client) {
                sock.setSoTimeout(30_000);
                InputStream input = sock.getInputStream();
                OutputStream output = new BufferedOutputStream(sock.getOutputStream());

                String requestLine = readLine(input);
                if (requestLine == null) {
                    return;
                }
                String[] parts = requestLine.split(" ");
                if (parts.length < 2) {
                    return;
                }
                String method = parts[0];
                String path = parts[1];

                Map<String, String> headers = new HashMap<>();
                while (true) {
                    String line = readLine(input);
                    if (line == null) {
                        return;
                    }
                    if (line.isEmpty()) {
                        break;
                    }
                    int idx = line.indexOf(':');
                    if (idx > 0) {
                        headers.put(line.substring(0, idx).trim().toLowerCase(Locale.ROOT),
                                line.substring(idx + 1).trim());
                    }
                }

                if ("OPTIONS".equalsIgnoreCase(method)) {
                    respond(output, 204, null);
                    return;
                }

                if (!isAllowedNetwork(sourceAddress(sock))) {
                    respond(output, 403, "not allowed from this network".getBytes(StandardCharsets.UTF_8));
                    return;
                }

                int length = 0;
                String declared = headers.get("content-length");
                if (declared != null) {
                    try {
                        length = Integer.parseInt(declared.trim());
                    } catch (NumberFormatException ignored) {
                        length = 0;
                    }
                }
                byte[] body = length > 0 ? input.readNBytes(length) : new byte[0];

                switch (path) {
                    case "/pair":
                        handlePair(output, body);
                        break;
                    case "/status":
                        handleStatus(output);
                        break;
                    case "/book":
                        handleBook(output, body);
                        break;
                    case "/file":
                        handleFile(output, headers, body);
                        break;
                    case "/book-done":
                        handleBookDone(output, body);
                        break;
                    default:
                        respond(output, 404, "unknown route".getBytes(StandardCharsets.UTF_8));
                }
            } catch (Exception ignored) {
                // A broken client must not take the endpoint down.
            }
        }

        private void handlePair(OutputStream output, byte[] body) throws IOException, JSONException {
            JSONObject request = decryptJson(controlKey(), body);
            if (request == null) {
                respond(output, 400, "bad request".getBytes(StandardCharsets.UTF_8));
                return;
            }
            String computerId = request.optString("computerId", "");
            if (computerId.isEmpty()) {
                respond(output, 400, "missing computer id".getBytes(StandardCharsets.UTF_8));
                return;
            }
            // "This computer only": once bound, no other computer may take over.
            String bound = pairedComputerId;
            if ("this-computer".equals(mode) && bound != null && !bound.equals(computerId)) {
                respond(output, 403, "this device is paired with another computer".getBytes(StandardCharsets.UTF_8));
                return;
            }
            pairedComputerId = computerId;
            onPair.accept(new Pairing(request.optString("computerName", "A computer"), computerId, mode));
            respond(output, 200, encryptJson(controlKey(), new JSONObject().put("ok", true)));
        }

        private void handleStatus(OutputStream output) throws IOException, JSONException {
            SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            JSONObject status = new JSONObject();
            try {
                status.put("deviceName", deviceName());
                status.put("pairedComputer", pairedComputerId == null ? JSONObject.NULL : pairedComputerId);
                status.put("books", new JSONArray(prefs.getString(KEY_BOOKS, "[]")));
            } catch (Exception ignored) {
                // Leave the status minimal if the manifest cannot be read.
            }
            respond(output, 200, encryptJson(controlKey(), status));
        }

        private void handleBook(OutputStream output, byte[] body) throws IOException, JSONException {
            JSONObject request = decryptJson(controlKey(), body);
            if (request == null) {
                respond(output, 400, "bad request".getBytes(StandardCharsets.UTF_8));
                return;
            }
            JSONObject book = request.optJSONObject("book");
            if (book == null) {
                book = new JSONObject();
            }
            String id = book.optString("id", "");
            if (id.isEmpty()) {
                respond(output, 400, "missing book id".getBytes(StandardCharsets.UTF_8));
                return;
            }
            pendingBooks.put(id, book.optString("title", id));
            File dir = new File(syncedRoot(), id);
            if (!dir.exists()) {
                dir.mkdirs();
            }
            respond(output, 200, encryptJson(controlKey(), new JSONObject().put("ok", true)));
        }

        private void handleFile(OutputStream output, Map<String, String> headers, byte[] body) throws IOException, JSONException {
            String bookId = headers.getOrDefault("x-emaki-book", "");
            String fileName = decodeHeader(headers.getOrDefault("x-emaki-file", ""));
            if (bookId.isEmpty() || fileName.isEmpty()) {
                respond(output, 400, "missing file metadata".getBytes(StandardCharsets.UTF_8));
                return;
            }
            byte[] plain = decryptBytes(fileKey(), body);
            if (plain == null) {
                respond(output, 400, "could not decrypt".getBytes(StandardCharsets.UTF_8));
                return;
            }
            File dir = new File(syncedRoot(), bookId);
            if (!dir.exists()) {
                dir.mkdirs();
            }
            try {
                File out = new File(dir, fileName);
                try (OutputStream stream = new java.io.FileOutputStream(out)) {
                    stream.write(plain);
                }
            } catch (IOException err) {
                respond(output, 500, "could not store the file".getBytes(StandardCharsets.UTF_8));
                return;
            }
            respond(output, 200, encryptJson(controlKey(), new JSONObject().put("ok", true)));
        }

        private void handleBookDone(OutputStream output, byte[] body) throws IOException, JSONException {
            JSONObject request = decryptJson(controlKey(), body);
            if (request == null) {
                respond(output, 400, "bad request".getBytes(StandardCharsets.UTF_8));
                return;
            }
            String id = request.optString("bookId", "");
            if (!id.isEmpty()) {
                recordBook(id, pendingBooks.getOrDefault(id, id));
            }
            respond(output, 200, encryptJson(controlKey(), new JSONObject().put("ok", true)));
        }

        /** "Home network only": refuse anything that is not a private address. */
        private boolean isAllowedNetwork(String address) {
            if (!"home-network".equals(mode)) {
                return true;
            }
            return address == null || isPrivateAddress(address);
        }

        private boolean isPrivateAddress(String address) {
            String[] parts = address.split("\\.");
            if (parts.length != 4) {
                return false;
            }
            try {
                int a = Integer.parseInt(parts[0]);
                int b = Integer.parseInt(parts[1]);
                if (a == 10 || a == 127) {
                    return true;
                }
                if (a == 192 && b == 168) {
                    return true;
                }
                if (a == 172 && b >= 16 && b <= 31) {
                    return true;
                }
                return a == 169 && b == 254;
            } catch (NumberFormatException err) {
                return false;
            }
        }

        private String sourceAddress(Socket socket) {
            if (socket.getInetAddress() instanceof Inet4Address) {
                return socket.getInetAddress().getHostAddress();
            }
            return null;
        }

        /**
         * Addresses a paired computer can reach us on.
         *
         * <p>Cellular interfaces are skipped: a phone that is also using mobile
         * data would otherwise advertise its carrier address, which the
         * computer on the same Wi-Fi cannot reach. Wi-Fi and ethernet come
         * first; the list is ordered so the most likely one is tried first.
         */
        private List<String> lanAddresses() {
            List<String> wifi = new ArrayList<>();
            List<String> other = new ArrayList<>();
            try {
                Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
                while (interfaces.hasMoreElements()) {
                    NetworkInterface nic = interfaces.nextElement();
                    if (nic.isLoopback() || !nic.isUp()) {
                        continue;
                    }
                    String name = nic.getName().toLowerCase(Locale.ROOT);
                    boolean cellular = name.startsWith("rmnet") || name.startsWith("cc")
                            || name.startsWith("ppp") || name.startsWith("radio")
                            || name.startsWith("ap") || name.startsWith("vpn");
                    Enumeration<InetAddress> addresses = nic.getInetAddresses();
                    while (addresses.hasMoreElements()) {
                        InetAddress addr = addresses.nextElement();
                        if (!(addr instanceof Inet4Address) || addr.isLoopbackAddress()
                                || addr.isLinkLocalAddress()) {
                            continue;
                        }
                        String host = addr.getHostAddress();
                        if (cellular) {
                            other.add(host);
                        } else {
                            wifi.add(host);
                        }
                    }
                }
            } catch (Exception ignored) {
                // Fall through: the caller uses the loopback address.
            }
            List<String> all = new ArrayList<>(wifi);
            all.addAll(other);
            return all;
        }

        private String lanAddress() {
            List<String> addresses = lanAddresses();
            return addresses.isEmpty() ? null : addresses.get(0);
        }

        private String syncedRoot() {
            return context.getFilesDir() + "/emaki/synced";
        }

        private void recordBook(String id, String title) {
            SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            JSONArray updated = new JSONArray();
            try {
                JSONArray books = new JSONArray(prefs.getString(KEY_BOOKS, "[]"));
                updated.put(new JSONObject().put("id", id).put("title", title));
                for (int i = 0; i < books.length(); i++) {
                    JSONObject entry = books.getJSONObject(i);
                    if (!id.equals(entry.optString("id", ""))) {
                        updated.put(entry);
                    }
                }
            } catch (Exception ignored) {
                // Keep the manifest as it was if it cannot be parsed.
                return;
            }
            prefs.edit().putString(KEY_BOOKS, updated.toString()).apply();
        }

        private String encodePayload(String host, int port, long expiresAt) {
            try {
                JSONObject json = new JSONObject();
                json.put("v", 1);
                json.put("id", deviceId);
                json.put("name", deviceName());
                json.put("mode", mode);
                json.put("host", host);
                json.put("port", port);
                json.put("secret", Base64.encodeToString(secret, Base64.NO_WRAP));
                json.put("exp", expiresAt);
                json.put("hosts", new JSONArray(lanAddresses()));
                String encoded = Base64.encodeToString(json.toString().getBytes(StandardCharsets.UTF_8),
                        Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
                return "emaki-pair-v1." + encoded;
            } catch (Exception err) {
                return "";
            }
        }

        // ── crypto (must match pairing.crypto.ts) ───────────────────────

        private byte[] controlKey() {
            return deriveKey(secret, KEY_CONTROL);
        }

        private byte[] fileKey() {
            return deriveKey(secret, KEY_FILES);
        }

        private JSONObject decryptJson(byte[] key, byte[] body) {
            byte[] plain = decryptBytes(key, body);
            if (plain == null) {
                return null;
            }
            try {
                return new JSONObject(new String(plain, StandardCharsets.UTF_8));
            } catch (Exception err) {
                return null;
            }
        }

        private byte[] encryptJson(byte[] key, JSONObject value) {
            try {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                byte[] iv = new byte[12];
                random.nextBytes(iv);
                cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
                byte[] encrypted = cipher.doFinal(value.toString().getBytes(StandardCharsets.UTF_8));
                byte[] out = new byte[iv.length + encrypted.length];
                System.arraycopy(iv, 0, out, 0, iv.length);
                System.arraycopy(encrypted, 0, out, iv.length, encrypted.length);
                return out;
            } catch (Exception err) {
                return new byte[0];
            }
        }

        private byte[] decryptBytes(byte[] key, byte[] body) {
            if (body == null || body.length <= 12) {
                return null;
            }
            try {
                byte[] iv = new byte[12];
                System.arraycopy(body, 0, iv, 0, 12);
                byte[] payload = new byte[body.length - 12];
                System.arraycopy(body, 12, payload, 0, payload.length);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
                return cipher.doFinal(payload);
            } catch (Exception err) {
                return null;
            }
        }

        /** HKDF-SHA256 (extract + expand), matching WebCrypto's HKDF. */
        static byte[] deriveKey(byte[] ikm, String info) {
            try {
                Mac mac = Mac.getInstance("HmacSHA256");
                mac.init(new SecretKeySpec(KEY_SALT.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
                byte[] prk = mac.doFinal(ikm);

                Mac expand = Mac.getInstance("HmacSHA256");
                expand.init(new SecretKeySpec(prk, "HmacSHA256"));
                expand.update(info.getBytes(StandardCharsets.UTF_8));
                expand.update((byte) 1);
                return expand.doFinal();
            } catch (Exception err) {
                return new byte[32];
            }
        }
    }

    /** Read one CRLF-terminated line without over-reading into the body. */
    private static String readLine(InputStream input) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        while (true) {
            int b = input.read();
            if (b == -1) {
                return buffer.size() == 0 ? null : buffer.toString("UTF-8");
            }
            if (b == '\n') {
                break;
            }
            if (b != '\r') {
                buffer.write(b);
            }
        }
        return buffer.toString("UTF-8");
    }

    /** Write an HTTP response. The body is raw bytes (already encrypted). */
    private static void respond(OutputStream output, int code, byte[] body) throws IOException {
        StringBuilder head = new StringBuilder();
        head.append("HTTP/1.1 ").append(code).append(' ').append(reasonFor(code)).append("\r\n");
        head.append("Access-Control-Allow-Origin: *\r\n");
        head.append("Access-Control-Allow-Methods: POST, OPTIONS\r\n");
        head.append("Access-Control-Allow-Headers: *\r\n");
        head.append("Access-Control-Max-Age: 600\r\n");
        head.append("Cache-Control: no-store\r\n");
        if (body != null) {
            head.append("Content-Type: application/octet-stream\r\n");
            head.append("Content-Length: ").append(body.length).append("\r\n");
        }
        head.append("Connection: close\r\n\r\n");
        output.write(head.toString().getBytes(StandardCharsets.ISO_8859_1));
        if (body != null) {
            output.write(body);
        }
        output.flush();
    }

    private static String reasonFor(int code) {
        switch (code) {
            case 200:
                return "OK";
            case 204:
                return "No Content";
            case 400:
                return "Bad Request";
            case 403:
                return "Forbidden";
            case 404:
                return "Not Found";
            default:
                return "Error";
        }
    }

    private static String decodeHeader(String value) {
        try {
            return Uri.decode(value);
        } catch (Exception err) {
            return value;
        }
    }

    private static void deleteRecursively(File file) {
        File[] children = file.listFiles();
        if (children != null) {
            for (File child : children) {
                deleteRecursively(child);
            }
        }
        file.delete();
    }
}
