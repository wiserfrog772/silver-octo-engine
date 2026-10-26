package com.localify.crimson;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.net.Uri;
import android.util.Base64;
import android.util.Log;


import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.PluginMethod;

import java.io.InputStream;
import java.io.BufferedReader;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.io.File;
import java.io.FileOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.lang.ref.WeakReference;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.json.JSONObject;

@CapacitorPlugin(name = "LocalifyPlayback")
public class PlaybackNotificationPlugin extends Plugin {
    public static final String ACTION_PLAY = "com.localify.crimson.playback.PLAY";
    public static final String ACTION_PAUSE = "com.localify.crimson.playback.PAUSE";
    public static final String ACTION_PREVIOUS = "com.localify.crimson.playback.PREVIOUS";
    public static final String ACTION_NEXT = "com.localify.crimson.playback.NEXT";

    private static final String CHANNEL_ID = "localify_music_playback";
    private static final int NOTIFICATION_ID = 7402;
    private static volatile WeakReference<PlaybackNotificationPlugin> activePlugin = new WeakReference<>(null);
    private static volatile boolean crashHandlerInstalled = false;
    private static volatile Context diagnosticContext;
    private static final String DIAGNOSTIC_FILE = "localify_diagnostics.log";
    private static final int MAX_DIAGNOSTIC_CHARS = 100_000;

    private NotificationManager notificationManager;
    private MediaSession mediaSession;
    private String trackTitle = "";
    private String trackArtist = "";
    private boolean trackActive = false;
    private boolean trackPlaying = false;
    private long trackDurationMs = 0L;
    private volatile String trackCoverUrl = "";
    private volatile String trackCoverPath = "";
    private volatile Bitmap trackArtwork;
    private String trackId = "";
    private final Map<String, FileOutputStream> transferStreams = new ConcurrentHashMap<>();
    private final Map<String, File> transferFiles = new ConcurrentHashMap<>();

    @Override
    public void load() {
        super.load();
        // The Media3 MediaSession lives in PlaybackForegroundService so Android's
        // transport controls remain attached to the native Player when WebView stops.
        activePlugin = new WeakReference<>(this);
        Context context = getContext().getApplicationContext();
        installCrashHandler(context);
        appendDiagnostic(context, "PLUGIN_LOAD", "Playback plugin initialized");
        notificationManager = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
        // Remove the legacy custom notification if this APK was installed over an older build.
        if (notificationManager != null) notificationManager.cancel(NOTIFICATION_ID);
    }

    @PluginMethod
    public void update(PluginCall call) {
        trackActive = call.getBoolean("active", false);
        trackPlaying = call.getBoolean("playing", false);
        trackTitle = safe(call.getString("title"));
        trackArtist = safe(call.getString("artist"));
        trackDurationMs = Math.max(0L, (long) (number(call.getDouble("duration")) * 1000L));

        String nextCoverUrl = safe(call.getString("coverUrl"));
        String nextCoverPath = safe(call.getString("coverPath"));
        trackCoverUrl = nextCoverUrl;
        trackCoverPath = nextCoverPath;

        // Media3 renders notification metadata directly from the active MediaItem.
        // Don't download a second artwork bitmap here; that would duplicate I/O and battery use.
        syncPlaybackService();
        JSObject result = new JSObject();
        result.put("visible", trackActive);
        call.resolve(result);
    }

