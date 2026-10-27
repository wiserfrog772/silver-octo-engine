package com.localify.crimson;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;

import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MediaMetadata;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.MediaSession;
import androidx.media3.session.MediaSessionService;
import androidx.media3.common.util.UnstableApi;
import com.google.common.util.concurrent.Futures;
import com.google.common.util.concurrent.ListenableFuture;

import org.json.JSONArray;
import org.json.JSONObject;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Owns the actual audio player so playback and system controls do not depend on WebView execution.
 * ExoPlayer manages its CPU wake lock only while audio is playing; paused playback does not keep
 * a manually-acquired partial wake lock alive.
 */
public final class PlaybackForegroundService extends MediaSessionService {
    public static final String EXTRA_PLAYING = "playing";
    private static final int NOTIFICATION_ID = 7402;
    private static final String PREFS = "localify_native_playback";
    private static final String PREF_QUEUE = "queueJson";
    private static final String PREF_CURRENT = "currentId";
    private static final String PREF_POSITION = "positionMs";
    private static final String PREF_PLAYING = "playing";
    private static final String PREF_SHUFFLE = "shuffle";
    private static final String PREF_REPEAT = "repeat";
    private static final String ACTION_SET_QUEUE = "com.localify.crimson.playback.SET_QUEUE";
    private static final String EXTRA_QUEUE_JSON = "queueJson";
    private static final String EXTRA_CURRENT_ID = "currentId";
    private static final String EXTRA_POSITION_MS = "positionMs";
    private static final String EXTRA_SHUFFLE = "shuffle";
    private static final String EXTRA_REPEAT = "repeat";
    private static final String EXTRA_ACTION_AFTER_QUEUE = "afterQueueAction";
    private static final String PREF_DURATION = "durationMs";
    private static volatile WeakReference<PlaybackForegroundService> activeService = new WeakReference<>(null);

    private ExoPlayer player;
    private MediaSession mediaSession;
    private String queueSignature = "";
    private String currentTrackId = "";
    private volatile boolean active = false;

    @Override
    public void onCreate() {
        super.onCreate();
        activeService = new WeakReference<>(this);
        PlaybackNotificationPlugin.logDiagnostic("SERVICE_CREATE", "Native MediaSessionService created");
        player = new ExoPlayer.Builder(this)
            .setWakeMode(C.WAKE_MODE_LOCAL)
            .build();
        player.setAudioAttributes(
            new androidx.media3.common.AudioAttributes.Builder()
                .setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
                .build(),
            true
        );
        mediaSession = new MediaSession.Builder(this, player)
            .setCallback(new MediaSession.Callback() {
                @UnstableApi
                @Override
                public ListenableFuture<MediaSession.MediaItemsWithStartPosition> onPlaybackResumption(
                    MediaSession session, MediaSession.ControllerInfo controller, boolean isForPlayback) {
                    return createPlaybackResumption(isForPlayback);
                }
            })
            .build();
        player.addListener(new Player.Listener() {
            @Override
            public void onMediaItemTransition(MediaItem item, int reason) {
                updateTrackFromPlayer();
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                savePlaybackSnapshot();
                publishNativeState();
            }

            @Override
            public void onPlaybackStateChanged(int playbackState) {
                // Position and queue are saved on track transitions and play/pause changes;
                // buffering/ready events only need to refresh the visible UI.
                publishNativeState();
            }

            @Override
            public void onPlayerError(androidx.media3.common.PlaybackException error) {
                PlaybackNotificationPlugin.logDiagnostic("PLAYER_ERROR", error == null ? "unknown" : error.toString());
                PlaybackNotificationPlugin.reportNativePlayerError(
                    "Не удалось воспроизвести трек: " + (error == null || error.getMessage() == null ? "неподдерживаемый формат или недоступный файл" : error.getMessage())
                );
                publishNativeState();
            }
        });
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        int serviceResult = super.onStartCommand(intent, flags, startId);
        if (intent == null) {
            android.content.SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            String savedQueue = prefs.getString(PREF_QUEUE, "");
            if (savedQueue.isEmpty()) {
                stopSelf(startId);
                return START_NOT_STICKY;
            }
            active = true;
            applyQueue(
                savedQueue,
                prefs.getString(PREF_CURRENT, ""),
                prefs.getLong(PREF_POSITION, 0L),
                prefs.getBoolean(PREF_PLAYING, false),
                prefs.getBoolean(PREF_SHUFFLE, false),
                prefs.getBoolean(PREF_REPEAT, false)
            );
            return serviceResult;
        }

        String action = intent.getAction();
        active = intent.getBooleanExtra("active", true);
        PlaybackNotificationPlugin.logDiagnostic("SERVICE_START", "action=" + String.valueOf(action) + ", active=" + active + ", nullIntent=false");
        if (ACTION_SET_QUEUE.equals(action)) {
            applyQueue(
                intent.getStringExtra(EXTRA_QUEUE_JSON),
                intent.getStringExtra(EXTRA_CURRENT_ID),
                intent.getLongExtra(EXTRA_POSITION_MS, 0L),
                intent.getBooleanExtra(EXTRA_PLAYING, false),
                intent.getBooleanExtra(EXTRA_SHUFFLE, false),
                intent.getBooleanExtra(EXTRA_REPEAT, false)
            );
            String afterQueueAction = intent.getStringExtra(EXTRA_ACTION_AFTER_QUEUE);
            if (afterQueueAction != null && !afterQueueAction.isEmpty()) handleActionInternal(afterQueueAction);
        } else {
            handleActionInternal(action);
        }
        return serviceResult;
    }

