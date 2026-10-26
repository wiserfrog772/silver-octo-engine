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
import java.io.File;
import java.io.FileOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "LocalifyYtDlp")
public class YtDlpPlugin extends Plugin {
    private final ExecutorService executor = Executors.newCachedThreadPool();
    private volatile boolean initialized = false;
    private volatile String initError = "";
    private volatile File cookiesFile;

    private static final String STORAGE_PREFS = "localify_storage";
    private static final String LIBRARY_TREE_URI = "libraryTreeUri";
    private static final String DOWNLOAD_TREE_URI = "downloadTreeUri";

    // The library extracts its Python/yt-dlp and FFmpeg runtime on first real use.
    // status() deliberately does not call this method so app startup stays lightweight.
    private synchronized void ensureReady() throws Exception {
        if (initialized) return;
        try {
            YoutubeDL.getInstance().init(getContext());
            FFmpeg.getInstance().init(getContext());
            initialized = true;
            initError = "";
        } catch (YoutubeDLException ex) {
            initError = "Не удалось инициализировать youtubedl-android: " + ex.getMessage();
            throw new IllegalStateException(initError, ex);
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

    private void exportToSelectedDownloadFolder(File source) throws Exception {
        String treeText = storagePrefs().getString(DOWNLOAD_TREE_URI, "");
        if (treeText == null || treeText.isEmpty()) return;
        DocumentFile directory = DocumentFile.fromTreeUri(getContext(), Uri.parse(treeText));
        if (directory == null || !directory.isDirectory()) {
            throw new IllegalStateException("Папка загрузок недоступна. Выбери её заново в настройках.");
        }
        DocumentFile existing = directory.findFile(source.getName());
        if (existing != null && existing.isFile() && !existing.delete()) {
            throw new IllegalStateException("Не удалось заменить файл в выбранной папке: " + source.getName());
        }
        String extension = "";
        int dot = source.getName().lastIndexOf('.');
        if (dot >= 0 && dot < source.getName().length() - 1) extension = source.getName().substring(dot + 1);
        String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension.toLowerCase(Locale.ROOT));
        if (mime == null) mime = "audio/*";
        DocumentFile destination = directory.createFile(mime, source.getName());
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


    @PluginMethod
    public void status(PluginCall call) {
        // This is intentionally non-initializing. The first search, stream or
        // download action triggers runtime extraction in ensureReady().
        JSObject result = new JSObject();
        result.put("version", "0.18.1");
        result.put("hasCookies", getCookiesFile() != null);
        result.put("initialized", initialized);
        call.resolve(result);
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
                String processId = "localify-search-" + System.nanoTime();
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
        String title = fallback(rawTitle, "YouTube").trim();
        String id = safe(videoId);
        // Some search results/older downloads include yt-dlp's customary [video-id] suffix.
        // Strip it only when it matches this exact source ID, so real bracketed titles survive.
        if (id.matches("[A-Za-z0-9_-]{11}")) {
            String[] suffixes = new String[] { "[" + id + "]", "(" + id + ")" };
            for (String suffix : suffixes) {
                if (title.length() >= suffix.length() &&
                    title.regionMatches(true, title.length() - suffix.length(), suffix, 0, suffix.length())) {
                    title = title.substring(0, title.length() - suffix.length()).trim();
                    break;
                }
            }
        }
        return title.isEmpty() ? "YouTube" : title;
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
            call.reject("Ссылка должна начинаться с http:// или https://.");
            return;
        }
        executor.execute(() -> {
            try {
                ensureReady();
                YoutubeDLRequest request = baseRequest(url)
                    .addOption("--no-playlist")
                    .addOption("-f", "bestaudio[acodec*=opus]/bestaudio[ext=m4a]/bestaudio[ext=mp3]/bestaudio/best");
                VideoInfo info = YoutubeDL.getInstance().getInfo(request);
                String streamUrl = fallback(info.getUrl(), selectAudioUrl(info));
                if (streamUrl.isEmpty()) {
                    throw new IllegalStateException("yt-dlp не вернул прямой аудиопоток.");
                }
                JSObject result = new JSObject();
                result.put("url", streamUrl);
                result.put("title", fallback(info.getTitle(), "YouTube"));
                result.put("artist", fallback(info.getUploader(), "YouTube"));
                result.put("duration", info.getDuration());
                result.put("thumbnail", fallback(info.getThumbnail(), readThumbnailFromInfo(info)));
                call.resolve(result);
            } catch (Exception ex) {
                call.reject(safeMessage(ex));
            }
        });
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
        String title = cleanYouTubeTitle(fallback(safe(call.getString("title")), "YouTube"), id);
        String requestedFormat = safe(call.getString("format"));
        if (!validUrl(url) || id.isEmpty()) {
            call.reject("Недостаточно данных для скачивания.");
            return;
        }

        executor.execute(() -> {
            try {
                ensureReady();
                File outputDir = musicOutputDirectory();

                // Keep auto mode strictly audio-only. "best" is a combined audio+video
                // format on YouTube and was the reason an MP4 video could be saved here.
                // yt-dlp's bestaudio selects the best available audio codec (normally Opus/M4A).
                // If no audio-only format can be downloaded, the final attempt extracts MP3
                // from bestaudio/best using FFmpeg, so the result is still audio-only.
                final String[] labels;
                final String[] outputKeys;
                final String[] selectors;
                final boolean[] transcode;
                if ("mp3".equalsIgnoreCase(requestedFormat)) {
                    labels = new String[] { "MP3" };
                    outputKeys = new String[] { id + "-mp3-v2" };
                    selectors = new String[] { "bestaudio/best" };
                    transcode = new boolean[] { true };
                } else {
                    labels = new String[] { "Исходный аудиоформат", "MP3" };
                    outputKeys = new String[] { id + "-audio-v2", id + "-fallback-mp3-v2" };
                    selectors = new String[] { "bestaudio", "bestaudio/best" };
                    transcode = new boolean[] { false, true };
                }

                StringBuilder failures = new StringBuilder();
                for (int attempt = 0; attempt < labels.length; attempt++) {
                    String label = labels[attempt];
                    String outputKey = outputKeys[attempt];
                    File file = findDownloadedFile(outputDir, outputKey);

                    if (file == null) {
                        JSObject attemptUpdate = new JSObject();
                        attemptUpdate.put("id", id);
                        attemptUpdate.put("progress", 0);
                        attemptUpdate.put("eta", 0);
                        attemptUpdate.put("format", label);
                        notifyListeners("downloadProgress", attemptUpdate);
                        try {
                            YoutubeDLRequest request = baseRequest(url)
                                .addOption("--no-playlist")
                                .addOption("--no-mtime")
                                .addOption("--newline")
                                .addOption("--retries", "3")
                                .addOption("--extractor-retries", "3")
                                .addOption("--fragment-retries", "3")
                                .addOption("-f", selectors[attempt])
                                .addOption("-o", new File(outputDir, outputKey + ".%(ext)s").getAbsolutePath());

                            if (transcode[attempt]) {
                                request.addOption("-x")
                                    .addOption("--audio-format", "mp3")
                                    .addOption("--audio-quality", "192K")
                                    .addOption("--embed-metadata");
                            }

                            String processId = "localify-download-" + id + "-" + label.toLowerCase(Locale.ROOT)
                                + "-" + System.nanoTime();
                            Function3<Float, Long, String, Unit> callback = new Function3<Float, Long, String, Unit>() {
                                @Override
                                public Unit invoke(Float progress, Long etaInSeconds, String line) {
                                    JSObject update = new JSObject();
                                    update.put("id", id);
                                    update.put("progress", Math.max(0, Math.min(100, progress == null ? 0 : progress)));
                                    update.put("eta", etaInSeconds == null ? 0 : etaInSeconds);
                                    update.put("format", label);
                                    notifyListeners("downloadProgress", update);
                                    return Unit.INSTANCE;
                                }
                            };

                            YoutubeDLResponse response = YoutubeDL.getInstance().execute(request, processId, callback);
                            if (response.getExitCode() != 0) {
                                throw new IllegalStateException("код " + response.getExitCode() + ": " + response.getErr());
                            }
                            file = findDownloadedFile(outputDir, outputKey);
                            if (file == null) {
                                throw new IllegalStateException("yt-dlp завершился, но файл не найден.");
                            }
                        } catch (Exception attemptError) {
                            cleanupDownloadAttempt(outputDir, outputKey);
                            if (failures.length() > 0) failures.append(" | ");
                            failures.append(label).append(": ").append(safeMessage(attemptError));
                            String reason = safeMessage(attemptError).replaceAll("\\s+", " ").trim();
                            if (reason.length() > 150) reason = reason.substring(0, 147) + "...";
                            String message = label + " не удалось: " + reason;
                            if (attempt + 1 < labels.length) message += ". Пробую " + labels[attempt + 1] + "…";
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

                    // Publishing is deliberately outside the format-specific catch:
                    // a storage permission error must not trigger another download.
                    publishDownload(file, title, id);
                    JSObject result = new JSObject();
                    result.put("path", file.getAbsolutePath());
                    result.put("title", title);
                    result.put("size", file.length());
                    result.put("format", actualAudioFormat(file, label));
                    call.resolve(result);
                    return;
                }

                String prefix = "mp3".equalsIgnoreCase(requestedFormat)
                    ? "Не удалось скачать аудио в MP3. "
                    : "Не удалось скачать аудио в исходном формате или MP3. ";
                throw new IllegalStateException(prefix + failures);
            } catch (Exception ex) {
                call.reject("Ошибка yt-dlp: " + safeMessage(ex));
            }
        });
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
        if (content == null || content.trim().isEmpty()) { call.reject("Файл cookies.txt пуст."); return; }
        if (!content.contains("\t") || (!content.contains("# Netscape HTTP Cookie File") && !content.contains("# HTTP Cookie File"))) {
            call.reject("Ожидается файл cookies.txt в формате Netscape.");
            return;
        }
        executor.execute(() -> {
            try {
                File out = new File(getContext().getFilesDir(), "youtube-cookies.txt");
                try (Writer writer = new OutputStreamWriter(new FileOutputStream(out, false), StandardCharsets.UTF_8)) { writer.write(content); }
                cookiesFile = out;
                JSObject result = new JSObject();
                result.put("count", content.split("\\R").length);
                result.put("hasCookies", true);
                call.resolve(result);
            } catch (Exception ex) { call.reject("Не удалось сохранить cookies.txt: " + safeMessage(ex)); }
        });
    }

    @PluginMethod
    public void clearCookies(PluginCall call) {
        executor.execute(() -> {
            try {
                File file = getCookiesFile();
                if (file != null && file.exists() && !file.delete()) throw new IllegalStateException("Не удалось удалить файл cookies.");
                cookiesFile = null;
                call.resolve();
            } catch (Exception ex) { call.reject(safeMessage(ex)); }
        });
    }

    private YoutubeDLRequest baseRequest(String url) {
        YoutubeDLRequest request = new YoutubeDLRequest(url)
            .addOption("--quiet")
            // YouTube may require a JavaScript challenge solver before audio formats are exposed.
            .addOption("--js-runtimes", "quickjs")
            .addOption("--remote-components", "ejs:github")
            // Keep yt-dlp warnings visible; they explain missing formats and challenge failures.
            .addOption("--socket-timeout", "30")
            .addOption("--retries", "3")
            .addOption("--extractor-retries", "3");
        File cookieFile = getCookiesFile();
        if (cookieFile != null) {
            request.addOption("--cookies", cookieFile.getAbsolutePath());
        }
        return request;
    }

    private File musicOutputDirectory() {
        File root = getContext().getExternalFilesDir(Environment.DIRECTORY_MUSIC);
        if (root == null) root = new File(getContext().getFilesDir(), "Music");
        File output = new File(root, "Localify Downloads");
        if (!output.exists() && !output.mkdirs()) {
            throw new IllegalStateException("Не удалось создать каталог загрузок Localify.");
        }
        return output;
    }

    private File findDownloadedFile(File dir, String id) {
        File exactMp3 = new File(dir, id + ".mp3");
        if (exactMp3.isFile() && exactMp3.length() > 0) return exactMp3;
        File[] files = dir.listFiles((parent, name) -> name.startsWith(id + ".")
            && !name.endsWith(".part") && !name.endsWith(".ytdl"));
        if (files == null || files.length == 0) return null;
        File biggest = files[0];
        for (File file : files) {
            if (file.length() > biggest.length()) biggest = file;
        }
        return biggest;
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

    private void publishDownload(File source, String title, String id) throws Exception {
        String displayName = downloadDisplayName(source, title, id);
        String treeText = storagePrefs().getString(DOWNLOAD_TREE_URI, "");
        if (treeText != null && !treeText.isEmpty()) {
            exportToSelectedDownloadFolder(source, displayName);
        } else {
            saveToPublicMusic(source, displayName);
        }
    }

    private String downloadDisplayName(File source, String title, String id) {
        String cleanTitle = safe(title).replaceAll("[\\\\/:*?\\\"<>|\\p{Cntrl}]", "_")
            .replaceAll("\\s+", " ").trim();
        if (cleanTitle.isEmpty()) cleanTitle = "YouTube";
        if (cleanTitle.length() > 100) cleanTitle = cleanTitle.substring(0, 100).trim();
        String extension = "";
        String filename = source.getName();
        int dot = filename.lastIndexOf('.');
        if (dot >= 0 && dot < filename.length() - 1) extension = filename.substring(dot).toLowerCase(Locale.ROOT);
        return cleanTitle + " [" + id + "]" + extension;
    }

    private void saveToPublicMusic(File source, String displayName) throws Exception {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            // Scoped Storage/MediaStore is not available on older Android versions.
            // Keep a stable fallback in the app's Music/Localify Downloads directory.
            File root = getContext().getExternalFilesDir(Environment.DIRECTORY_MUSIC);
            if (root == null) root = new File(getContext().getFilesDir(), "Music");
            File directory = new File(root, "Localify Downloads");
            if (!directory.exists() && !directory.mkdirs()) {
                throw new IllegalStateException("Не удалось создать каталог Music/Localify Downloads.");
            }
            File target = new File(directory, displayName);
            copyFile(source, target);
            return;
        }

        android.content.ContentResolver resolver = getContext().getContentResolver();
        Uri collection = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
        String relativePath = Environment.DIRECTORY_MUSIC + "/Localify Downloads/";
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
        if (destination == null) throw new IllegalStateException("Android не смог создать файл в Music/Localify Downloads.");

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
    private boolean validUrl(String value) { String lower=value.toLowerCase(Locale.ROOT); return lower.startsWith("https://") || lower.startsWith("http://"); }
    private String cleanFilePart(String value) { return value.replaceAll("[^A-Za-z0-9_-]", ""); }
    private String safeMessage(Throwable ex) {
        Throwable current=ex;
        while (current.getCause()!=null && current.getCause()!=current) current=current.getCause();
        String message=current.getMessage();
        return message==null || message.trim().isEmpty() ? current.getClass().getSimpleName() : message;
    }
}
