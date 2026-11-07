package com.localify.crimson;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadataRetriever;
import android.os.Environment;
import android.webkit.MimeTypeMap;
import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.ActivityCallback;
import android.content.ContentValues;
import android.database.Cursor;
import android.os.Build;
import android.util.Log;
import android.provider.MediaStore;
import com.yausername.ffmpeg.FFmpeg;
import com.yausername.youtubedl_android.YoutubeDL;
import com.yausername.youtubedl_android.YoutubeDLException;
import com.yausername.youtubedl_android.YoutubeDLRequest;
import com.yausername.youtubedl_android.YoutubeDLResponse;
import com.yausername.youtubedl_android.mapper.VideoFormat;
import com.yausername.youtubedl_android.mapper.VideoInfo;
import kotlin.Unit;
import kotlin.jvm.functions.Function3;
import org.json.JSONObject;
import org.json.JSONArray;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.List;
import java.util.ArrayList;
import java.util.Locale;
import java.util.Collections;
import java.util.Set;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Semaphore;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

@CapacitorPlugin(name = "CrimsonYtDlp")
public class YtDlpPlugin extends Plugin {
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private volatile boolean initialized = false;
    private volatile String initError = "";
    private volatile File cookiesFile;
    private final Object runtimeUpdateLock = new Object();
    private static final String TAG = "CrimsonYtDlp";
    private static final String RUNTIME_PREFS = "crimson_ytdlp_runtime";
    private static final String RUNTIME_LAST_ATTEMPT = "lastStableUpdateAttempt";
    private static final String RUNTIME_LAST_FAILED = "lastStableUpdateFailed";

    private static final String STORAGE_PREFS = "localify_storage";
    private static final String LIBRARY_TREE_URI = "libraryTreeUri";
    private static final String DOWNLOAD_TREE_URI = "downloadTreeUri";

    // The library extracts its Python/yt-dlp and FFmpeg runtime on first real use.
    // Automatic stable-channel checks are throttled, not run on every download.
    private synchronized void ensureReady() throws Exception {
        if (!initialized) {
            try {
                YoutubeDL.getInstance().init(getContext());
                FFmpeg.getInstance().init(getContext());
                initialized = true;
                initError = "";
            } catch (YoutubeDLException ex) {
                initError = "Не удалось инициализировать встроенный загрузчик.";
                Log.e(TAG, "Runtime initialization failed", ex);
                throw new IllegalStateException(initError + " " + safeMessage(ex), ex);
            }
        }
        maybeUpdateRuntime();
    }

    private String runtimeVersionName() {
        if (!initialized) return "";
        try { return safe(YoutubeDL.getInstance().versionName(getContext())); }
        catch (Exception ex) {
            Log.w(TAG, "Unable to read yt-dlp runtime version", ex);
            return "";
        }
    }

    private void maybeUpdateRuntime() {
        synchronized (runtimeUpdateLock) {
            android.content.SharedPreferences prefs = getContext().getSharedPreferences(RUNTIME_PREFS, Context.MODE_PRIVATE);
            long lastAttempt = prefs.getLong(RUNTIME_LAST_ATTEMPT, 0L);
            boolean lastFailed = prefs.getBoolean(RUNTIME_LAST_FAILED, false);
            long cooldown = lastFailed ? TimeUnit.HOURS.toMillis(24) : TimeUnit.DAYS.toMillis(7);
            long now = System.currentTimeMillis();
            if (lastAttempt > 0L && now - lastAttempt < cooldown) return;
            prefs.edit().putLong(RUNTIME_LAST_ATTEMPT, now).putBoolean(RUNTIME_LAST_FAILED, true).apply();
            notifyRuntimeUpdate("CHECKING", runtimeVersionName(), "Проверяется стабильное обновление yt-dlp.");
            try {
                Object status = YoutubeDL.getInstance().updateYoutubeDL(getContext(), YoutubeDL.UpdateChannel._STABLE);
                String state = status == null ? "UNKNOWN" : status.toString().toUpperCase(Locale.ROOT);
                boolean failed = !isRuntimeUpdateSuccess(state);
                prefs.edit().putBoolean(RUNTIME_LAST_FAILED, failed).apply();
                notifyRuntimeUpdate(failed ? "ERROR" : state, runtimeVersionName(), "");
            } catch (Exception ex) {
                Log.w(TAG, "Scheduled stable yt-dlp update failed", ex);
                prefs.edit().putBoolean(RUNTIME_LAST_FAILED, true).apply();
                notifyRuntimeUpdate("ERROR", runtimeVersionName(), "Обновление не удалось; используется текущая версия.");
            }
        }
    }

    private boolean isRuntimeUpdateSuccess(String state) {
        return "DONE".equals(state) || "ALREADY_UP_TO_DATE".equals(state);
    }

    private void notifyRuntimeUpdate(String status, String version, String message) {
        JSObject event = new JSObject();
        event.put("status", status);
        event.put("runtimeVersion", version == null ? "" : version);
        if (message != null && !message.isEmpty()) event.put("message", message);
        notifyListeners("ytDlpUpdate", event);
    }

    private JSObject updateStableRuntimeNow() throws Exception {
        ensureRuntimeInitializedOnly();
        synchronized (runtimeUpdateLock) {
            android.content.SharedPreferences prefs = getContext().getSharedPreferences(RUNTIME_PREFS, Context.MODE_PRIVATE);
            prefs.edit().putLong(RUNTIME_LAST_ATTEMPT, System.currentTimeMillis()).putBoolean(RUNTIME_LAST_FAILED, true).apply();
            notifyRuntimeUpdate("CHECKING", runtimeVersionName(), "Проверяется стабильное обновление yt-dlp.");
            Object status = YoutubeDL.getInstance().updateYoutubeDL(getContext(), YoutubeDL.UpdateChannel._STABLE);
            String state = status == null ? "UNKNOWN" : status.toString().toUpperCase(Locale.ROOT);
            boolean failed = !isRuntimeUpdateSuccess(state);
            prefs.edit().putBoolean(RUNTIME_LAST_FAILED, failed).apply();
            String version = runtimeVersionName();
            notifyRuntimeUpdate(failed ? "ERROR" : state, version, "");
            JSObject result = new JSObject();
            result.put("status", failed ? "ERROR" : state);
            result.put("runtimeVersion", version);
            return result;
        }
    }

    private synchronized void ensureRuntimeInitializedOnly() throws Exception {
        if (initialized) return;
        try {
            YoutubeDL.getInstance().init(getContext());
            FFmpeg.getInstance().init(getContext());
            initialized = true;
            initError = "";
        } catch (YoutubeDLException ex) {
            Log.e(TAG, "Runtime initialization failed before explicit update", ex);
            throw new IllegalStateException("Не удалось инициализировать встроенный загрузчик.", ex);
        }
    }


    @PluginMethod
    public void folderStatus(PluginCall call) {
        String libraryUri = storagePrefs().getString(LIBRARY_TREE_URI, "");
        String downloadUri = storagePrefs().getString(DOWNLOAD_TREE_URI, "");
        JSObject result = new JSObject();
        result.put("libraryFolderName", folderName(libraryUri));
        result.put("downloadFolderName", folderName(downloadUri));
        result.put("hasLibraryFolder", libraryUri != null && !libraryUri.isEmpty());
        result.put("hasDownloadFolder", downloadUri != null && !downloadUri.isEmpty());
        call.resolve(result);
    }