    @UnstableApi
    private ListenableFuture<MediaSession.MediaItemsWithStartPosition> createPlaybackResumption(boolean isForPlayback) {
        try {
            android.content.SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
            JSONArray stored = new JSONArray(prefs.getString(PREF_QUEUE, "[]"));
            String currentId = prefs.getString(PREF_CURRENT, "");
            long positionMs = Math.max(0L, prefs.getLong(PREF_POSITION, 0L));
            List<MediaItem> items = new ArrayList<>();
            int currentIndex = -1;
            for (int i = 0; i < stored.length(); i++) {
                JSONObject row = stored.optJSONObject(i);
                if (row == null) continue;
                String id = row.optString("id", "");
                String uriText = row.optString("uri", "");
                if (id.isEmpty() || uriText.isEmpty()) continue;
                MediaMetadata.Builder metadata = new MediaMetadata.Builder()
                    .setTitle(row.optString("title", "Localify"))
                    .setArtist(row.optString("artist", "Неизвестный исполнитель"));
                String artworkUri = row.optString("artworkUri", "");
                if (!artworkUri.isEmpty()) metadata.setArtworkUri(Uri.parse(artworkUri));
                MediaItem item = new MediaItem.Builder()
                    .setMediaId(id)
                    .setUri(Uri.parse(uriText))
                    .setMediaMetadata(metadata.build())
                    .build();
                if (id.equals(currentId)) currentIndex = items.size();
                items.add(item);
            }
            if (items.isEmpty()) {
                return Futures.immediateFailedFuture(new IllegalStateException("Нет сохранённой очереди для возобновления."));
            }
            if (currentIndex < 0) currentIndex = 0;
            player.setShuffleModeEnabled(prefs.getBoolean(PREF_SHUFFLE, false));
            player.setRepeatMode(prefs.getBoolean(PREF_REPEAT, false) ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_OFF);
            if (!isForPlayback) {
                MediaItem current = items.get(currentIndex);
                return Futures.immediateFuture(new MediaSession.MediaItemsWithStartPosition(
                    Collections.singletonList(current), 0, positionMs));
            }
            return Futures.immediateFuture(
                new MediaSession.MediaItemsWithStartPosition(items, currentIndex, positionMs));
        } catch (Exception error) {
            return Futures.immediateFailedFuture(error);
        }
    }

    @Override
    public MediaSession onGetSession(MediaSession.ControllerInfo controllerInfo) {
        return mediaSession;
    }

    static void setQueue(Context context, String queueJson, String currentId, long positionMs,
                         boolean playing, boolean shuffle, boolean repeat) {
        PlaybackForegroundService service = activeService == null ? null : activeService.get();
        if (service != null && service.player != null && service.mediaSession != null) {
            service.runOnPlayerThread(() -> {
                if (service.player == null || service.mediaSession == null) return;
                service.active = true;
                service.applyQueue(queueJson, currentId, positionMs, playing, shuffle, repeat);
            });
            return;
        }
        Intent intent = new Intent(context.getApplicationContext(), PlaybackForegroundService.class);
        intent.setAction(ACTION_SET_QUEUE);
        intent.putExtra("active", true);
        intent.putExtra(EXTRA_QUEUE_JSON, queueJson == null ? "[]" : queueJson);
        intent.putExtra(EXTRA_CURRENT_ID, currentId == null ? "" : currentId);
        intent.putExtra(EXTRA_POSITION_MS, Math.max(0L, positionMs));
        intent.putExtra(EXTRA_PLAYING, playing);
        intent.putExtra(EXTRA_SHUFFLE, shuffle);
        intent.putExtra(EXTRA_REPEAT, repeat);
        if (Build.VERSION.SDK_INT >= 26) context.getApplicationContext().startForegroundService(intent);
        else context.getApplicationContext().startService(intent);
    }