    @PluginMethod
    public void getDiagnosticLog(PluginCall call) {
        JSObject result = new JSObject();
        result.put("text", readDiagnosticLog(getContext().getApplicationContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void clearDiagnosticLog(PluginCall call) {
        try {
            File file = new File(getContext().getFilesDir(), DIAGNOSTIC_FILE);
            if (file.exists() && !file.delete()) {
                try (FileWriter writer = new FileWriter(file, false)) { writer.write(""); }
            }
            call.resolve();
        } catch (Exception error) {
            call.reject("Не удалось очистить журнал диагностики.", error);
        }
    }

    @PluginMethod
    public void reportWebError(PluginCall call) {
        String message = safe(call.getString("message"));
        String stack = safe(call.getString("stack"));
        String source = safe(call.getString("source"));
        appendDiagnostic(getContext().getApplicationContext(), "WEB_ERROR",
            message + (source.isEmpty() ? "" : "\nSource: " + source) +
            (stack.isEmpty() ? "" : "\n" + stack));
        call.resolve();
    }

    static void logDiagnostic(String event, String details) {
        Context context = diagnosticContext;
        if (context == null) {
            PlaybackNotificationPlugin plugin = activePlugin == null ? null : activePlugin.get();
            if (plugin != null && plugin.getContext() != null) context = plugin.getContext().getApplicationContext();
        }
        if (context != null) appendDiagnostic(context, event, details);
    }

    private static synchronized void installCrashHandler(Context context) {
        if (crashHandlerInstalled) return;
        diagnosticContext = context.getApplicationContext();
        crashHandlerInstalled = true;
        Thread.UncaughtExceptionHandler previous = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, error) -> {
            StringWriter buffer = new StringWriter();
            error.printStackTrace(new PrintWriter(buffer));
            appendDiagnostic(context, "UNCAUGHT_EXCEPTION",
                "Thread: " + thread.getName() + "\n" + buffer);
            Log.e("LocalifyCrash", "Uncaught exception on " + thread.getName(), error);
            if (previous != null) previous.uncaughtException(thread, error);
        });
    }

    static synchronized void appendDiagnostic(Context context, String event, String details) {
        if (context == null) return;
        String stamp = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US).format(new Date());
        File file = new File(context.getFilesDir(), DIAGNOSTIC_FILE);
        try {
            String old = "";
            if (file.exists()) {
                try (BufferedReader reader = new BufferedReader(new FileReader(file))) {
                    StringBuilder contents = new StringBuilder();
                    String line;
                    while ((line = reader.readLine()) != null) contents.append(line).append('\n');
                    old = contents.toString();
                }
            }
            String entry = "[" + stamp + "] " + event + "\n" +
                (details == null ? "" : details) + "\n\n";
            String combined = old + entry;
            if (combined.length() > MAX_DIAGNOSTIC_CHARS) {
                combined = combined.substring(combined.length() - MAX_DIAGNOSTIC_CHARS);
                int firstNewline = combined.indexOf('\n');
                if (firstNewline >= 0 && firstNewline + 1 < combined.length()) combined = combined.substring(firstNewline + 1);
            }
            try (FileWriter writer = new FileWriter(file, false)) { writer.write(combined); }
        } catch (IOException error) {
            Log.w("LocalifyCrash", "Could not write diagnostic log", error);
        }
    }