    @PluginMethod
    public void chooseLibraryFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "libraryFolderResult");
    }

    @ActivityCallback
    private void libraryFolderResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null
            || result.getData().getData() == null) {
            call.reject("Выбор папки медиатеки отменён.");
            return;
        }
        Uri treeUri = result.getData().getData();
        try {
            int flags = result.getData().getFlags()
                & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            getContext().getContentResolver().takePersistableUriPermission(treeUri, flags);
            storagePrefs().edit().putString(LIBRARY_TREE_URI, treeUri.toString()).apply();
            JSObject response = new JSObject();
            response.put("folderName", folderName(treeUri.toString()));
            call.resolve(response);
        } catch (Exception ex) {
            call.reject("Не удалось сохранить доступ к папке: " + safeMessage(ex));
        }
    }

    @PluginMethod
    public void chooseDownloadFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
            | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "downloadFolderResult");
    }

    @ActivityCallback
    private void downloadFolderResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null
            || result.getData().getData() == null) {
            call.reject("Выбор папки загрузок отменён.");
            return;
        }
        Uri treeUri = result.getData().getData();
        try {
            int flags = result.getData().getFlags()
                & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            getContext().getContentResolver().takePersistableUriPermission(treeUri, flags);
            storagePrefs().edit().putString(DOWNLOAD_TREE_URI, treeUri.toString()).apply();
            JSObject response = new JSObject();
            response.put("folderName", folderName(treeUri.toString()));
            call.resolve(response);
        } catch (Exception ex) {
            call.reject("Не удалось сохранить доступ к папке загрузок: " + safeMessage(ex));
        }
    }

    @PluginMethod
    public void resetDownloadFolder(PluginCall call) {
        storagePrefs().edit().remove(DOWNLOAD_TREE_URI).apply();
        call.resolve();
    }

    @PluginMethod
    public void scanLibraryFolder(PluginCall call) {
        executor.execute(() -> {
            try {
                call.resolve(scanStoredLibraryFolder());
            } catch (Exception ex) {
                call.reject("Не удалось просканировать папку медиатеки: " + safeMessage(ex));
            }
        });
    }

    private android.content.SharedPreferences storagePrefs() {
        return getContext().getSharedPreferences(STORAGE_PREFS, Context.MODE_PRIVATE);
    }

    private String folderName(String uriText) {
        if (uriText == null || uriText.isEmpty()) return "";
        try {
            DocumentFile root = DocumentFile.fromTreeUri(getContext(), Uri.parse(uriText));
            if (root != null && root.getName() != null) return root.getName();
        } catch (Exception ignored) {}
        return "";
    }

    private JSObject scanStoredLibraryFolder() throws Exception {
        String treeText = storagePrefs().getString(LIBRARY_TREE_URI, "");
        JSObject result = new JSObject();
        JSArray files = new JSArray();
        if (treeText == null || treeText.isEmpty()) {
            result.put("selected", false);
            result.put("files", files);
            result.put("folderName", "");
            return result;
        }
        DocumentFile root = DocumentFile.fromTreeUri(getContext(), Uri.parse(treeText));
        if (root == null || !root.isDirectory()) {
            throw new IllegalStateException("Выбранная папка недоступна. Выбери её заново в настройках.");
        }
        scanDirectory(root, files);
        result.put("selected", true);
        result.put("folderName", root.getName() == null ? "Выбранная папка" : root.getName());
        result.put("files", files);
        result.put("count", files.length());
        return result;
    }

    private void scanDirectory(DocumentFile directory, JSArray output) throws Exception {
        DocumentFile[] children = directory.listFiles();
        for (DocumentFile child : children) {
            if (child == null) continue;
            if (child.isDirectory()) {
                scanDirectory(child, output);
            } else if (child.isFile() && isAudioDocument(child)) {
                try {
                    File localFile = cacheLibraryDocument(child);
                    JSObject item = new JSObject();
                    item.put("name", child.getName() == null ? localFile.getName() : child.getName());
                    item.put("path", localFile.getAbsolutePath());
                    item.put("size", localFile.length());
                    item.put("duration", readAudioDurationSeconds(localFile));
                    item.put("lastModified", child.lastModified());
                    String sourceUri = child.getUri().toString();
                    item.put("sourceId", sourceUri);
                    String coverPath = cacheEmbeddedCover(localFile, sourceUri);
                    if (!coverPath.isEmpty()) item.put("coverPath", coverPath);
                    output.put(item);
                } catch (Exception ignored) {
                    // One unreadable track must not prevent the rest of the folder from being scanned.
                }
            }
        }
    }

    private double readAudioDurationSeconds(File audio) {
        MediaMetadataRetriever retriever = null;
        try {
            retriever = new MediaMetadataRetriever();
            retriever.setDataSource(audio.getAbsolutePath());
            String durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            if (durationMs == null || durationMs.isEmpty()) return 0;
            long milliseconds = Long.parseLong(durationMs);
            return milliseconds > 0 ? milliseconds / 1000.0 : 0;
        } catch (Exception ignored) {
            return 0;
        } finally {
            if (retriever != null) {
                try { retriever.release(); } catch (Exception ignored) {}
            }
        }
    }

    private boolean isAudioDocument(DocumentFile file) {
        String mime = file.getType();
        if (mime != null && mime.toLowerCase(Locale.ROOT).startsWith("audio/")) return true;
        String name = file.getName() == null ? "" : file.getName().toLowerCase(Locale.ROOT);
        return name.matches(".*\\.(mp3|m4a|aac|ogg|opus|wav|flac|webm|oga|mp4)$");
    }

    private String cacheEmbeddedCover(File audio, String sourceKey) {
        MediaMetadataRetriever retriever = null;
        File marker = null;
        try {
            File directory = new File(getContext().getFilesDir(), "cover-cache");
            if (!directory.exists() && !directory.mkdirs()) return "";
            String key = Integer.toHexString(sourceKey.hashCode()) + "_" + audio.length() + "_" + audio.lastModified();
            File png = new File(directory, key + ".png");
            File jpg = new File(directory, key + ".jpg");
            marker = new File(directory, key + ".none");
            if (png.isFile() && png.length() > 0) return png.getAbsolutePath();
            if (jpg.isFile() && jpg.length() > 0) return jpg.getAbsolutePath();
            if (marker.isFile()) return "";

            retriever = new MediaMetadataRetriever();
            retriever.setDataSource(audio.getAbsolutePath());
            byte[] picture = retriever.getEmbeddedPicture();
            if (picture == null || picture.length == 0) {
                marker.createNewFile();
                return "";
            }
            byte[] thumbnail = picture;
            Bitmap bitmap = null;
            try {
                BitmapFactory.Options bounds = new BitmapFactory.Options();
                bounds.inJustDecodeBounds = true;
                BitmapFactory.decodeByteArray(picture, 0, picture.length, bounds);
                int sample = 1;
                while (Math.max(bounds.outWidth / sample, bounds.outHeight / sample) > 512) sample *= 2;
                BitmapFactory.Options options = new BitmapFactory.Options();
                options.inSampleSize = sample;
                bitmap = BitmapFactory.decodeByteArray(picture, 0, picture.length, options);
                if (bitmap != null) {
                    try (ByteArrayOutputStream buffer = new ByteArrayOutputStream()) {
                        bitmap.compress(Bitmap.CompressFormat.JPEG, 82, buffer);
                        if (buffer.size() > 0) thumbnail = buffer.toByteArray();
                    }
                }
            } catch (Exception ignored) {
                thumbnail = picture;
            } finally {
                if (bitmap != null) {
                    try { bitmap.recycle(); } catch (Exception ignored) {}
                }
            }
            File target = new File(directory, key + ".jpg");
            try (FileOutputStream output = new FileOutputStream(target)) {
                output.write(thumbnail);
                output.flush();
            }
            return target.getAbsolutePath();
        } catch (Exception ignored) {
            try { if (marker != null && !marker.exists()) marker.createNewFile(); } catch (Exception ignoredAgain) {}
            return "";
        } finally {
            if (retriever != null) {
                try { retriever.release(); } catch (Exception ignored) {}
            }
        }
    }

    private File cacheLibraryDocument(DocumentFile source) throws Exception {
        String originalName = source.getName() == null ? "audio" : source.getName();
        String uriText = source.getUri().toString();
        String hash = Integer.toHexString(uriText.hashCode());
        String safeName = originalName.replaceAll("[^A-Za-z0-9._ -]", "_");
        File directory = new File(getContext().getFilesDir(), "library-cache");
        if (!directory.exists() && !directory.mkdirs()) {
            throw new IllegalStateException("Не удалось создать кеш медиатеки.");
        }
        File target = new File(directory, hash + "_" + safeName);
        long sourceTime = source.lastModified();
        long knownTime = storagePrefs().getLong("sourceTime_" + hash, -1);
        if (!target.isFile() || target.length() != source.length() || knownTime != sourceTime) {
            try (java.io.InputStream input = getContext().getContentResolver().openInputStream(source.getUri());
                 java.io.OutputStream output = new java.io.FileOutputStream(target, false)) {
                if (input == null) throw new IllegalStateException("Файл недоступен для чтения.");
                byte[] buffer = new byte[64 * 1024];
                int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            }
            storagePrefs().edit().putLong("sourceTime_" + hash, sourceTime).apply();
        }
        return target;
    }



    // ===== Управление загрузками: жёсткий предел параллелизма, отмена, разбор прогресса yt-dlp =====
    // JS-очередь ограничивает число одновременных скачиваний (по умолчанию 2); этот предел — защита на случай ошибки.
    private static final int MAX_PARALLEL_DOWNLOADS = 4;
    private static final long PROGRESS_EMIT_INTERVAL_MS = 200L;
    private static final long INFO_FILE_MAX_AGE_MS = 20L * 60L * 1000L;
    private final Semaphore downloadPermits = new Semaphore(MAX_PARALLEL_DOWNLOADS);
    private final ConcurrentHashMap<String, String> activeProcesses = new ConcurrentHashMap<>();
    private final Set<String> cancelledDownloads = Collections.newSetFromMap(new ConcurrentHashMap<String, Boolean>());
    private static final Pattern DOWNLOAD_LINE = Pattern.compile(
        "\\[download\\]\\s+([\\d.]+)%\\s+of\\s+~?\\s*([\\d.]+)\\s*([KMG]?i?B)(?:\\s+at\\s+([\\d.]+)\\s*([KMG]?i?B)/s)?");

    private static double unitToBytes(double value, String unit) {
        String u = unit == null ? "" : unit.toUpperCase(Locale.ROOT);
        if (u.startsWith("K")) return value * 1024d;
        if (u.startsWith("M")) return value * 1024d * 1024d;
        if (u.startsWith("G")) return value * 1024d * 1024d * 1024d;
        return value;
    }

    private static String phaseFromLine(String line, String previous) {
        String text = line == null ? "" : line;
        if (text.contains("[ExtractAudio]")) return "converting";
        if (text.contains("[Metadata]") || text.contains("[FixupM4a]") || text.contains("[FixupM3u8]")) return "metadata";
        if (text.contains("[EmbedThumbnail]") || text.contains("[ThumbnailsConvertor]") || text.contains("thumbnail")) return "thumbnail";
        if (text.contains("[download]")) return "downloading";
        if (text.startsWith("[youtube") || text.startsWith("[info]")) return "extracting";
        return previous;
    }

    /** Ошибки отсутствия сети: перебирать остальные стратегии бессмысленно, они упадут так же и каждая будет ждать тайм-аут. */
    private static boolean isOfflineFailure(String message) {
        String lower = message == null ? "" : message.toLowerCase(Locale.ROOT);
        return lower.contains("temporary failure in name resolution") || lower.contains("network is unreachable")
            || lower.contains("unable to resolve host") || lower.contains("no address associated with hostname")
            || lower.contains("failed to resolve") || lower.contains("no route to host");
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        String id = cleanFilePart(safe(call.getString("id")));
        if (id.isEmpty()) { call.reject("Не указан идентификатор загрузки."); return; }
        cancelledDownloads.add(id);
        String processId = activeProcesses.get(id);
        if (processId != null) {
            try { YoutubeDL.getInstance().destroyProcessById(processId); } catch (Exception ex) { Log.w(TAG, "Could not destroy process " + processId, ex); }
        }
        call.resolve();
    }


    // ===== Плейлисты как папки: «Crimson Playlists/<название>/» с музыкой и манифестом =====
    private static final String PLAYLISTS_DIR = "Crimson Playlists";
    private static final String PLAYLIST_MANIFEST = "crimson-playlist.json";

    /** Корневая папка плейлистов внутри выбранной пользователем папки (медиатека, затем загрузки). */
    private DocumentFile playlistsRoot(boolean create) {
        for (String key : new String[] {LIBRARY_TREE_URI, DOWNLOAD_TREE_URI}) {
            String tree = storagePrefs().getString(key, "");
            if (tree == null || tree.isEmpty()) continue;
            try {
                DocumentFile root = DocumentFile.fromTreeUri(getContext(), Uri.parse(tree));
                if (root == null || !root.isDirectory() || !root.canWrite()) continue;
                DocumentFile dir = root.findFile(PLAYLISTS_DIR);
                if ((dir == null || !dir.isDirectory()) && create) dir = root.createDirectory(PLAYLISTS_DIR);
                if (dir != null && dir.isDirectory()) return dir;
            } catch (Exception ignored) { /* пробуем следующую папку */ }
        }
        return null;
    }

    private static String mimeForAudioName(String name) {
        String lower = name == null ? "" : name.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".mp3")) return "audio/mpeg";
        if (lower.endsWith(".m4a") || lower.endsWith(".mp4") || lower.endsWith(".aac")) return "audio/mp4";
        if (lower.endsWith(".ogg") || lower.endsWith(".oga") || lower.endsWith(".opus")) return "audio/ogg";
        if (lower.endsWith(".flac")) return "audio/flac";
        if (lower.endsWith(".wav")) return "audio/wav";
        if (lower.endsWith(".webm")) return "audio/webm";
        return "application/octet-stream";
    }

    private Set<String> readManagedNames(DocumentFile dir) {
        Set<String> managed = new java.util.LinkedHashSet<>();
        try {
            DocumentFile manifest = dir.findFile(PLAYLIST_MANIFEST);
            if (manifest == null) return managed;
            try (java.io.InputStream in = getContext().getContentResolver().openInputStream(manifest.getUri())) {
                if (in == null) return managed;
                JSONArray names = new JSONObject(BackupStore.readAll(in)).optJSONArray("managed");
                if (names != null) for (int i = 0; i < names.length(); i++) managed.add(names.getString(i));
            }
        } catch (Exception ignored) { /* нет манифеста — ничего не считаем нашим */ }
        return managed;
    }

    private void writeDocumentText(DocumentFile dir, String name, String text) throws Exception {
        DocumentFile file = dir.findFile(name);
        if (file == null) file = dir.createFile("application/json", name);
        if (file == null) throw new IllegalStateException("Не удалось создать " + name);
        try (OutputStream out = getContext().getContentResolver().openOutputStream(file.getUri(), "wt")) {
            if (out == null) throw new IllegalStateException("Файл недоступен для записи.");
            out.write(text.getBytes(StandardCharsets.UTF_8));
        }
    }

    /** Сверяет содержимое старой копии с каноническим файлом, чтобы удалять только точные дубликаты. */
    private boolean sameDocumentContent(DocumentFile document, File source) {
        if (document == null || source == null || !source.isFile()) return false;
        long documentLength = document.length();
        if (documentLength <= 0L || documentLength != source.length()) return false;
        try {
            MessageDigest left = MessageDigest.getInstance("SHA-256");
            MessageDigest right = MessageDigest.getInstance("SHA-256");
            try (InputStream in = getContext().getContentResolver().openInputStream(document.getUri());
                 InputStream sourceIn = new FileInputStream(source)) {
                if (in == null) return false;
                byte[] buffer = new byte[64 * 1024];
                int count;
                while ((count = in.read(buffer)) != -1) left.update(buffer, 0, count);
                while ((count = sourceIn.read(buffer)) != -1) right.update(buffer, 0, count);
            }
            return java.util.Arrays.equals(left.digest(), right.digest());
        } catch (Exception error) {
            Log.w(TAG, "Could not verify legacy playlist duplicate", error);
            return false;
        }
    }

    /**
     * Создаёт папку плейлиста и записывает манифест-ссылки. Аудио не копируется:
     * SAF/DocumentFile не предоставляет переносимый механизм hard link или symlink.
     * Старые управляемые копии удаляются только после побайтовой проверки с оригиналом.
     */
    @PluginMethod
    public void syncPlaylistFolder(PluginCall call) {
        final String folderName = safe(call.getString("folderName"));
        final String previousName = safe(call.getString("previousName"));
        final String manifestText = safe(call.getString("manifest"));
        final JSArray files = call.getArray("files");
        if (folderName.isEmpty() || manifestText.isEmpty()) { call.reject("Недостаточно данных плейлиста."); return; }
        executor.execute(() -> {
            try {
                DocumentFile root = playlistsRoot(true);
                if (root == null) { call.reject("Выбери папку с музыкой или загрузок в настройках: в ней появится «" + PLAYLISTS_DIR + "»."); return; }
                if (!previousName.isEmpty() && !previousName.equals(folderName)) {
                    DocumentFile old = root.findFile(previousName);
                    if (old != null && old.isDirectory() && root.findFile(folderName) == null) old.renameTo(folderName);
                }
                DocumentFile dir = root.findFile(folderName);
                if (dir == null || !dir.isDirectory()) dir = root.createDirectory(folderName);
                if (dir == null) throw new IllegalStateException("Не удалось создать папку плейлиста.");

                Map<String, File> canonicalByName = new java.util.HashMap<>();
                if (files != null) {
                    for (int i = 0; i < files.length(); i++) {
                        JSONObject item = files.getJSONObject(i);
                        String name = item.optString("fileName", "");
                        String path = item.optString("path", "");
                        if (!name.isEmpty() && !path.isEmpty()) canonicalByName.put(name.toLowerCase(Locale.ROOT), new File(path));
                    }
                }

                // Миграция со старой версии: ранее Crimson копировал аудио в каждую папку.
                // Удаляем только собственные копии, содержимое которых точно совпадает с оригиналом.
                int cleaned = 0;
                Set<String> legacyManaged = readManagedNames(dir);
                for (String name : legacyManaged) {
                    DocumentFile legacy = dir.findFile(name);
                    File source = canonicalByName.get(name.toLowerCase(Locale.ROOT));
                    if (legacy != null && source != null && sameDocumentContent(legacy, source) && legacy.delete()) cleaned++;
                }

                JSONObject manifest = new JSONObject(manifestText);
                manifest.put("schema", 2);
                // Ни один аудиофайл этой папки больше не считается принадлежащим Crimson.
                // Файлы, добавленные пользователем вручную, сохраняются и подхватываются при восстановлении.
                manifest.put("managed", new JSONArray());
                writeDocumentText(dir, PLAYLIST_MANIFEST, manifest.toString());
                JSObject result = new JSObject();
                result.put("copied", 0);
                result.put("cleanedDuplicates", cleaned);
                result.put("linked", canonicalByName.size());
                call.resolve(result);
            } catch (Exception ex) {
                call.reject("Не удалось сохранить плейлист в папку: " + safeMessage(ex));
            }
        });
    }

    /** Удаляет только манифест плейлиста. Аудиофайлы — пользовательские данные и не удаляются. */
    private void deletePlaylistDirectory(DocumentFile dir) {
        DocumentFile manifest = dir.findFile(PLAYLIST_MANIFEST);
        if (manifest != null) manifest.delete();
        DocumentFile[] rest = dir.listFiles();
        if (rest == null || rest.length == 0) dir.delete();
    }

    @PluginMethod
    public void deletePlaylistFolder(PluginCall call) {
        final String folderName = safe(call.getString("folderName"));
        executor.execute(() -> {
            try {
                DocumentFile root = playlistsRoot(false);
                DocumentFile dir = root == null || folderName.isEmpty() ? null : root.findFile(folderName);
                if (dir != null && dir.isDirectory()) deletePlaylistDirectory(dir);
                call.resolve();
            } catch (Exception ex) {
                call.reject("Не удалось удалить папку плейлиста: " + safeMessage(ex));
            }
        });
    }

    @PluginMethod
    public void deleteAllPlaylistFolders(PluginCall call) {
        executor.execute(() -> {
            try {
                DocumentFile root = playlistsRoot(false);
                if (root != null) {
                    for (DocumentFile child : root.listFiles()) if (child.isDirectory()) deletePlaylistDirectory(child);
                    DocumentFile[] rest = root.listFiles();
                    if (rest == null || rest.length == 0) root.delete();
                }
                call.resolve();
            } catch (Exception ex) {
                call.reject("Не удалось удалить папки плейлистов: " + safeMessage(ex));
            }
        });
    }

    /** Папки плейлистов с манифестами и списком аудиофайлов: для восстановления после переустановки. */
    @PluginMethod
    public void readPlaylistFolders(PluginCall call) {
        executor.execute(() -> {
            JSArray folders = new JSArray();
            try {
                DocumentFile root = playlistsRoot(false);
                if (root != null) {
                    for (DocumentFile dir : root.listFiles()) {
                        if (dir == null || !dir.isDirectory()) continue;
                        DocumentFile manifest = dir.findFile(PLAYLIST_MANIFEST);
                        if (manifest == null) continue;
                        String text;
                        try (java.io.InputStream in = getContext().getContentResolver().openInputStream(manifest.getUri())) {
                            text = in == null ? "" : BackupStore.readAll(in);
                        } catch (Exception unreadable) { continue; }
                        JSArray audio = new JSArray();
                        for (DocumentFile file : dir.listFiles()) {
                            if (file == null || !file.isFile() || !isAudioDocument(file)) continue;
                            JSObject item = new JSObject();
                            item.put("name", file.getName());
                            item.put("sourceId", file.getUri().toString());
                            item.put("size", file.length());
                            item.put("lastModified", file.lastModified());
                            audio.put(item);
                        }
                        JSObject entry = new JSObject();
                        entry.put("dirName", dir.getName());
                        entry.put("manifest", text);
                        entry.put("files", audio);
                        folders.put(entry);
                    }
                }
            } catch (Exception ex) {
                Log.w(TAG, "readPlaylistFolders failed", ex);
            }
            JSObject result = new JSObject();
            result.put("folders", folders);
            call.resolve(result);
        });
    }

    /** Файлы из папок плейлистов, которых нет в библиотеке: готовим их так же, как при сканировании. */
    @PluginMethod
    public void ingestPlaylistFiles(PluginCall call) {
        final JSArray sources = call.getArray("sourceIds");
        executor.execute(() -> {
            JSArray rows = new JSArray();
            try {
                for (int i = 0; sources != null && i < sources.length(); i++) {
                    String sourceUri = sources.optString(i, "");   // optString не бросает JSONException
                    if (sourceUri.isEmpty()) continue;
                    try {
                        DocumentFile document = DocumentFile.fromSingleUri(getContext(), Uri.parse(sourceUri));
                        if (document == null || !document.isFile()) continue;
                        File localFile = cacheLibraryDocument(document);
                        JSObject row = new JSObject();
                        row.put("sourceId", sourceUri);
                        row.put("name", document.getName() == null ? "audio" : document.getName());
                        row.put("path", localFile.getAbsolutePath());
                        row.put("size", localFile.length());
                        row.put("duration", readAudioDurationSeconds(localFile));
                        row.put("lastModified", document.lastModified());
                        String coverPath = cacheEmbeddedCover(localFile, sourceUri);
                        if (!coverPath.isEmpty()) row.put("coverPath", coverPath);
                        rows.put(row);
                    } catch (Exception skip) { Log.w(TAG, "Ingest skipped " + sourceUri, skip); }
                }
            } finally {
                JSObject result = new JSObject();
                result.put("rows", rows);
                call.resolve(result);
            }
        });
    }

    // ===== Резервные копии пользовательских данных =====
    @PluginMethod
    public void saveBackup(PluginCall call) {
        final String json = call.getString("json", "");
        executor.execute(() -> {
            try {
                BackupStore.save(getContext(), json); // атомарная приватная копия + ротация истории
                String libraryTree = storagePrefs().getString(LIBRARY_TREE_URI, "");
                String downloadTree = storagePrefs().getString(DOWNLOAD_TREE_URI, "");
                boolean mirroredToLibrary = BackupStore.mirror(getContext(), libraryTree, json);
                boolean mirroredToDownloads = BackupStore.mirror(getContext(), downloadTree, json);
                JSObject result = new JSObject();
                result.put("mirroredToLibrary", mirroredToLibrary);
                result.put("mirroredToDownloads", mirroredToDownloads);
                call.resolve(result);
            } catch (Exception ex) {
                call.reject("Не удалось сохранить резервную копию: " + safeMessage(ex));
            }
        });
    }

    @PluginMethod
    public void readBackups(PluginCall call) {
        executor.execute(() -> {
            JSArray backups = new JSArray();
            String libraryTree = storagePrefs().getString(LIBRARY_TREE_URI, "");
            String downloadTree = storagePrefs().getString(DOWNLOAD_TREE_URI, "");
            for (String[] item : BackupStore.readAllCandidates(getContext(), libraryTree, downloadTree)) {
                JSObject entry = new JSObject();
                entry.put("source", item[0]);
                entry.put("text", item[1]);
                backups.put(entry);
            }
            JSObject result = new JSObject();
            result.put("backups", backups);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void wipeBackups(PluginCall call) {
        executor.execute(() -> {
            BackupStore.wipe(getContext(), storagePrefs().getString(LIBRARY_TREE_URI, ""), storagePrefs().getString(DOWNLOAD_TREE_URI, ""));
            call.resolve();
        });
    }

    @PluginMethod
    public void exportFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("application/json");
        intent.putExtra(Intent.EXTRA_TITLE, call.getString("name", "crimson-backup.json"));
        startActivityForResult(call, intent, "exportFileResult");
    }

    @ActivityCallback
    private void exportFileResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("Экспорт отменён.");
            return;
        }
        final Uri target = result.getData().getData();
        final String text = call.getString("text", "");
        executor.execute(() -> {
            try (OutputStream out = getContext().getContentResolver().openOutputStream(target, "wt")) {
                if (out == null) throw new IllegalStateException("Файл недоступен для записи.");
                out.write(text.getBytes(StandardCharsets.UTF_8));
                call.resolve();
            } catch (Exception ex) {
                call.reject("Не удалось записать файл: " + safeMessage(ex));
            }
        });
    }

    @PluginMethod
    public void importFile(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        startActivityForResult(call, intent, "importFileResult");
    }

    @ActivityCallback
    private void importFileResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("Импорт отменён.");
            return;
        }
        final Uri source = result.getData().getData();
        executor.execute(() -> {
            try (java.io.InputStream in = getContext().getContentResolver().openInputStream(source)) {
                if (in == null) throw new IllegalStateException("Файл недоступен для чтения.");
                JSObject response = new JSObject();
                response.put("text", BackupStore.readAll(in));
                call.resolve(response);
            } catch (Exception ex) {
                call.reject("Не удалось прочитать файл: " + safeMessage(ex));
            }
        });
    }

    // ===== Структурированные метаданные YouTube без обработки: разбор выполняет JS (единый механизм) =====
    @PluginMethod
    public void fetchTrackMetadata(PluginCall call) {
        final String url = call.getString("url", "");
        if (url == null || url.isEmpty()) { call.reject("Не указана ссылка."); return; }
        executor.execute(() -> {
            try {
                ensureReady();
                JSONObject metadata = readTrackMetadata(url);
                JSONObject info = identityFields(metadata);
                JSObject result = new JSObject();
                result.put("info", info);
                // Полный ответ сохраняем, чтобы скачивание не извлекало информацию о видео повторно.
                String videoId = cleanFilePart(info.optString("id", ""));
                if (!videoId.isEmpty() && metadata.has("formats")) {
                    File infoFile = new File(getContext().getCacheDir(), "info-" + videoId + ".json");
                    try { BackupStore.writeAtomic(infoFile, metadata.toString()); result.put("infoFile", infoFile.getAbsolutePath()); }
                    catch (Exception ignored) { /* необязательно: скачивание извлечёт информацию само */ }
                }
                call.resolve(result);
            } catch (Exception ex) {
                call.reject("Не удалось получить метаданные: " + safeMessage(ex));
            }
        });
    }

    // ===== Фоновое сканирование папки: пачки событий, пропуск неизменённых файлов, отмена =====
    private final ExecutorService scanExecutor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "crimson-library-scan");
        thread.setPriority(Thread.NORM_PRIORITY - 1);
        return thread;
    });
    private final AtomicBoolean scanRunning = new AtomicBoolean(false);
    private final AtomicBoolean scanCancelled = new AtomicBoolean(false);
    private static final int SCAN_BATCH = 20;

    @PluginMethod
    public void startLibraryScan(PluginCall call) {
        final String treeText = storagePrefs().getString(LIBRARY_TREE_URI, "");
        JSObject started = new JSObject();
        if (treeText == null || treeText.isEmpty()) {
            started.put("selected", false);
            call.resolve(started);
            return;
        }
        if (!scanRunning.compareAndSet(false, true)) {
            started.put("selected", true);
            started.put("alreadyRunning", true);
            call.resolve(started);
            return;
        }
        scanCancelled.set(false);
        final JSObject known = call.getObject("known");
        started.put("selected", true);
        call.resolve(started);
        scanExecutor.execute(() -> {
            try {
                runLibraryScan(treeText, known);
            } catch (Throwable ex) {
                JSObject event = new JSObject();
                event.put("type", "error");
                event.put("message", "Не удалось просканировать папку: " + safeMessage(ex));
                notifyListeners("libraryScanEvent", event);
            } finally {
                scanRunning.set(false);
            }
        });
    }

    @PluginMethod
    public void cancelLibraryScan(PluginCall call) {
        scanCancelled.set(true);
        call.resolve();
    }

    private void collectAudioDocuments(DocumentFile directory, List<DocumentFile> output) {
        if (scanCancelled.get()) return;
        DocumentFile[] children = directory.listFiles();
        for (DocumentFile child : children) {
            if (scanCancelled.get()) return;
            if (child == null) continue;
            if (child.isDirectory()) {
                // Папки плейлистов содержат копии треков: в библиотеку они не добавляются, чтобы не было дубликатов
                // и чтобы удаление плейлиста не могло затронуть файл, на который ссылается библиотека.
                if (PLAYLISTS_DIR.equals(child.getName())) continue;
                collectAudioDocuments(child, output);
            }
            else if (child.isFile() && isAudioDocument(child)) output.add(child);
        }
    }

    private void runLibraryScan(String treeText, JSObject known) throws Exception {
        DocumentFile root = DocumentFile.fromTreeUri(getContext(), Uri.parse(treeText));
        if (root == null || !root.isDirectory()) {
            throw new IllegalStateException("Выбранная папка недоступна. Выбери её заново в настройках.");
        }
        List<DocumentFile> documents = new ArrayList<>();
        collectAudioDocuments(root, documents);   // вложенные папки
        if (scanCancelled.get()) { emitScan("cancelled", 0, 0, 0, ""); return; }
        emitScan("counted", documents.size(), 0, 0, "");

        JSArray batch = new JSArray();
        int processed = 0;
        int corrupted = 0;
        for (DocumentFile document : documents) {
            if (scanCancelled.get()) break;
            String name = document.getName() == null ? "audio" : document.getName();
            String sourceUri = document.getUri().toString();
            try {
                JSObject item = new JSObject();
                item.put("sourceId", sourceUri);
                JSONObject knownEntry = known == null ? null : known.optJSONObject(sourceUri);
                long size = document.length();
                long modified = document.lastModified();
                if (knownEntry != null && knownEntry.optLong("size", -1) == size
                        && knownEntry.optLong("lastModified", -1) == modified && knownEntry.optBoolean("hasDuration", false)) {
                    item.put("unchanged", true);          // метаданные заново не читаем
                    item.put("size", size);
                    item.put("lastModified", modified);
                    item.put("name", name);
                } else {
                    File localFile = cacheLibraryDocument(document);
                    item.put("name", name);
                    item.put("path", localFile.getAbsolutePath());
                    item.put("size", localFile.length());
                    item.put("duration", readAudioDurationSeconds(localFile));
                    item.put("lastModified", modified);
                    String coverPath = cacheEmbeddedCover(localFile, sourceUri);
                    if (!coverPath.isEmpty()) item.put("coverPath", coverPath);
                }
                batch.put(item);
            } catch (Exception ex) {
                corrupted++;   // повреждённый или нечитаемый файл не останавливает сканирование
            }
            processed++;
            if (batch.length() >= SCAN_BATCH || processed == documents.size()) {
                emitBatch(batch, documents.size(), processed, corrupted, name);
                batch = new JSArray();
            }
        }
        if (batch.length() > 0) emitBatch(batch, documents.size(), processed, corrupted, "");
        emitScan(scanCancelled.get() ? "cancelled" : "done", documents.size(), processed, corrupted, "");
    }

    private void emitBatch(JSArray rows, int total, int processed, int corrupted, String currentName) {
        JSObject event = new JSObject();
        event.put("type", "batch");
        event.put("rows", rows);
        event.put("total", total);
        event.put("processed", processed);
        event.put("corrupted", corrupted);
        event.put("currentName", currentName);
        notifyListeners("libraryScanEvent", event);
    }

    private void emitScan(String type, int total, int processed, int corrupted, String currentName) {
        JSObject event = new JSObject();
        event.put("type", type);
        event.put("total", total);
        event.put("processed", processed);
        event.put("corrupted", corrupted);
        event.put("currentName", currentName);
        notifyListeners("libraryScanEvent", event);
    }

    @PluginMethod
    public void status(PluginCall call) {
        // Non-initializing: the first real yt-dlp action extracts the bundled runtime.
        JSObject result = new JSObject();
        result.put("version", "0.18.1"); // Wrapper version, not the embedded yt-dlp version.
        result.put("runtimeVersion", runtimeVersionName());
        result.put("hasCookies", getCookiesFile() != null);
        result.put("initialized", initialized);
        call.resolve(result);
    }

    @PluginMethod
    public void updateYtDlp(PluginCall call) {
        executor.execute(() -> {
            try {
                call.resolve(updateStableRuntimeNow());
            } catch (Exception ex) {
                Log.e(TAG, "Manual stable yt-dlp update failed", ex);
                call.reject("Не удалось обновить встроенный yt-dlp. Проверь подключение к интернету.");
            }
        });
    }


    @PluginMethod
    public void search(PluginCall call) {
        String query = safe(call.getString("query")).replace('\n', ' ').replace('\r', ' ');
        if (query.isEmpty()) {
            call.reject("Введи название трека или исполнителя.");
            return;
        }
        executor.execute(() -> {
            try {
                ensureReady();
                YoutubeDLRequest request = baseRequest("ytsearch6:" + query)
                    .addOption("--dump-json")
                    .addOption("--flat-playlist")
                    .addOption("--ignore-errors")
                    .addOption("--playlist-end", "6");
                String processId = "crimson-search-" + System.nanoTime();
                YoutubeDLResponse response = YoutubeDL.getInstance().execute(request, processId, null);
                JSArray entries = new JSArray();
                String output = response.getOut();
                if (output != null && !output.trim().isEmpty()) {
                    for (String line : output.split("\\R")) {
                        String json = line.trim();
                        if (json.isEmpty() || !json.startsWith("{")) continue;
                        try {
                            appendSearchResult(entries, new JSONObject(json));
                        } catch (Exception ignored) {
                            // Skip malformed result rows; preserve other search results.
                        }
                    }
                }
                JSObject result = new JSObject();
                result.put("results", entries);
                call.resolve(result);
            } catch (Exception ex) {
                call.reject(safeMessage(ex));
            }
        });
    }

    private void appendSearchResult(JSArray entries, JSONObject item) throws Exception {
        String id = item.optString("id", "");
        if (id.isEmpty()) id = item.optString("display_id", "");
        if (id.isEmpty()) {
            String rawUrl = item.optString("url", "");
            if (!rawUrl.startsWith("http")) id = rawUrl;
        }
        if (id.isEmpty()) return;

        String videoUrl = item.optString("webpage_url", "");
        if (videoUrl.isEmpty() || !validUrl(videoUrl)) {
            videoUrl = "https://www.youtube.com/watch?v=" + id;
        }
        String uploader = item.optString("uploader", "");
        String channel = item.optString("channel", "");
        if (channel.isEmpty()) channel = uploader;
        if (uploader.isEmpty()) uploader = channel;

        JSObject video = new JSObject();
        video.put("id", id);
        video.put("title", cleanYouTubeTitle(fallback(item.optString("title", ""), "Без названия"), id));
        video.put("url", videoUrl);
        video.put("duration", item.optDouble("duration", 0));
        video.put("uploader", uploader);
        video.put("channel", channel);
        video.put("thumbnail", readThumbnail(item));
        entries.put(video);
    }

    private String cleanYouTubeTitle(String rawTitle, String videoId) {
        String title = safe(rawTitle);
        String id = safe(videoId);
        if (title.isEmpty()) return "";
        if (id.matches("[A-Za-z0-9_-]{11}")) {
            title = title.replaceFirst("(?i)\\s*[\\[(]" + java.util.regex.Pattern.quote(id) + "[)\\]]\\s*$", "");
        }
        title = title.replaceAll("(?i)\\s*[\\[(](?:official(?:\\s+music)?\\s+(?:video|audio)|music\\s+video|lyric(?:s)?(?:\\s+video)?|visualizer|audio\\s*hq|full\\s*hd|ultra\\s*hd|4k|2160p|1440p|1080p|720p|480p|hd)[)\\]]", " ");
        title = title.replaceAll("(?i)(?:\\s*[|•·]\\s*)?(?:official(?:\\s+music)?\\s+(?:video|audio)|music\\s+video|lyric(?:s)?(?:\\s+video)?|visualizer|audio\\s*hq|full\\s*hd|ultra\\s*hd|4k|2160p|1440p|1080p|720p|480p|hd)\\s*$", "");
        title = title.replaceAll("[\\s|•·-]+$", "").replaceAll("^[\\s|•·]+", "");
        title = title.replaceAll("\\s{2,}", " ").replaceAll("\\s+([,.;!?])", "$1").trim();
        return title;
    }

    private String cleanArtistName(String rawArtist) {
        String artist = safe(rawArtist);
        if (artist.isEmpty()) return "";
        artist = artist.replaceAll("(?i)\\s*[-–—|•·]\\s*Topic\\s*$", "");
        artist = artist.replaceAll("(?i)\\s*[\\[(]\\s*(?:Official(?:\\s+Artist)?(?:\\s+Channel)?|VEVO)\\s*[\\])]\\s*$", "");
        artist = artist.replaceAll("(?i)(?:\\s*[-–—|•·]\\s*)?(?:Official(?:\\s+Artist)?(?:\\s+Channel)?|VEVO)\\s*$", "");
        artist = artist.replaceAll("(?i)\\.VEVO\\s*$", "").replaceAll("\\s*[-–—|•·]+\\s*$", "").trim();
        if (artist.isEmpty()) return "";
        List<String> unique = new ArrayList<>();
        for (String part : artist.split("\\s*[,;]\\s*")) {
            String name = part.trim();
            boolean duplicate = false;
            for (String existing : unique) if (existing.equalsIgnoreCase(name)) { duplicate = true; break; }
            if (!name.isEmpty() && !duplicate) unique.add(name);
        }
        return android.text.TextUtils.join(", ", unique);
    }

    private String firstMetadataValue(JSONObject metadata, String... keys) {
        if (metadata == null) return "";
        for (String key : keys) {
            Object value = metadata.opt(key);
            if (value instanceof JSONArray) {
                JSONArray array = (JSONArray) value;
                List<String> values = new ArrayList<>();
                for (int i = 0; i < array.length(); i++) {
                    String item = safe(array.optString(i, ""));
                    if (!item.isEmpty() && !values.contains(item)) values.add(item);
                }
                if (!values.isEmpty()) return android.text.TextUtils.join(", ", values);
            } else if (value != null && value != JSONObject.NULL) {
                String text = safe(String.valueOf(value));
                if (!text.isEmpty() && !"null".equalsIgnoreCase(text)) return text;
            }
        }
        return "";
    }

    /** Поля yt-dlp, нужные для определения исполнителя и названия. Разбор выполняет JS (единый механизм). */
    private JSONObject identityFields(JSONObject metadata) throws Exception {
        JSONObject info = new JSONObject();
        for (String key : new String[] {"id", "title", "track", "artist", "artists", "album_artist", "album_artists", "creator", "creators",
                "uploader", "channel", "album", "release_date", "release_year", "upload_date", "genre", "genres"}) {
            if (metadata.has(key) && !metadata.isNull(key)) info.put(key, metadata.get(key));
        }
        return info;
    }

    /** Записывает готовые значения как литералы: символы % и : экранируются для шаблона yt-dlp. */
    private void addLiteralTag(YoutubeDLRequest request, String field, String value) {
        if (value == null || value.trim().isEmpty()) return;
        String literal = value.trim().replace("%", "%%").replace(":", "\\:");
        request.addOption("--parse-metadata", literal + ":%(" + field + ")s");
    }

    private void addResolvedTags(YoutubeDLRequest request, String title, String artist, String album, String year, String genre) {
        addLiteralTag(request, "meta_title", title);
        addLiteralTag(request, "meta_artist", artist);
        addLiteralTag(request, "meta_album", album);
        addLiteralTag(request, "meta_genre", genre);
        if (year != null && year.matches("\\d{4}")) addLiteralTag(request, "meta_date", year);
    }

    private JSONObject readTrackMetadata(String url) {
        try {
            YoutubeDLRequest request = baseRequest(url)
                .addOption("--no-playlist")
                .addOption("--skip-download")
                .addOption("--dump-single-json");
            YoutubeDLResponse response = YoutubeDL.getInstance().execute(request, "crimson-metadata-" + System.nanoTime(), null);
            String output = response.getOut();
            if (output == null) return new JSONObject();
            int first = output.indexOf('{');
            int last = output.lastIndexOf('}');
            if (first < 0 || last <= first) return new JSONObject();
            return new JSONObject(output.substring(first, last + 1));
        } catch (Exception ex) {
            Log.w(TAG, "Optional structured metadata lookup failed", ex);
            return new JSONObject();
        }
    }

    private String releaseYear(JSONObject metadata) {
        String date = firstMetadataValue(metadata, "release_date", "upload_date", "release_year");
        if (date.length() >= 4 && date.substring(0, 4).matches("\\d{4}")) {
            int year = Integer.parseInt(date.substring(0, 4));
            if (year >= 1880 && year <= java.util.Calendar.getInstance().get(java.util.Calendar.YEAR) + 1) return date.substring(0, 4);
        }
        long timestamp = metadata == null ? 0L : metadata.optLong("release_timestamp", 0L);
        if (timestamp > 0L) {
            java.util.Calendar calendar = java.util.Calendar.getInstance();
            calendar.setTimeInMillis(timestamp > 100000000000L ? timestamp : timestamp * 1000L);
            int year = calendar.get(java.util.Calendar.YEAR);
            if (year >= 1880 && year <= java.util.Calendar.getInstance().get(java.util.Calendar.YEAR) + 1) return String.valueOf(year);
        }
        return "";
    }


    private String readThumbnail(JSONObject item) {
        String direct = item.optString("thumbnail", "");
        if (!direct.isEmpty() && !"null".equalsIgnoreCase(direct)) return direct;
        org.json.JSONArray thumbnails = item.optJSONArray("thumbnails");
        if (thumbnails == null) return "";
        for (int i = thumbnails.length() - 1; i >= 0; i--) {
            JSONObject entry = thumbnails.optJSONObject(i);
            if (entry == null) continue;
            String url = entry.optString("url", "");
            if (!url.isEmpty() && !"null".equalsIgnoreCase(url)) return url;
        }
        return "";
    }

    @PluginMethod
    public void streamInfo(PluginCall call) {
        String url = safe(call.getString("url"));
        if (!validUrl(url)) {
            call.reject("Ссылка должна начинаться с https://.");
            return;
        }
        executor.execute(() -> {
            try {
                ensureReady();
                VideoInfo info = getStreamInfoWithFallback(url);
                String streamUrl = fallback(info.getUrl(), selectAudioUrl(info));
                if (streamUrl.isEmpty()) throw new IllegalStateException("Не удалось получить прямой аудиопоток.");
                JSONObject metadata = readTrackMetadata(url);
                String title = cleanYouTubeTitle(firstMetadataValue(metadata, "track", "title"), "");
                if (title.isEmpty()) title = cleanYouTubeTitle(info.getTitle(), "");
                String artist = cleanArtistName(firstMetadataValue(metadata, "artists", "artist", "album_artists", "album_artist", "creator", "uploader", "channel"));
                if (artist.isEmpty()) artist = cleanArtistName(info.getUploader());
                JSObject result = new JSObject();
                result.put("url", streamUrl);
                result.put("title", fallback(title, "Без названия"));
                result.put("artist", artist);
                result.put("info", identityFields(metadata));   // JS определяет исполнителя и название единым механизмом
                result.put("album", firstMetadataValue(metadata, "album"));
                result.put("year", releaseYear(metadata));
                result.put("genre", firstMetadataValue(metadata, "genre", "genres", "categories"));
                result.put("duration", info.getDuration());
                result.put("thumbnail", fallback(info.getThumbnail(), readThumbnailFromInfo(info)));
                call.resolve(result);
            } catch (Exception ex) {
                call.reject(safeMessage(ex));
            }
        });
    }


    private VideoInfo getStreamInfoWithFallback(String url) throws Exception {
        boolean hasCookies = getCookiesFile() != null;
        List<String[]> clients = new ArrayList<>();
        clients.add(new String[] {"default", "true"});
        if (hasCookies) clients.add(new String[] {"default", "false"});
        clients.add(new String[] {"web_safari", "true"});
        if (hasCookies) clients.add(new String[] {"web_safari", "false"});
        clients.add(new String[] {"android", "true"});
        if (hasCookies) clients.add(new String[] {"android", "false"});
        Exception lastError = null;
        for (String[] candidate : clients) {
            try {
                String client = "default".equals(candidate[0]) ? "" : candidate[0];
                YoutubeDLRequest request = baseRequest(url, Boolean.parseBoolean(candidate[1]), client)
                    .addOption("--no-playlist")
                    .addOption("-f", "bestaudio[acodec*=opus]/bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio");
                VideoInfo info = YoutubeDL.getInstance().getInfo(request);
                if (info != null && (!safe(info.getUrl()).isEmpty() || !selectAudioUrl(info).isEmpty())) return info;
                lastError = new IllegalStateException("Extractor returned no direct audio URL for client " + candidate[0]);
            } catch (Exception ex) {
                lastError = ex;
                Log.w(TAG, "Audio stream info failed for client " + candidate[0] + " (cookies=" + candidate[1] + ")", ex);
            }
        }
        throw new IllegalStateException(lastError == null ? "Не удалось получить аудиопоток." : safeMessage(lastError), lastError);
    }

    private String readThumbnailFromInfo(VideoInfo info) {
        if (info.getThumbnails() == null) return "";
        List<com.yausername.youtubedl_android.mapper.VideoThumbnail> thumbnails = info.getThumbnails();
        for (int i = thumbnails.size() - 1; i >= 0; i--) {
            String url = thumbnails.get(i).getUrl();
            if (url != null && !url.isEmpty()) return url;
        }
        return "";
    }

    @PluginMethod
    public void downloadAudio(PluginCall call) {
        String url = safe(call.getString("url"));
        String id = cleanFilePart(safe(call.getString("id")));
        String requestedTitle = safe(call.getString("title"));
        String requestedArtist = cleanArtistName(safe(call.getString("artist")));
        String requestedFormat = safe(call.getString("format"));
        if (!validUrl(url) || id.isEmpty()) {
            call.reject("Недостаточно данных для скачивания.");
            return;
        }

        final String infoFilePath = safe(call.getString("infoFile"));
        executor.execute(() -> {
            boolean permitAcquired = false;
            try {
                downloadPermits.acquire();
                permitAcquired = true;
                if (cancelledDownloads.remove(id)) throw new IllegalStateException("Загрузка отменена.");
                ensureReady();
                File outputDir = musicOutputDirectory();
                // Если JS уже определил исполнителя и название (единый механизм track-identity), используем
                // именно эти значения для тегов и имени файла и не запрашиваем метаданные второй раз.
                final boolean resolved = call.getBoolean("resolved", false);
                String title;
                String artist;
                String album;
                String year;
                String genre;
                if (resolved) {
                    title = requestedTitle == null || requestedTitle.trim().isEmpty() ? "Без названия" : requestedTitle.trim();
                    artist = requestedArtist == null ? "" : requestedArtist.trim();
                    album = call.getString("album", "");
                    year = call.getString("year", "");
                    genre = call.getString("genre", "");
                } else {
                    JSONObject metadata = readTrackMetadata(url);
                    title = cleanYouTubeTitle(firstMetadataValue(metadata, "track", "title"), "");
                    if (title.isEmpty()) title = cleanYouTubeTitle(requestedTitle, id);
                    if (title.isEmpty()) title = "Без названия";
                    artist = cleanArtistName(firstMetadataValue(metadata, "artists", "artist", "album_artists", "album_artist", "creator", "uploader", "channel"));
                    if (artist.isEmpty()) artist = requestedArtist;
                    album = cleanYouTubeTitle(firstMetadataValue(metadata, "album"), "");
                    year = releaseYear(metadata);
                    genre = firstMetadataValue(metadata, "genre", "genres", "categories");
                }
                boolean hasCookies = getCookiesFile() != null;

                // Start with yt-dlp's normal client negotiation; retry with cookies disabled
                // when an imported session conflicts, then try a different supported client.
                final String[][] strategies;
                if ("mp3".equalsIgnoreCase(requestedFormat)) {
                    List<String[]> attempts = new ArrayList<>();
                    attempts.add(new String[] {"MP3 · стандартный клиент", "mp3-default-v3", "bestaudio/best", "true", "true", ""});
                    if (hasCookies) attempts.add(new String[] {"MP3 · без cookies", "mp3-anonymous-v3", "bestaudio/best", "true", "false", ""});
                    attempts.add(new String[] {"MP3 · резервный клиент", "mp3-safari-v3", "bestaudio/best", "true", "true", "web_safari"});
                    if (hasCookies) attempts.add(new String[] {"MP3 · резервный клиент без cookies", "mp3-safari-anonymous-v3", "bestaudio/best", "true", "false", "web_safari"});
                    strategies = attempts.toArray(new String[0][]);
                } else {
                    List<String[]> attempts = new ArrayList<>();
                    attempts.add(new String[] {"Исходный формат · стандартный клиент", "audio-default-v3", "bestaudio", "false", "true", ""});
                    if (hasCookies) attempts.add(new String[] {"Исходный формат · без cookies", "audio-anonymous-v3", "bestaudio", "false", "false", ""});
                    attempts.add(new String[] {"Исходный формат · резервный клиент", "audio-safari-v3", "bestaudio", "false", "true", "web_safari"});
                    attempts.add(new String[] {"MP3 · стандартный клиент", "audio-mp3-v3", "bestaudio/best", "true", "true", ""});
                    attempts.add(new String[] {"MP3 · резервный клиент", "audio-mp3-safari-v3", "bestaudio/best", "true", "true", "web_safari"});
                    if (hasCookies) attempts.add(new String[] {"MP3 · резервный клиент без cookies", "audio-mp3-safari-anonymous-v3", "bestaudio/best", "true", "false", "web_safari"});
                    strategies = attempts.toArray(new String[0][]);
                }

                StringBuilder failures = new StringBuilder();
                File downloaded = null;
                String finalFormatLabel = "";
                // Сохранённая информация о видео (ответ первого запроса) годна ограниченное время и только для первой стратегии.
                File infoFile = infoFilePath.isEmpty() ? null : new File(infoFilePath);
                boolean infoUsable = infoFile != null && infoFile.isFile() && infoFile.getParentFile() != null
                    && getContext().getCacheDir().equals(infoFile.getParentFile())
                    && System.currentTimeMillis() - infoFile.lastModified() < INFO_FILE_MAX_AGE_MS;
                for (int attempt = 0; attempt < strategies.length; attempt++) {
                    if (cancelledDownloads.contains(id)) break;
                    final boolean useInfoFile = infoUsable && attempt == 0;
                    String[] strategy = strategies[attempt];
                    String label = strategy[0];
                    String outputKey = id + "-" + strategy[1];
                    boolean transcode = Boolean.parseBoolean(strategy[3]);
                    boolean includeCookies = Boolean.parseBoolean(strategy[4]);
                    String playerClient = strategy[5];
                    File candidate = findDownloadedFile(outputDir, outputKey);
                    if (candidate == null) {
                        JSObject attemptUpdate = new JSObject();
                        attemptUpdate.put("id", id);
                        attemptUpdate.put("progress", 0);
                        attemptUpdate.put("eta", 0);
                        attemptUpdate.put("format", label);
                        notifyListeners("downloadProgress", attemptUpdate);
                        try {
                            YoutubeDLRequest request = baseRequest(url, includeCookies, playerClient)
                                .addOption("--no-playlist")
                                .addOption("--no-mtime")
                                .addOption("--newline")
                                .addOption("--retries", "3")
                                .addOption("--extractor-retries", "3")
                                .addOption("--fragment-retries", "3")
                                .addOption("--socket-timeout", "20")
                                // Параллельная загрузка фрагментов одного трека (для DASH/HLS); не связана с числом одновременных треков.
                                .addOption("--concurrent-fragments", "4")
                                // Если YouTube занижает скорость потока, yt-dlp заново получит ссылку вместо долгой загрузки.
                                .addOption("--throttled-rate", "100K")
                                .addOption("-f", strategy[2])
                                .addOption("--embed-metadata")
                                .addOption("--embed-thumbnail")
                                .addOption("-o", new File(outputDir, outputKey + ".%(ext)s").getAbsolutePath());
                            if (useInfoFile) request.addOption("--load-info-json", infoFile.getAbsolutePath());
                            if (resolved) {
                                // Теги пишем из единого механизма: Title без исполнителя, Artist отдельно.
                                addResolvedTags(request, title, artist, album, year, genre);
                            } else {
                                request.addOption("--parse-metadata", "%(track,title)s:^(?P<meta_title>.+?)(?:\\s*(?:[-–—|•·]\\s*)?[\\[(]?(?:official(?:\\s+music)?\\s+(?:video|audio)|music\\s+video|lyric(?:s)?(?:\\s+video)?|visualizer|audio\\s*hq|full\\s*hd|ultra\\s*hd|4k|2160p|1440p|1080p|720p|480p|hd)[\\])]?)+$");
                                request.addOption("--parse-metadata", "%(artist,artists,creator,creators,uploader,uploader_id)s:^(?P<meta_artist>.+?)(?:\\s*(?:[-–—|•·]\\s*)?(?:official(?:\\s+artist)?(?:\\s+channel)?|vevo|topic))+$");
                            }
                            if (transcode) {
                                request.addOption("-x")
                                    .addOption("--audio-format", "mp3")
                                    .addOption("--audio-quality", "0");
                            }
                            String processId = "crimson-download-" + id + "-" + strategy[1] + "-" + System.nanoTime();
                            activeProcesses.put(id, processId);
                            final String[] lastPhase = new String[] {"extracting"};
                            final long[] lastEmit = new long[] {0L};
                            Function3<Float, Long, String, Unit> callback = new Function3<Float, Long, String, Unit>() {
                                @Override
                                public Unit invoke(Float progress, Long etaInSeconds, String line) {
                                    String phase = phaseFromLine(line, lastPhase[0]);
                                    boolean phaseChanged = !phase.equals(lastPhase[0]);
                                    lastPhase[0] = phase;
                                    long now = System.currentTimeMillis();
                                    // Не чаще ~5 раз в секунду: иначе интерфейс тратит время на обработку событий.
                                    if (!phaseChanged && now - lastEmit[0] < PROGRESS_EMIT_INTERVAL_MS) return Unit.INSTANCE;
                                    lastEmit[0] = now;
                                    JSObject update = new JSObject();
                                    update.put("id", id);
                                    update.put("progress", Math.max(0, Math.min(100, progress == null ? 0 : progress)));
                                    update.put("eta", etaInSeconds == null ? 0 : etaInSeconds);
                                    update.put("format", label);
                                    update.put("phase", phase);
                                    Matcher matcher = line == null ? null : DOWNLOAD_LINE.matcher(line);
                                    if (matcher != null && matcher.find()) {
                                        try {
                                            double total = unitToBytes(Double.parseDouble(matcher.group(2)), matcher.group(3));
                                            double percent = Double.parseDouble(matcher.group(1));
                                            update.put("total", (long) total);
                                            update.put("downloaded", (long) (total * percent / 100d));
                                            if (matcher.group(4) != null) update.put("speed", (long) unitToBytes(Double.parseDouble(matcher.group(4)), matcher.group(5)));
                                        } catch (NumberFormatException ignored) { /* строка нестандартная: остаётся процент */ }
                                    }
                                    notifyListeners("downloadProgress", update);
                                    return Unit.INSTANCE;
                                }
                            };
                            YoutubeDLResponse response;
                            try { response = YoutubeDL.getInstance().execute(request, processId, callback); }
                            finally { activeProcesses.remove(id); }
                            if (response.getExitCode() != 0) {
                                String diagnostic = fallback(response.getErr(), response.getOut());
                                throw new IllegalStateException("yt-dlp exit " + response.getExitCode() + ": " + diagnostic);
                            }
                            candidate = findDownloadedFile(outputDir, outputKey);
                            if (candidate == null) throw new IllegalStateException("Download completed but no valid audio file was produced.");
                        } catch (Exception attemptError) {
                            Log.e(TAG, "Download attempt failed [" + label + "]", attemptError);
                            cleanupDownloadAttempt(outputDir, outputKey);
                            if (cancelledDownloads.contains(id)) break;
                            // Сохранённая информация могла устареть: повторяем ту же стратегию обычным способом.
                            if (useInfoFile && !isOfflineFailure(safeMessage(attemptError))) { infoUsable = false; attempt--; continue; }
                            // Нет сети: остальные стратегии упадут так же, не тратим время на их тайм-ауты.
                            if (isOfflineFailure(safeMessage(attemptError))) {
                                if (failures.length() > 0) failures.append(" | ");
                                failures.append(label).append(": ").append(safeMessage(attemptError));
                                break;
                            }
                            if (failures.length() > 0) failures.append(" | ");
                            failures.append(label).append(": ").append(safeMessage(attemptError));
                            String message = friendlyDownloadFailure(failures.toString());
                            if (attempt + 1 < strategies.length) message += " Пробую альтернативный способ…";
                            JSObject fallbackUpdate = new JSObject();
                            fallbackUpdate.put("id", id);
                            fallbackUpdate.put("progress", 0);
                            fallbackUpdate.put("eta", 0);
                            fallbackUpdate.put("format", label);
                            fallbackUpdate.put("message", message);
                            notifyListeners("downloadProgress", fallbackUpdate);
                            continue;
                        }
                    }
                    if (candidate == null || !candidate.isFile() || candidate.length() < 256 || !isPlausibleAudioFile(candidate)) {
                        cleanupDownloadAttempt(outputDir, outputKey);
                        if (failures.length() > 0) failures.append(" | ");
                        failures.append(label).append(": файл пустой или повреждён");
                        continue;
                    }
                    downloaded = candidate;
                    finalFormatLabel = label;
                    break;
                }

                if (cancelledDownloads.contains(id)) throw new IllegalStateException("Загрузка отменена.");
                if (downloaded == null) {
                    Log.e(TAG, "All download strategies failed for video " + id + ": " + failures);
                    throw new IllegalStateException(friendlyDownloadFailure(failures.toString()));
                }
                JSObject result = new JSObject();
                result.put("path", downloaded.getAbsolutePath());
                result.put("title", title);
                result.put("artist", artist);
                result.put("album", album);
                result.put("year", year);
                result.put("genre", genre);
                result.put("size", downloaded.length());
                result.put("format", actualAudioFormat(downloaded, finalFormatLabel));
                call.resolve(result);   // трек готов: запись в библиотеку не ждёт копирования во внешнюю папку
                try {
                    publishDownload(downloaded, artist, title, id, resolved);
                } catch (Exception publishError) {
                    Log.w(TAG, "Copy to the selected folder failed", publishError);
                    JSObject published = new JSObject();
                    published.put("id", id);
                    published.put("ok", false);
                    published.put("message", "Трек скачан, но не скопирован в выбранную папку: " + safeMessage(publishError));
                    notifyListeners("downloadPublished", published);
                }
            } catch (Exception ex) {
                Log.e(TAG, "Audio download failed", ex);
                String message = safeMessage(ex);
                if (message.startsWith("Загрузка отменена")) { call.reject(message); return; }
                if (message.startsWith("YouTube отклонил") || message.startsWith("Не удалось обработать") || message.startsWith("Не удалось скачать") || message.startsWith("Файл cookies")) call.reject(message);
                else call.reject(friendlyDownloadFailure(message));
            } finally {
                activeProcesses.remove(id);
                cancelledDownloads.remove(id);
                if (permitAcquired) downloadPermits.release();
            }
        });
    }

    private String friendlyDownloadFailure(String diagnostic) {
        String lower = safe(diagnostic).toLowerCase(Locale.ROOT);
        if (lower.contains("http error 403") || lower.contains("403 forbidden") || lower.contains("forbidden")) {
            return "YouTube отклонил запрос на аудиопоток (HTTP 403). Проверь подключение и обновление yt-dlp. Иногда YouTube требует PO Token; cookies не всегда устраняют эту причину.";
        }
        if (lower.contains("cookie") || lower.contains("sign in") || lower.contains("login required") || lower.contains("not a bot") || lower.contains("captcha")) {
            return "Файл cookies недействителен или устарел либо YouTube требует авторизацию. Импортируй свежий cookies.txt из своего сеанса YouTube.";
        }
        if (lower.contains("ffmpeg") || lower.contains("postprocess") || lower.contains("audio-convert") || lower.contains("conversion")) {
            return "Не удалось преобразовать аудио в MP3. Проверь наличие и работоспособность FFmpeg.";
        }
        if (lower.contains("requested format is not available") || lower.contains("no video formats") || lower.contains("no valid audio")) {
            return "Не удалось получить аудиопоток. Попробуй проверить или обновить yt-dlp.";
        }
        if (isOfflineFailure(lower)) {
            return "Нет подключения к интернету. Проверь соединение и повтори загрузку.";
        }
        if (lower.contains("timeout") || lower.contains("network") || lower.contains("connection") || lower.contains("unable to download") || lower.contains("temporary failure")) {
            return "Не удалось скачать трек из-за сетевой ошибки. Проверь подключение и попробуй ещё раз.";
        }
        return "Не удалось скачать трек. Попробуй ещё раз; подробности сохранены в журнале Crimson.";
    }

    private boolean isPlausibleAudioFile(File file) {
        String name = file.getName().toLowerCase(Locale.ROOT);
        String extension = name.contains(".") ? name.substring(name.lastIndexOf('.') + 1) : "";
        if (!("mp3".equals(extension) || "m4a".equals(extension) || "mp4".equals(extension) || "opus".equals(extension) ||
            "webm".equals(extension) || "ogg".equals(extension) || "oga".equals(extension) || "aac".equals(extension) ||
            "flac".equals(extension) || "wav".equals(extension))) return false;
        byte[] header = new byte[12];
        try (java.io.InputStream input = new java.io.FileInputStream(file)) { if (input.read(header) < 4) return false; }
        catch (Exception ex) { return false; }
        if ("mp3".equals(extension)) return (header[0] == 'I' && header[1] == 'D' && header[2] == '3') || ((header[0] & 0xff) == 0xff && (header[1] & 0xe0) == 0xe0);
        if ("m4a".equals(extension) || "mp4".equals(extension)) return header[4] == 'f' && header[5] == 't' && header[6] == 'y' && header[7] == 'p';
        if ("ogg".equals(extension) || "oga".equals(extension) || "opus".equals(extension)) return header[0] == 'O' && header[1] == 'g' && header[2] == 'g' && header[3] == 'S';
        if ("webm".equals(extension)) return (header[0] & 0xff) == 0x1a && (header[1] & 0xff) == 0x45 && (header[2] & 0xff) == 0xdf && (header[3] & 0xff) == 0xa3;
        if ("flac".equals(extension)) return header[0] == 'f' && header[1] == 'L' && header[2] == 'a' && header[3] == 'C';
        if ("wav".equals(extension)) return header[0] == 'R' && header[1] == 'I' && header[2] == 'F' && header[3] == 'F';
        if ("aac".equals(extension)) return (header[0] & 0xff) == 0xff && (header[1] & 0xf6) == 0xf0;
        return false;
    }

    private void cleanupDownloadAttempt(File outputDir, String outputKey) {
        File[] partialFiles = outputDir.listFiles((parent, name) -> name.startsWith(outputKey + "."));
        if (partialFiles == null) return;
        for (File file : partialFiles) {
            // Each attempt has its own output prefix, so this removes partial
            // downloads and sidecars without touching another format's result.
            if (file.isFile()) {
                try { file.delete(); } catch (Exception ignored) {}
            }
        }
    }

    @PluginMethod
    public void saveCookies(PluginCall call) {
        String content = call.getString("content");
        CookieValidation validation = validateNetscapeCookies(content);
        if (!validation.valid) { call.reject(validation.message); return; }
        executor.execute(() -> {
            File temporary = null;
            File backup = null;
            File destination = null;
            try {
                File directory = getContext().getFilesDir();
                destination = new File(directory, "youtube-cookies.txt");
                temporary = new File(directory, "youtube-cookies.txt." + System.nanoTime() + ".tmp");
                backup = new File(directory, "youtube-cookies.txt.backup");
                try (Writer writer = new OutputStreamWriter(new FileOutputStream(temporary, false), StandardCharsets.UTF_8)) {
                    writer.write(content.replace("\r\n", "\n"));
                    writer.flush();
                }
                try { android.system.Os.chmod(temporary.getAbsolutePath(), 0600); } catch (Exception ignored) {}
                if (backup.exists() && !backup.delete()) throw new IllegalStateException("Unable to clear cookies backup");
                boolean backedUp = destination.exists();
                if (backedUp && !destination.renameTo(backup)) throw new IllegalStateException("Unable to preserve previous cookies file");
                if (!temporary.renameTo(destination)) {
                    if (backedUp) backup.renameTo(destination);
                    throw new IllegalStateException("Unable to atomically replace cookies file");
                }
                try { android.system.Os.chmod(destination.getAbsolutePath(), 0600); } catch (Exception ignored) {}
                if (backup.exists()) backup.delete();
                cookiesFile = destination;
                JSObject result = new JSObject();
                result.put("count", validation.count);
                result.put("hasCookies", true);
                call.resolve(result);
            } catch (Exception ex) {
                Log.e(TAG, "Unable to save imported cookies file", ex);
                if (temporary != null && temporary.exists()) temporary.delete();
                if (backup != null && backup.exists() && destination != null && !destination.exists()) backup.renameTo(destination);
                call.reject("Не удалось безопасно сохранить cookies.txt. Проверь свободное место и повтори импорт.");
            }
        });
    }

    private static class CookieValidation {
        final boolean valid;
        final int count;
        final String message;
        CookieValidation(boolean valid, int count, String message) { this.valid = valid; this.count = count; this.message = message; }
    }

    private CookieValidation validateNetscapeCookies(String content) {
        String text = content == null ? "" : content.replace("\uFEFF", "").trim();
        if (text.isEmpty()) return new CookieValidation(false, 0, "Файл cookies.txt пуст.");
        String[] lines = text.split("\\r?\\n");
        boolean header = false;
        int validRows = 0;
        int activeYoutubeRows = 0;
        long now = System.currentTimeMillis() / 1000L;
        for (String line : lines) {
            if (line.matches("(?i)^#\\s*(?:Netscape(?: HTTP)?|HTTP) Cookie File.*$")) header = true;
            String row = line.startsWith("#HttpOnly_") ? line.substring("#HttpOnly_".length()) : line;
            if (row.isEmpty() || row.startsWith("#")) continue;
            String[] fields = row.split("\\t", -1);
            if (fields.length != 7 || fields[0].trim().isEmpty() || !("TRUE".equalsIgnoreCase(fields[1]) || "FALSE".equalsIgnoreCase(fields[1])) ||
                !fields[2].startsWith("/") || !("TRUE".equalsIgnoreCase(fields[3]) || "FALSE".equalsIgnoreCase(fields[3])) ||
                !fields[4].matches("\\d+") || fields[5].isEmpty()) continue;
            validRows++;
            String domain = fields[0].toLowerCase(Locale.ROOT);
            long expires;
            try { expires = Long.parseLong(fields[4]); } catch (Exception ignored) { continue; }
            if (("youtube.com".equals(domain) || domain.endsWith(".youtube.com")) && (expires == 0L || expires > now)) activeYoutubeRows++;
        }
        if (!header) return new CookieValidation(false, validRows, "Ожидается cookies.txt в формате Netscape.");
        if (validRows == 0) return new CookieValidation(false, 0, "В файле не найдено корректных строк cookies в формате Netscape.");
        if (activeYoutubeRows == 0) return new CookieValidation(false, validRows, "В файле нет действующих cookies для YouTube. Экспортируй свежий cookies.txt.");
        return new CookieValidation(true, validRows, "");
    }

    @PluginMethod
    public void clearCookies(PluginCall call) {
        executor.execute(() -> {
            try {
                File file = getCookiesFile();
                if (file != null && file.exists() && !file.delete()) throw new IllegalStateException("Unable to delete cookies file");
                cookiesFile = null;
                call.resolve();
            } catch (Exception ex) {
                Log.e(TAG, "Unable to remove cookies file", ex);
                call.reject("Не удалось удалить cookies.txt из приватного хранилища приложения.");
            }
        });
    }


    private YoutubeDLRequest baseRequest(String url) {
        return baseRequest(url, true, "");
    }

    private YoutubeDLRequest baseRequest(String url, boolean includeCookies, String playerClient) {
        YoutubeDLRequest request = new YoutubeDLRequest(url)
            .addOption("--quiet")
            .addOption("--js-runtimes", "quickjs")
            .addOption("--remote-components", "ejs:github")
            .addOption("--socket-timeout", "30")
            .addOption("--retries", "3")
            .addOption("--extractor-retries", "3");
        File cookieFile = includeCookies ? getCookiesFile() : null;
        if (cookieFile != null && cookieFile.isFile()) request.addOption("--cookies", cookieFile.getAbsolutePath());
        if (playerClient != null && !playerClient.isEmpty()) request.addOption("--extractor-args", "youtube:player_client=" + playerClient);
        return request;
    }

    private File musicOutputDirectory() {
        File root = getContext().getExternalFilesDir(Environment.DIRECTORY_MUSIC);
        if (root == null) root = new File(getContext().getFilesDir(), "Music");
        File output = new File(root, "Crimson Downloads");
        if (!output.exists() && !output.mkdirs()) {
            throw new IllegalStateException("Не удалось создать каталог загрузок Crimson.");
        }
        return output;
    }

    private File findDownloadedFile(File dir, String outputKey) {
        File[] files = dir.listFiles((parent, name) -> name.startsWith(outputKey + ".") &&
            !name.endsWith(".part") && !name.endsWith(".ytdl") && !name.endsWith(".tmp"));
        if (files == null || files.length == 0) return null;
        File best = null;
        for (File file : files) {
            if (!file.isFile() || file.length() < 256 || !isPlausibleAudioFile(file)) continue;
            if (best == null || file.length() > best.length()) best = file;
        }
        return best;
    }

    private String actualAudioFormat(File file, String fallbackLabel) {
        if (file == null) return fallbackLabel;
        String name = file.getName().toLowerCase(Locale.ROOT);
        if (name.endsWith(".mp3")) return "MP3";
        if (name.endsWith(".m4a")) return "M4A/AAC";
        if (name.endsWith(".mp4")) return "MP4-контейнер";
        if (name.endsWith(".opus")) return "Opus";
        if (name.endsWith(".webm")) return "WebM (обычно Opus)";
        if (name.endsWith(".ogg")) return "OGG";
        if (name.endsWith(".aac")) return "AAC";
        if (name.endsWith(".flac")) return "FLAC";
        int dot = name.lastIndexOf('.');
        return dot > -1 && dot < name.length() - 1 ? fallbackLabel + " (." + name.substring(dot + 1) + ")" : fallbackLabel;
    }

    private synchronized File getCookiesFile() {
        if (cookiesFile != null && cookiesFile.isFile()) return cookiesFile;
        File file = new File(getContext().getFilesDir(), "youtube-cookies.txt");
        cookiesFile = file.isFile() ? file : null;
        return cookiesFile;
    }

    private String selectAudioUrl(VideoInfo info) {
        List<VideoFormat> formats = info.getFormats();
        if (formats == null) return "";
        String opusUrl = "";
        String m4aUrl = "";
        String fallbackUrl = "";
        for (VideoFormat format : formats) {
            if (format == null || format.getUrl() == null || format.getUrl().isEmpty()) continue;
            String acodec = format.getAcodec() == null ? "" : format.getAcodec().toLowerCase(Locale.ROOT);
            String vcodec = format.getVcodec() == null ? "" : format.getVcodec().toLowerCase(Locale.ROOT);
            String ext = format.getExt() == null ? "" : format.getExt();
            if (acodec.isEmpty() || "none".equals(acodec)) continue;
            if (!vcodec.isEmpty() && !"none".equals(vcodec)) continue;
            if (acodec.contains("opus") && opusUrl.isEmpty()) opusUrl = format.getUrl();
            if ("m4a".equalsIgnoreCase(ext) && m4aUrl.isEmpty()) m4aUrl = format.getUrl();
            if (fallbackUrl.isEmpty()) fallbackUrl = format.getUrl();
        }
        if (!opusUrl.isEmpty()) return opusUrl;
        if (!m4aUrl.isEmpty()) return m4aUrl;
        return fallbackUrl;
    }

    private void publishDownload(File source, String artist, String title, String id, boolean resolved) throws Exception {
        String displayName = downloadDisplayName(source, artist, title, resolved);
        String treeText = storagePrefs().getString(DOWNLOAD_TREE_URI, "");
        if (treeText != null && !treeText.isEmpty()) exportToSelectedDownloadFolder(source, displayName);
        else saveToPublicMusic(source, displayName);
    }

    private String downloadDisplayName(File source, String artist, String title, boolean resolved) {
        // Значения от JS уже прошли единый механизм: повторная очистка могла бы изменить их, поэтому только trim.
        String cleanArtist = resolved ? safe(artist) : cleanArtistName(artist);
        String cleanTitle = resolved ? safe(title) : cleanYouTubeTitle(title, "");
        String base = (cleanArtist.isEmpty() ? "" : cleanArtist + " - ") + fallback(cleanTitle, "Без названия");
        base = base.replaceAll("[\\\\/:*?\"<>|\\p{Cc}]", "_")
            .replaceAll("\\s+", " ").replaceAll("[. ]+$", "").trim();
        if (base.isEmpty()) base = "Crimson Track";
        if (base.length() > 180) base = base.substring(0, 180).trim();
        String extension = "";
        String filename = source.getName();
        int dot = filename.lastIndexOf('.');
        if (dot >= 0 && dot < filename.length() - 1) extension = filename.substring(dot).toLowerCase(Locale.ROOT);
        return base + extension;
    }

    private void saveToPublicMusic(File source, String displayName) throws Exception {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            // Scoped Storage/MediaStore is not available on older Android versions.
            // Keep a stable fallback in the app's Music/Crimson Downloads directory.
            File root = getContext().getExternalFilesDir(Environment.DIRECTORY_MUSIC);
            if (root == null) root = new File(getContext().getFilesDir(), "Music");
            File directory = new File(root, "Crimson Downloads");
            if (!directory.exists() && !directory.mkdirs()) {
                throw new IllegalStateException("Не удалось создать каталог Music/Crimson Downloads.");
            }
            File target = new File(directory, displayName);
            copyFile(source, target);
            return;
        }

        android.content.ContentResolver resolver = getContext().getContentResolver();
        Uri collection = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
        String relativePath = Environment.DIRECTORY_MUSIC + "/Crimson Downloads/";
        Uri destination = null;
        String selection = MediaStore.MediaColumns.DISPLAY_NAME + "=? AND "
            + MediaStore.MediaColumns.RELATIVE_PATH + "=?";
        String[] selectionArgs = new String[] { displayName, relativePath };
        try (Cursor cursor = resolver.query(collection,
                new String[] { MediaStore.Audio.Media._ID },
                selection, selectionArgs, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                long rowId = cursor.getLong(0);
                destination = Uri.withAppendedPath(collection, String.valueOf(rowId));
            }
        }

        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, displayName);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mimeTypeFor(source));
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        if (destination == null) {
            destination = resolver.insert(collection, values);
        } else {
            resolver.update(destination, values, null, null);
        }
        if (destination == null) throw new IllegalStateException("Android не смог создать файл в Music/Crimson Downloads.");

        try {
            try (java.io.InputStream input = new java.io.FileInputStream(source);
                 java.io.OutputStream output = resolver.openOutputStream(destination, "wt")) {
                if (output == null) throw new IllegalStateException("Android не разрешил записать аудиофайл.");
                byte[] buffer = new byte[64 * 1024];
                int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                output.flush();
            }
            ContentValues ready = new ContentValues();
            ready.put(MediaStore.MediaColumns.IS_PENDING, 0);
            resolver.update(destination, ready, null, null);
        } catch (Exception ex) {
            try { resolver.delete(destination, null, null); } catch (Exception ignored) {}
            throw ex;
        }
    }

    private String mimeTypeFor(File file) {
        String extension = "";
        int dot = file.getName().lastIndexOf('.');
        if (dot >= 0 && dot < file.getName().length() - 1) {
            extension = file.getName().substring(dot + 1).toLowerCase(Locale.ROOT);
        }
        String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
        return mime == null ? "audio/*" : mime;
    }

    private void copyFile(File source, File target) throws Exception {
        if (source.getCanonicalPath().equals(target.getCanonicalPath())) return;
        try (java.io.InputStream input = new java.io.FileInputStream(source);
             java.io.OutputStream output = new java.io.FileOutputStream(target, false)) {
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            output.flush();
        }
    }

    private void exportToSelectedDownloadFolder(File source, String displayName) throws Exception {
        String treeText = storagePrefs().getString(DOWNLOAD_TREE_URI, "");
        if (treeText == null || treeText.isEmpty()) return;
        DocumentFile directory = DocumentFile.fromTreeUri(getContext(), Uri.parse(treeText));
        if (directory == null || !directory.isDirectory()) {
            throw new IllegalStateException("Папка загрузок недоступна. Выбери её заново в настройках.");
        }
        DocumentFile existing = directory.findFile(displayName);
        if (existing != null && existing.isFile() && !existing.delete()) {
            throw new IllegalStateException("Не удалось заменить файл в выбранной папке: " + displayName);
        }
        String extension = "";
        int dot = displayName.lastIndexOf('.');
        if (dot >= 0 && dot < displayName.length() - 1) extension = displayName.substring(dot + 1);
        String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension.toLowerCase(Locale.ROOT));
        if (mime == null) mime = "audio/*";
        DocumentFile destination = directory.createFile(mime, displayName);
        if (destination == null) throw new IllegalStateException("Android не смог создать файл в выбранной папке.");
        try (java.io.InputStream input = new java.io.FileInputStream(source);
             java.io.OutputStream output = getContext().getContentResolver().openOutputStream(destination.getUri(), "w")) {
            if (output == null) throw new IllegalStateException("Папка не разрешает запись.");
            byte[] buffer = new byte[64 * 1024];
            int count;
            while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            output.flush();
        }
    }

    private String text(Object value) { return value == null ? "" : String.valueOf(value); }
    private String safe(String value) { return value == null ? "" : value.trim(); }
    private String fallback(String value, String backup) { return value == null || value.isEmpty() ? (backup == null ? "" : backup) : value; }
    private boolean validUrl(String value) { return value != null && value.toLowerCase(Locale.ROOT).startsWith("https://"); }
    private String cleanFilePart(String value) { return value.replaceAll("[^A-Za-z0-9_-]", ""); }
    private String safeMessage(Throwable ex) {
        Throwable current = ex;
        while (current.getCause() != null && current.getCause() != current) current = current.getCause();
        String message = current.getMessage();
        if (message == null || message.trim().isEmpty()) message = current.getClass().getSimpleName();
        return message.replaceAll("(?i)(cookie(?:s)?(?:file)?[=: ]+)[^\\s]+", "$1[REDACTED]")
            .replaceAll("(?i)(authorization[=: ]+bearer\\s+)[^\\s]+", "$1[REDACTED]");
    }

}
