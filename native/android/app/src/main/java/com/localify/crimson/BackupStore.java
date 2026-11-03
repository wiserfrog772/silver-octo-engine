package com.localify.crimson;

import android.content.Context;
import android.net.Uri;
import androidx.documentfile.provider.DocumentFile;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;

/**
 * Резервные копии пользовательских данных (плейлисты, порядок, настройки).
 *
 * Где лежат копии:
 *  1) filesDir/backup/ — приватная папка приложения. Файлы входят в Android Auto Backup
 *     (см. crimson_backup_rules.xml), поэтому возвращаются при переустановке, если на устройстве
 *     включено резервное копирование Google.
 *  2) «Crimson Backup» внутри папки, которую пользователь выбрал через системный диалог
 *     (папка медиатеки или загрузок). Эта копия лежит вне данных приложения и переживает удаление.
 *
 * Запись атомарная: сначала временный файл, затем переименование. Обрыв записи не повреждает копию.
 */
final class BackupStore {
    static final String DIR = "backup";
    static final String MAIN = "crimson-backup.json";
    static final String MIRROR_DIR = "Crimson Backup";
    private static final int KEEP_ROTATED = 5;
    private static final long ROTATE_EVERY_MS = 10L * 60L * 1000L;
    private static final int MAX_BYTES = 8 * 1024 * 1024;

    private BackupStore() {}

    static File directory(Context context) {
        File dir = new File(context.getFilesDir(), DIR);
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    /** Проверяет, что это копия Crimson, прежде чем перезаписывать хорошую копию. */
    static void validate(String json) throws Exception {
        if (json == null || json.length() < 20 || json.length() > MAX_BYTES) throw new IllegalArgumentException("Некорректный размер резервной копии.");
        org.json.JSONObject parsed = new org.json.JSONObject(json);
        if (!"crimson".equals(parsed.optString("app"))) throw new IllegalArgumentException("Это не копия Crimson.");
        if (parsed.optJSONObject("data") == null) throw new IllegalArgumentException("В копии нет данных.");
    }

    static void writeAtomic(File target, String text) throws Exception {
        File tmp = new File(target.getParentFile(), target.getName() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp, false)) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
            out.getFD().sync();
        }
        if (!tmp.renameTo(target)) {
            // renameTo может не заменить существующий файл на некоторых ФС.
            if (target.exists() && !target.delete()) throw new IllegalStateException("Не удалось заменить файл копии.");
            if (!tmp.renameTo(target)) throw new IllegalStateException("Не удалось сохранить файл копии.");
        }
    }

    static String readFile(File file) throws Exception {
        if (!file.isFile() || file.length() == 0 || file.length() > MAX_BYTES) return "";
        try (InputStream in = new java.io.FileInputStream(file)) { return readAll(in); }
    }

    static String readAll(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[16 * 1024];
        int count;
        while ((count = in.read(buffer)) != -1) {
            out.write(buffer, 0, count);
            if (out.size() > MAX_BYTES) throw new IllegalStateException("Файл слишком большой.");
        }
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    /** Сохраняет основную копию, периодически делает копию с отметкой времени, удаляет старые. */
    static void save(Context context, String json) throws Exception {
        validate(json);
        File dir = directory(context);
        File main = new File(dir, MAIN);
        writeAtomic(main, json);
        File[] rotated = rotatedFiles(dir);
        long newest = rotated.length == 0 ? 0 : rotated[0].lastModified();
        if (System.currentTimeMillis() - newest >= ROTATE_EVERY_MS) {
            writeAtomic(new File(dir, "crimson-backup-" + System.currentTimeMillis() + ".json"), json);
            rotated = rotatedFiles(dir);
            for (int i = KEEP_ROTATED; i < rotated.length; i++) rotated[i].delete();
        }
    }

    /** Файлы с отметкой времени, самые новые первыми. */
    static File[] rotatedFiles(File dir) {
        File[] files = dir.listFiles((d, name) -> name.startsWith("crimson-backup-") && name.endsWith(".json"));
        if (files == null) return new File[0];
        Arrays.sort(files, new Comparator<File>() {
            @Override public int compare(File a, File b) { return Long.compare(b.lastModified(), a.lastModified()); }
        });
        return files;
    }

    /** Копия во внешней папке пользователя. Ошибки не критичны: основная копия уже сохранена. */
    static boolean mirror(Context context, String treeUriText, String json) {
        if (treeUriText == null || treeUriText.isEmpty()) return false;
        try {
            DocumentFile root = DocumentFile.fromTreeUri(context, Uri.parse(treeUriText));
            if (root == null || !root.isDirectory() || !root.canWrite()) return false;
            DocumentFile dir = root.findFile(MIRROR_DIR);
            if (dir == null || !dir.isDirectory()) dir = root.createDirectory(MIRROR_DIR);
            if (dir == null) return false;
            DocumentFile file = dir.findFile(MAIN);
            if (file == null) file = dir.createFile("application/json", MAIN);
            if (file == null) return false;
            try (OutputStream out = context.getContentResolver().openOutputStream(file.getUri(), "wt")) {
                if (out == null) return false;
                out.write(json.getBytes(StandardCharsets.UTF_8));
            }
            return true;
        } catch (Exception ignored) {
            return false;
        }
    }

    static String readMirror(Context context, String treeUriText) {
        if (treeUriText == null || treeUriText.isEmpty()) return "";
        try {
            DocumentFile root = DocumentFile.fromTreeUri(context, Uri.parse(treeUriText));
            if (root == null) return "";
            DocumentFile dir = root.findFile(MIRROR_DIR);
            if (dir == null) return "";
            DocumentFile file = dir.findFile(MAIN);
            if (file == null || !file.isFile()) return "";
            try (InputStream in = context.getContentResolver().openInputStream(file.getUri())) {
                return in == null ? "" : readAll(in);
            }
        } catch (Exception ignored) {
            return "";
        }
    }

    static List<String[]> readAllCandidates(Context context, String libraryTree, String downloadTree) {
        List<String[]> result = new ArrayList<>();
        try {
            String main = readFile(new File(directory(context), MAIN));
            if (!main.isEmpty()) result.add(new String[] {"app", main});
            for (File file : rotatedFiles(directory(context))) {
                String text = readFile(file);
                if (!text.isEmpty()) result.add(new String[] {"app-history", text});
            }
        } catch (Exception ignored) {}
        String fromLibrary = readMirror(context, libraryTree);
        if (!fromLibrary.isEmpty()) result.add(new String[] {"library-folder", fromLibrary});
        String fromDownloads = readMirror(context, downloadTree);
        if (!fromDownloads.isEmpty()) result.add(new String[] {"download-folder", fromDownloads});
        return result;
    }

    static void wipe(Context context, String libraryTree, String downloadTree) {
        File dir = directory(context);
        File[] files = dir.listFiles();
        if (files != null) for (File file : files) file.delete();
        for (String tree : new String[] {libraryTree, downloadTree}) {
            if (tree == null || tree.isEmpty()) continue;
            try {
                DocumentFile root = DocumentFile.fromTreeUri(context, Uri.parse(tree));
                DocumentFile mirror = root == null ? null : root.findFile(MIRROR_DIR);
                if (mirror != null) mirror.delete();
            } catch (Exception ignored) {}
        }
    }
}