    private static String readDiagnosticLog(Context context) {
        if (context == null) return "";
        File file = new File(context.getFilesDir(), DIAGNOSTIC_FILE);
        if (!file.isFile()) return "";
        try (BufferedReader reader = new BufferedReader(new FileReader(file))) {
            StringBuilder result = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) result.append(line).append('\n');
            return result.toString();
        } catch (IOException error) {
            return "Не удалось прочитать журнал: " + error.getMessage();
        }
    }

    @PluginMethod
    public void setQueue(PluginCall call) {
        String itemsJson = safe(call.getString("itemsJson"));
        if (itemsJson.isEmpty()) itemsJson = "[]";
        String currentId = safe(call.getString("currentId"));
        long positionMs = longNumber(call.getDouble("positionMs"));
        boolean playing = call.getBoolean("playing", false);
        boolean shuffle = call.getBoolean("shuffle", false);
        boolean repeat = call.getBoolean("repeat", false);
        PlaybackForegroundService.setQueue(getContext(), itemsJson, currentId, positionMs, playing, shuffle, repeat);
        call.resolve();
    }

    @PluginMethod
    public void play(PluginCall call) {
        if (PlaybackForegroundService.handleAction(getContext(), ACTION_PLAY)) call.resolve();
        else call.reject("Нет сохранённой очереди для продолжения воспроизведения.");
    }

    @PluginMethod
    public void pause(PluginCall call) {
        if (PlaybackForegroundService.handleAction(getContext(), ACTION_PAUSE)) call.resolve();
        else call.reject("Плеер ещё не запущен.");
    }

    @PluginMethod
    public void next(PluginCall call) {
        if (PlaybackForegroundService.handleAction(getContext(), ACTION_NEXT)) call.resolve();
        else call.reject("Нет следующего трека в сохранённой очереди.");
    }

    @PluginMethod
    public void previous(PluginCall call) {
        if (PlaybackForegroundService.handleAction(getContext(), ACTION_PREVIOUS)) call.resolve();
        else call.reject("Нет предыдущего трека в сохранённой очереди.");
    }

    @PluginMethod
    public void seekTo(PluginCall call) {
        if (PlaybackForegroundService.seekTo(getContext(), longNumber(call.getDouble("positionMs")))) call.resolve();
        else call.reject("Невозможно перемотать трек, пока плеер не запущен.");
    }

    @PluginMethod
    public void getPlaybackState(PluginCall call) {
        JSONObject snapshot = PlaybackForegroundService.playbackState(getContext());
        JSObject result = new JSObject();
        java.util.Iterator<String> keys = snapshot.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            result.put(key, snapshot.opt(key));
        }
        call.resolve(result);
    }

    @PluginMethod
    public void beginTrackTransfer(PluginCall call) {
        String id = safeId(call.getString("id"));
        String name = safe(call.getString("name"));
        if (id.isEmpty()) { call.reject("Не задан ID аудиофайла."); return; }
        try {
            File directory = new File(getContext().getFilesDir(), "LocalifyTracks");
            if (!directory.exists() && !directory.mkdirs()) throw new java.io.IOException("Cannot create audio directory");
            String extension = "audio";
            int dot = name.lastIndexOf('.');
            if (dot >= 0 && dot < name.length() - 1) {
                String candidate = name.substring(dot + 1).toLowerCase(java.util.Locale.ROOT);
                if (candidate.matches("[a-z0-9]{2,8}")) extension = candidate;
            }
            File file = new File(directory, id + "." + extension);
            FileOutputStream previous = transferStreams.remove(id);
            if (previous != null) try { previous.close(); } catch (Exception ignored) {}
            FileOutputStream stream = new FileOutputStream(file, false);
            transferFiles.put(id, file);
            transferStreams.put(id, stream);
            call.resolve();
        } catch (Exception error) {
            call.reject("Не удалось подготовить аудиофайл для фонового воспроизведения.", error);
        }
    }

    @PluginMethod
    public void appendTrackTransferChunk(PluginCall call) {
        String id = safeId(call.getString("id"));
        String data = safe(call.getString("data"));
        FileOutputStream stream = transferStreams.get(id);
        if (stream == null) { call.reject("Передача аудиофайла не начата."); return; }
        try {
            byte[] bytes = Base64.decode(data, Base64.DEFAULT);
            synchronized (stream) { stream.write(bytes); }
            call.resolve();
        } catch (Exception error) {
            call.reject("Не удалось записать часть аудиофайла.", error);
        }
    }

    @PluginMethod
    public void cancelTrackTransfer(PluginCall call) {
        String id = safeId(call.getString("id"));
        FileOutputStream stream = transferStreams.remove(id);
        if (stream != null) try { stream.close(); } catch (Exception ignored) {}
        File file = transferFiles.remove(id);
        if (file != null && file.exists()) try { file.delete(); } catch (Exception ignored) {}
        call.resolve();
    }

    @PluginMethod
    public void deleteTrackFile(PluginCall call) {
        String rawPath = safe(call.getString("path"));
        try {
            File root = new File(getContext().getFilesDir(), "LocalifyTracks").getCanonicalFile();
            File file = new File(rawPath).getCanonicalFile();
            if (file.getPath().startsWith(root.getPath() + File.separator) && file.isFile()) file.delete();
        } catch (Exception ignored) {}
        call.resolve();
    }

    @PluginMethod
    public void finishTrackTransfer(PluginCall call) {
        String id = safeId(call.getString("id"));
        FileOutputStream stream = transferStreams.remove(id);
        File file = transferFiles.remove(id);
        try {
            if (stream == null || file == null) throw new java.io.IOException("Transfer not found");
            synchronized (stream) { stream.flush(); stream.close(); }
            JSObject result = new JSObject();
            result.put("path", file.getAbsolutePath());
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Не удалось сохранить аудиофайл для фонового воспроизведения.", error);
        }
    }

    @PluginMethod
    public void clear(PluginCall call) {
        trackActive = false;
        publishNotification();
        syncPlaybackService();
        call.resolve();
    }

    private void createNotificationChannel(Context context) {
        if (Build.VERSION.SDK_INT < 26 || notificationManager == null) return;
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID, "Музыка Localify", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Управление воспроизведением музыки Localify");
        channel.setShowBadge(false);
        notificationManager.createNotificationChannel(channel);
    }

    private void publishNotification() {
        if (notificationManager == null || mediaSession == null) return;
        if (!trackActive || trackTitle.trim().isEmpty()) {
            notificationManager.cancel(NOTIFICATION_ID);
            try { mediaSession.setActive(false); } catch (Exception ignored) {}
            return;
        }
        long positionMs = PlaybackForegroundService.playbackState().optLong("positionMs", 0L);
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE |
            PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_SKIP_TO_PREVIOUS |
            PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SEEK_TO;
        MediaMetadata.Builder metadata = new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, trackTitle)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, trackArtist)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, "Localify Crimson")
            .putLong(MediaMetadata.METADATA_KEY_DURATION, trackDurationMs);
        Bitmap artwork = trackArtwork;
        if (artwork != null && !artwork.isRecycled()) {
            metadata.putBitmap(MediaMetadata.METADATA_KEY_ART, artwork);
            metadata.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, artwork);
        }
        mediaSession.setMetadata(metadata.build());
        mediaSession.setPlaybackState(new PlaybackState.Builder()
            .setActions(actions)
            .setState(trackPlaying ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, positionMs, trackPlaying ? 1.0f : 0.0f)
            .build());
        mediaSession.setActive(true);

        Context context = getContext().getApplicationContext();
        notificationManager.notify(NOTIFICATION_ID, buildNotification(context));
    }

    private Notification buildNotification(Context context) {
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(context, CHANNEL_ID)
            : new Notification.Builder(context).setPriority(Notification.PRIORITY_LOW);
        builder.setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(trackTitle)
            .setContentText(trackArtist)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setOngoing(trackPlaying);
        Bitmap artwork = trackArtwork;
        if (artwork != null && !artwork.isRecycled()) builder.setLargeIcon(artwork);

        PendingIntent contentIntent = contentPendingIntent(context);
        if (contentIntent != null) builder.setContentIntent(contentIntent);
        builder.addAction(new Notification.Action.Builder(
            android.R.drawable.ic_media_previous, "Предыдущий", actionPendingIntent(context, ACTION_PREVIOUS, 1)).build());
        builder.addAction(new Notification.Action.Builder(
            trackPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
            trackPlaying ? "Пауза" : "Продолжить",
            actionPendingIntent(context, trackPlaying ? ACTION_PAUSE : ACTION_PLAY, 2)).build());
        builder.addAction(new Notification.Action.Builder(
            android.R.drawable.ic_media_next, "Следующий", actionPendingIntent(context, ACTION_NEXT, 3)).build());
        if (mediaSession != null) {
            builder.setStyle(new Notification.MediaStyle()
                .setMediaSession(mediaSession.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2));
        }
        return builder.build();
    }

    static Notification currentNotification(Context context) {
        PlaybackNotificationPlugin plugin = activePlugin == null ? null : activePlugin.get();
        if (plugin != null) return plugin.buildNotification(context);
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(context, CHANNEL_ID)
            : new Notification.Builder(context).setPriority(Notification.PRIORITY_LOW);
        builder.setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle("Localify Crimson")
            .setContentText("Воспроизведение музыки")
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setOngoing(true)
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_previous, "Предыдущий", actionPendingIntent(context, ACTION_PREVIOUS, 1)).build())
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_pause, "Пауза", actionPendingIntent(context, ACTION_PAUSE, 2)).build())
            .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_next, "Следующий", actionPendingIntent(context, ACTION_NEXT, 3)).build());
        return builder.build();
    }

    private void syncPlaybackService() {
        Context context = getContext().getApplicationContext();
        Intent intent = new Intent(context, PlaybackForegroundService.class);
        if (!trackActive || trackTitle.trim().isEmpty()) {
            PlaybackForegroundService.clearSavedPlayback(context);
            context.stopService(intent);
        }
        // Starting is deliberately left to setQueue(): MediaSessionService then receives a
        // complete queue and can promote itself while the first item begins playing, without
        // starting an empty foreground service during potentially large local-file transfers.
    }

    private void loadArtworkAsync(String path, String url) {
        if ((path == null || path.isEmpty()) && (url == null || !url.startsWith("https://"))) return;
        new Thread(() -> {
            Bitmap bitmap = null;
            try {
                if (path != null && !path.isEmpty()) {
                    String filePath = path.startsWith("file://") ? android.net.Uri.parse(path).getPath() : path;
                    BitmapFactory.Options bounds = new BitmapFactory.Options();
                    bounds.inJustDecodeBounds = true;
                    BitmapFactory.decodeFile(filePath, bounds);
                    int sample = 1;
                    while (bounds.outWidth / sample > 512 || bounds.outHeight / sample > 512) sample *= 2;
                    BitmapFactory.Options options = new BitmapFactory.Options();
                    options.inSampleSize = sample;
                    bitmap = BitmapFactory.decodeFile(filePath, options);
                }
                if (bitmap == null && url != null && url.startsWith("https://")) {
                    HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
                    connection.setConnectTimeout(4500);
                    connection.setReadTimeout(4500);
                    connection.setInstanceFollowRedirects(true);
                    try (InputStream input = connection.getInputStream()) {
                        bitmap = BitmapFactory.decodeStream(input);
                    } finally {
                        connection.disconnect();
                    }
                }
            } catch (Exception ignored) {}
            if (!url.equals(trackCoverUrl) || !path.equals(trackCoverPath)) {
                if (bitmap != null && !bitmap.isRecycled()) bitmap.recycle();
                return;
            }
            trackArtwork = bitmap;
            publishNotification();
            syncPlaybackService();
        }, "Localify-Cover-Loader").start();
    }

    private static PendingIntent actionPendingIntent(Context context, String action, int requestCode) {
        Intent intent = new Intent(context, PlaybackActionReceiver.class);
        intent.setAction(action);
        return PendingIntent.getBroadcast(
            context, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private PendingIntent contentPendingIntent(Context context) {
        Intent launchIntent = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launchIntent == null) return null;
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        return PendingIntent.getActivity(
            context, 7403, launchIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    static void dispatchAction(Context context, String action) {
        if (action == null) return;
        if (context != null && PlaybackForegroundService.handleAction(context, action)) return;
        PlaybackNotificationPlugin plugin = activePlugin == null ? null : activePlugin.get();
        if (plugin == null) return;
        JSObject event = new JSObject();
        String kind;
        if (ACTION_PLAY.equals(action)) kind = "play";
        else if (ACTION_PAUSE.equals(action)) kind = "pause";
        else if (ACTION_PREVIOUS.equals(action)) kind = "previous";
        else if (ACTION_NEXT.equals(action)) kind = "next";
        else return;
        event.put("action", kind);
        plugin.notifyListeners("mediaAction", event);
    }

    static void updateFromNativePlayer(String id, String title, String artist, long durationMs,
                                       boolean playing, String artworkUri) {
        PlaybackNotificationPlugin plugin = activePlugin == null ? null : activePlugin.get();
        if (plugin == null) return;
        plugin.trackId = safe(id);
        plugin.trackActive = !plugin.trackId.isEmpty();
        plugin.trackTitle = safe(title);
        plugin.trackArtist = safe(artist);
        plugin.trackDurationMs = Math.max(0L, durationMs);
        plugin.trackPlaying = playing;
        String nextUrl = "";
        String nextPath = "";
        String art = safe(artworkUri);
        if (art.startsWith("https://")) nextUrl = art;
        else if (art.startsWith("file://")) nextPath = Uri.parse(art).getPath();
        else if (art.startsWith("/")) nextPath = art;
        plugin.trackCoverUrl = nextUrl;
        plugin.trackCoverPath = nextPath;
        // Media3's MediaItem artwork URI is the source of truth for system controls.
    }

    static void notifyNativePlaybackState(JSONObject snapshot) {
        PlaybackNotificationPlugin plugin = activePlugin == null ? null : activePlugin.get();
        if (plugin == null || snapshot == null) return;
        String id = snapshot.optString("currentId", "");
        if (!id.isEmpty()) {
            updateFromNativePlayer(id, snapshot.optString("title", ""), snapshot.optString("artist", ""),
                snapshot.optLong("durationMs", 0L), snapshot.optBoolean("playing", false), snapshot.optString("artworkUri", ""));
        } else {
            plugin.trackPlaying = false;
            plugin.publishNotification();
        }
        JSObject state = new JSObject();
        java.util.Iterator<String> keys = snapshot.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            state.put(key, snapshot.opt(key));
        }
        plugin.notifyListeners("nativePlaybackState", state);
    }

    static void reportNativePlayerError(String message) {
        PlaybackNotificationPlugin plugin = activePlugin == null ? null : activePlugin.get();
        if (plugin != null) {
            JSObject event = new JSObject();
            event.put("message", message == null ? "Ошибка воспроизведения." : message);
            plugin.notifyListeners("nativePlaybackError", event);
        }
    }

    private static String safeId(String value) {
        return safe(value).replaceAll("[^A-Za-z0-9._-]", "_");
    }

    private static long longNumber(Double value) {
        return value == null || !Double.isFinite(value) || value < 0 ? 0L : value.longValue();
    }

    private static String safe(String value) {
        return value == null ? "" : value.trim();
    }

    private static double number(Double value) {
        return value == null || !Double.isFinite(value) || value < 0 ? 0 : value;
    }
}