    static void clearSavedPlayback(Context context) {
        if (context != null) {
            context.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().clear().apply();
        }
        PlaybackForegroundService service = activeService == null ? null : activeService.get();
        if (service != null) {
            service.active = false;
            service.clearPlayerQueue();
        }
    }

    private void runOnPlayerThread(Runnable action) {
        if (action == null) return;
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) {
            action.run();
        } else {
            new android.os.Handler(android.os.Looper.getMainLooper()).post(action);
        }
    }

    private void clearPlayerQueue() {
        if (player == null) return;
        Runnable clear = () -> {
            if (player == null) return;
            player.pause();
            player.clearMediaItems();
            queueSignature = "";
            currentTrackId = "";
            publishNativeState();
        };
        if (android.os.Looper.myLooper() == player.getApplicationLooper()) {
            clear.run();
        } else {
            new android.os.Handler(player.getApplicationLooper()).post(clear);
        }
    }

    static boolean handleAction(Context context, String action) {
        if (context == null || action == null) return false;
        PlaybackForegroundService service = activeService == null ? null : activeService.get();
        if (service != null && service.player != null) {
            service.runOnPlayerThread(() -> {
                if (service.player == null) return;
                if (service.player.getMediaItemCount() > 0) {
                    service.handleActionInternal(action);
                } else {
                    startFromSavedQueue(context, action, null);
                }
            });
            return true;
        }
        return startFromSavedQueue(context, action, null);
    }

    static boolean seekTo(long positionMs) {
        PlaybackForegroundService service = activeService == null ? null : activeService.get();
        if (service == null || service.player == null) return false;
        service.runOnPlayerThread(() -> {
            if (service.player == null || service.player.getMediaItemCount() == 0) return;
            service.player.seekTo(Math.max(0L, positionMs));
            service.savePlaybackSnapshot();
            service.publishNativeState();
        });
        return true;
    }

    static boolean seekTo(Context context, long positionMs) {
        PlaybackForegroundService service = activeService == null ? null : activeService.get();
        if (service != null && service.player != null) {
            service.runOnPlayerThread(() -> {
                if (service.player != null && service.player.getMediaItemCount() > 0) {
                    service.player.seekTo(Math.max(0L, positionMs));
                    service.savePlaybackSnapshot();
                    service.publishNativeState();
                } else {
                    startFromSavedQueue(context, "seek", Math.max(0L, positionMs));
                }
            });
            return true;
        }
        return startFromSavedQueue(context, "seek", Math.max(0L, positionMs));
    }

    private static boolean startFromSavedQueue(Context context, String action, Long positionOverride) {
        if (context == null) return false;
        Context app = context.getApplicationContext();
        android.content.SharedPreferences prefs = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String queueJson = prefs.getString(PREF_QUEUE, "");
        String currentId = prefs.getString(PREF_CURRENT, "");
        if (queueJson.isEmpty() || currentId.isEmpty()) return false;

        boolean playing = prefs.getBoolean(PREF_PLAYING, false);
        if (PlaybackNotificationPlugin.ACTION_PLAY.equals(action) || "play".equals(action)) playing = true;
        else if (PlaybackNotificationPlugin.ACTION_PAUSE.equals(action) || "pause".equals(action)) playing = false;

        Intent intent = new Intent(app, PlaybackForegroundService.class);
        intent.setAction(ACTION_SET_QUEUE);
        intent.putExtra("active", true);
        intent.putExtra(EXTRA_QUEUE_JSON, queueJson);
        intent.putExtra(EXTRA_CURRENT_ID, currentId);
        intent.putExtra(EXTRA_POSITION_MS, positionOverride == null
            ? prefs.getLong(PREF_POSITION, 0L) : positionOverride);
        intent.putExtra(EXTRA_PLAYING, playing);
        intent.putExtra(EXTRA_SHUFFLE, prefs.getBoolean(PREF_SHUFFLE, false));
        intent.putExtra(EXTRA_REPEAT, prefs.getBoolean(PREF_REPEAT, false));
        if (positionOverride == null &&
            (PlaybackNotificationPlugin.ACTION_NEXT.equals(action) || PlaybackNotificationPlugin.ACTION_PREVIOUS.equals(action) ||
             "next".equals(action) || "previous".equals(action))) {
            intent.putExtra(EXTRA_ACTION_AFTER_QUEUE, action);
        }
        if (Build.VERSION.SDK_INT >= 26) app.startForegroundService(intent);
        else app.startService(intent);
        return true;
    }

    static boolean hasPlayer() {
        PlaybackForegroundService service = activeService == null ? null : activeService.get();
        if (service == null || service.player == null) return false;
        if (android.os.Looper.myLooper() != android.os.Looper.getMainLooper()) return service.active;
        return service.player.getMediaItemCount() > 0;
    }

    static JSONObject playbackState() {
        return playbackState(null);
    }

    static JSONObject playbackState(Context context) {
        PlaybackForegroundService service = activeService == null ? null : activeService.get();
        JSONObject result = new JSONObject();
        try {
            // ExoPlayer must only be queried on its application thread. Plugin bridge calls
            // run on CapacitorPlugins, so off-main queries use the last persisted snapshot.
            if (service != null && service.player != null
                && android.os.Looper.myLooper() == android.os.Looper.getMainLooper()
                && service.player.getCurrentMediaItem() != null) {
                service.fillState(result);
                return result;
            }
            if (context != null) {
                fillSavedPlaybackState(context.getApplicationContext(), result);
                // If the last state was playing, resume it through MediaSessionService after
                // Android recreated the app process. Paused sessions stay idle and use no wake lock.
                if (result.optBoolean("active", false) && result.optBoolean("playing", false)) {
                    startFromSavedQueue(context, PlaybackNotificationPlugin.ACTION_PLAY, null);
                }
            } else {
                result.put("active", false);
            }
        } catch (Exception ignored) {}
        return result;
    }

    private static void fillSavedPlaybackState(Context context, JSONObject result) throws Exception {
        android.content.SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String queueJson = prefs.getString(PREF_QUEUE, "");
        String currentId = prefs.getString(PREF_CURRENT, "");
        if (queueJson.isEmpty() || currentId.isEmpty()) {
            result.put("active", false);
            result.put("currentId", "");
            result.put("playing", false);
            result.put("positionMs", 0);
            result.put("durationMs", 0);
            return;
        }
        JSONArray queue = new JSONArray(queueJson);
        JSONObject current = new JSONObject();
        for (int i = 0; i < queue.length(); i++) {
            JSONObject item = queue.optJSONObject(i);
            if (item != null && currentId.equals(item.optString("id", ""))) {
                current = item;
                break;
            }
        }
        result.put("active", true);
        result.put("currentId", currentId);
        result.put("uri", current.optString("uri", ""));
        result.put("title", current.optString("title", "Localify"));
        result.put("artist", current.optString("artist", "Неизвестный исполнитель"));
        result.put("artworkUri", current.optString("artworkUri", ""));
        result.put("playing", prefs.getBoolean(PREF_PLAYING, false));
        result.put("positionMs", prefs.getLong(PREF_POSITION, 0L));
        result.put("durationMs", prefs.getLong(PREF_DURATION, 0L));
        result.put("shuffle", prefs.getBoolean(PREF_SHUFFLE, false));
        result.put("repeat", prefs.getBoolean(PREF_REPEAT, false));
        result.put("queue", queue);
    }

    private void fillState(JSONObject target) throws Exception {
        fillState(target, true);
    }

    private void fillState(JSONObject target, boolean includeQueue) throws Exception {
        MediaItem item = player.getCurrentMediaItem();
        MediaMetadata metadata = item == null ? new MediaMetadata.Builder().build() : item.mediaMetadata;
        target.put("active", item != null);
        target.put("currentId", item == null ? "" : item.mediaId);
        target.put("uri", item == null || item.localConfiguration == null ? "" : item.localConfiguration.uri.toString());
        target.put("title", metadata.title == null ? "" : metadata.title.toString());
        target.put("artist", metadata.artist == null ? "" : metadata.artist.toString());
        target.put("playing", player.isPlaying());
        target.put("positionMs", Math.max(0L, player.getCurrentPosition()));
        long duration = player.getDuration();
        target.put("durationMs", duration == C.TIME_UNSET ? 0L : Math.max(0L, duration));
        target.put("shuffle", player.getShuffleModeEnabled());
        target.put("repeat", player.getRepeatMode() == Player.REPEAT_MODE_ONE);
        target.put("artworkUri", metadata.artworkUri == null ? "" : metadata.artworkUri.toString());
        if (includeQueue) {
            JSONArray queue = new JSONArray();
            for (int i = 0; i < player.getMediaItemCount(); i++) {
                MediaItem queueItem = player.getMediaItemAt(i);
                JSONObject row = new JSONObject();
                MediaMetadata rowMetadata = queueItem.mediaMetadata;
                row.put("id", queueItem.mediaId);
                row.put("uri", queueItem.localConfiguration == null ? "" : queueItem.localConfiguration.uri.toString());
                row.put("title", rowMetadata.title == null ? "" : rowMetadata.title.toString());
                row.put("artist", rowMetadata.artist == null ? "" : rowMetadata.artist.toString());
                row.put("artworkUri", rowMetadata.artworkUri == null ? "" : rowMetadata.artworkUri.toString());
                queue.put(row);
            }
            target.put("queue", queue);
        }
    }

    private void applyQueue(String queueJson, String requestedCurrentId, long requestedPositionMs,
                            boolean shouldPlay, boolean shuffle, boolean repeat) {
        if (player == null) return;
        List<MediaItem> mediaItems = new ArrayList<>();
        StringBuilder signatureBuilder = new StringBuilder();
        try {
            JSONArray tracks = new JSONArray(queueJson == null ? "[]" : queueJson);
            for (int i = 0; i < tracks.length(); i++) {
                JSONObject track = tracks.optJSONObject(i);
                if (track == null) continue;
                String id = track.optString("id", "");
                String uriText = track.optString("uri", "");
                if (id.isEmpty() || uriText.isEmpty()) continue;

                Uri uri = Uri.parse(uriText);
                MediaMetadata.Builder metadata = new MediaMetadata.Builder()
                    .setTitle(track.optString("title", "Localify"))
                    .setArtist(track.optString("artist", "Неизвестный исполнитель"));
                String artwork = track.optString("artworkUri", "");
                if (!artwork.isEmpty()) {
                    try { metadata.setArtworkUri(Uri.parse(artwork)); } catch (Exception ignored) {}
                }
                MediaItem item = new MediaItem.Builder()
                    .setMediaId(id)
                    .setUri(uri)
                    .setMediaMetadata(metadata.build())
                    .build();
                mediaItems.add(item);
                signatureBuilder.append(id).append('|').append(uriText).append(';');
            }
        } catch (Exception error) {
            PlaybackNotificationPlugin.logDiagnostic("QUEUE_ERROR", error.toString());
            PlaybackNotificationPlugin.reportNativePlayerError("Не удалось подготовить очередь воспроизведения.");
            return;
        }

        if (mediaItems.isEmpty()) {
            player.pause();
            player.clearMediaItems();
            queueSignature = "";
            currentTrackId = "";
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().clear().apply();
            publishNativeState();
            return;
        }

        String signature = signatureBuilder.toString();
        int startIndex = 0;
        String currentId = requestedCurrentId == null ? "" : requestedCurrentId;
        for (int i = 0; i < mediaItems.size(); i++) {
            if (mediaItems.get(i).mediaId.equals(currentId)) {
                startIndex = i;
                break;
            }
        }

        boolean currentUnchanged = currentId.equals(currentTrackId)
            && player.getCurrentMediaItem() != null
            && currentId.equals(player.getCurrentMediaItem().mediaId);
        boolean queueUnchanged = signature.equals(queueSignature);
        player.setShuffleModeEnabled(shuffle);
        player.setRepeatMode(repeat ? Player.REPEAT_MODE_ONE : Player.REPEAT_MODE_OFF);

        // Don't seek/reset an already-playing track when only metadata or queue controls changed.
        if (!queueUnchanged || !currentUnchanged) {
            player.setMediaItems(mediaItems, startIndex, Math.max(0L, requestedPositionMs));
            player.prepare();
            queueSignature = signature;
            currentTrackId = currentId.isEmpty() ? mediaItems.get(startIndex).mediaId : currentId;
        }

        if (shouldPlay) player.play();
        else player.pause();
        active = true;
        savePlaybackSnapshot();
        publishNativeState();
    }

    private void handleActionInternal(String action) {
        if (player == null || action == null) return;
        switch (action) {
            case PlaybackNotificationPlugin.ACTION_PLAY:
            case "play":
                if (player.getMediaItemCount() > 0) player.play();
                break;
            case PlaybackNotificationPlugin.ACTION_PAUSE:
            case "pause":
                player.pause();
                break;
            case PlaybackNotificationPlugin.ACTION_NEXT:
            case "next":
                if (player.getMediaItemCount() > 0) {
                    if (player.hasNextMediaItem()) player.seekToNextMediaItem();
                    else player.seekTo(0, 0L);
                    player.play();
                }
                break;
            case PlaybackNotificationPlugin.ACTION_PREVIOUS:
            case "previous":
                if (player.getCurrentPosition() > 3000L) player.seekTo(0L);
                else if (player.hasPreviousMediaItem()) player.seekToPreviousMediaItem();
                else if (player.getMediaItemCount() > 0) player.seekTo(player.getMediaItemCount() - 1, 0L);
                break;
            default:
                return;
        }
        savePlaybackSnapshot();
        publishNativeState();
    }

    private void savePlaybackSnapshot() {
        if (!active || player == null || player.getCurrentMediaItem() == null) return;
        StringBuilder builder = new StringBuilder();
        JSONArray queue = new JSONArray();
        try {
            for (int i = 0; i < player.getMediaItemCount(); i++) {
                MediaItem item = player.getMediaItemAt(i);
                JSONObject row = new JSONObject();
                MediaMetadata metadata = item.mediaMetadata;
                row.put("id", item.mediaId);
                row.put("uri", item.localConfiguration == null ? "" : item.localConfiguration.uri.toString());
                row.put("title", metadata.title == null ? "" : metadata.title.toString());
                row.put("artist", metadata.artist == null ? "" : metadata.artist.toString());
                row.put("artworkUri", metadata.artworkUri == null ? "" : metadata.artworkUri.toString());
                queue.put(row);
            }
            builder.append(queue);
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                .putString(PREF_QUEUE, builder.toString())
                .putString(PREF_CURRENT, player.getCurrentMediaItem().mediaId)
                .putLong(PREF_POSITION, Math.max(0L, player.getCurrentPosition()))
                .putLong(PREF_DURATION, player.getDuration() == C.TIME_UNSET ? 0L : Math.max(0L, player.getDuration()))
                .putBoolean(PREF_PLAYING, player.getPlayWhenReady())
                .putBoolean(PREF_SHUFFLE, player.getShuffleModeEnabled())
                .putBoolean(PREF_REPEAT, player.getRepeatMode() == Player.REPEAT_MODE_ONE)
                .apply();
        } catch (Exception ignored) {}
    }

    private void updateTrackFromPlayer() {
        if (player == null || player.getCurrentMediaItem() == null) {
            currentTrackId = "";
            publishNativeState();
            return;
        }
        currentTrackId = player.getCurrentMediaItem().mediaId;
        savePlaybackSnapshot();
        publishNativeState();
    }

    private void publishNativeState() {
        if (player == null) return;
        try {
            JSONObject snapshot = new JSONObject();
            // Queue changes come from the WebView bridge; native progress events only
            // carry the active item and state. The full queue is sent on explicit state queries.
            fillState(snapshot, false);
            PlaybackNotificationPlugin.notifyNativePlaybackState(snapshot);
        } catch (Exception ignored) {}
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        boolean playing = player != null && player.isPlaying();
        long positionMs = player == null ? 0L : Math.max(0L, player.getCurrentPosition());
        PlaybackNotificationPlugin.logDiagnostic(
            "TASK_REMOVED",
            "playing=" + playing + ", active=" + active + ", positionMs=" + positionMs
        );
        if (active) savePlaybackSnapshot();
        // Media3's default implementation keeps playback running while a session is
        // playing in the foreground, and stops an idle service when the app is dismissed.
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        PlaybackNotificationPlugin.logDiagnostic(
            "SERVICE_DESTROY",
            "active=" + active + ", playing=" + (player != null && player.isPlaying()) +
                ", hasItem=" + (player != null && player.getCurrentMediaItem() != null)
        );
        if (active) savePlaybackSnapshot();
        active = false;
        if (player != null) {
            player.release();
            player = null;
        }
        if (mediaSession != null) {
            mediaSession.release();
            mediaSession = null;
        }
        if (activeService != null && activeService.get() == this) {
            activeService = new WeakReference<>(null);
        }
        super.onDestroy();
    }

}
