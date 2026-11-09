'use strict';
// Запуск: npm test (Node.js 22+, без внешних зависимостей).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const BINARY = /\.(png|webp|svg|jar|zip)$/i;
const IGNORED_DIRS = new Set(['node_modules', '.git', 'android']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORED_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

// Технические идентификаторы, которые намеренно сохранены от прежнего названия:
// их смена сломала бы обновление установленного приложения или доступ к данным пользователей.
const ALLOWED_LEGACY = [
  /com\.localify\.crimson/,        // applicationId / Java-пакет / intent-actions
  /com[\\/]+localify[\\/]+crimson/, // каталог Java-пакета
  /com',\s*'localify',\s*'crimson'/, // path.join(...) к каталогу пакета
  /com\\\.localify\\\.crimson/,    // тот же пакет внутри RegExp
  /localify-crimson-mobile/,       // имя IndexedDB с медиатекой
  /localify\.mobile\./,            // ключи localStorage старых версий (читаются для миграции)
  /localify_storage/,              // SharedPreferences с настройками папок
  /localify_native_playback/,      // SharedPreferences нативного плеера
  /localify_music_playback/,       // id канала уведомлений (смена потеряла бы настройки канала)
  /localify_diagnostics\.log/,     // файл журнала диагностики
  /LocalifyTracks/,                // приватный каталог импортированных файлов
  /переименовано из «Localify Crimson»/, // пояснение о переименовании в README
  /tests[\\/]project\.test\.js/    // этот файл описывает исключения
];

test('старое название Localify не встречается вне задокументированных технических исключений', () => {
  const offenders = [];
  for (const file of walk(root)) {
    if (BINARY.test(file)) continue;
    const relative = path.relative(root, file);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!/localify/i.test(line)) return;
      const cleaned = ALLOWED_LEGACY.reduce((text, pattern) => text.replace(new RegExp(pattern.source, 'gi'), ''), line + '\n' + relative);
      if (/localify/i.test(cleaned) && !ALLOWED_LEGACY.some((p) => p.test(relative))) {
        offenders.push(relative + ':' + (index + 1) + ': ' + line.trim().slice(0, 120));
      }
    });
  }
  assert.deepEqual(offenders, []);
});

test('JavaScript-файлы проходят проверку синтаксиса', () => {
  for (const file of ['www/app.js', 'scripts/prepare-android.js']) {
    execFileSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'pipe' });
  }
});

test('capacitor.config.json: название Crimson, appId совпадает с Java-пакетом', () => {
  const config = JSON.parse(read('capacitor.config.json'));
  assert.equal(config.appName, 'Crimson');
  for (const file of fs.readdirSync(path.join(root, 'native/android/app/src/main/java', ...config.appId.split('.')))) {
    assert.match(read(path.join('native/android/app/src/main/java', ...config.appId.split('.'), file)),
      new RegExp('^package ' + config.appId.replace(/\./g, '\\.') + ';', 'm'), file);
  }
});

test('имена Capacitor-плагинов в Java, native-bridge.js и app.js согласованы', () => {
  const javaDir = 'native/android/app/src/main/java/com/localify/crimson';
  const javaNames = fs.readdirSync(path.join(root, javaDir))
    .flatMap((file) => [...read(path.join(javaDir, file)).matchAll(/@CapacitorPlugin\(name = "(\w+)"\)/g)].map((m) => m[1]))
    .sort();
  const bridgeNames = [...read('src/native-bridge.js').matchAll(/registerPlugin\('(\w+)'\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(bridgeNames, javaNames);
  const used = new Set([...read('www/app.js').matchAll(/window\.(Crimson\w+)/g)].map((m) => m[1]));
  for (const name of used) assert.ok(javaNames.includes(name), 'app.js использует незарегистрированный плагин ' + name);
});

test('prepare-android.js ссылается на существующие файлы и классы', () => {
  const script = read('scripts/prepare-android.js');
  const javaDir = 'native/android/app/src/main/java/com/localify/crimson';
  const listed = [...script.matchAll(/'(\w+\.java)'/g)].map((m) => m[1]);
  assert.ok(listed.length >= 5);
  for (const name of listed) assert.ok(fs.existsSync(path.join(root, javaDir, name)), name);
  const iconName = script.match(/'(crimson_icon\.png)'/)[1];
  assert.ok(fs.existsSync(path.join(root, 'native/android/app/src/main/res/drawable-nodpi', iconName)));
});

test('все #id из app.js присутствуют в index.html', () => {
  const html = read('www/index.html');
  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const wanted = new Set([...read('www/app.js').matchAll(/\$\('#([A-Za-z][\w-]*)'\)/g)].map((m) => m[1]));
  const missing = [...wanted].filter((id) => !ids.has(id));
  assert.deepEqual(missing, []);
});

test('index.html: название Crimson и политика CSP', () => {
  const html = read('www/index.html');
  assert.match(html, /<title>Crimson<\/title>/);
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, /unsafe-eval/);
});

test('yt-dlp принимает только https-ссылки', () => {
  const java = read('native/android/app/src/main/java/com/localify/crimson/YtDlpPlugin.java');
  assert.match(java, /boolean validUrl\(String value\)[^\n]*"https:\/\/"/);
  assert.doesNotMatch(java, /startsWith\("http:\/\/"\)/);
});


test('yt-dlp runtime обновляется именно внутри APK, а версия читается из встроенного runtime', () => {
  const java = read('native/android/app/src/main/java/com/localify/crimson/YtDlpPlugin.java');
  assert.match(java, /updateYoutubeDL\(getContext\(\), YoutubeDL\.UpdateChannel\._STABLE\)/);
  assert.match(java, /YoutubeDL\.getInstance\(\)\.versionName\(getContext\(\)\)/);
  assert.match(java, /TimeUnit\.DAYS\.toMillis\(7\)/);
  assert.match(java, /TimeUnit\.HOURS\.toMillis\(24\)/);
  assert.match(java, /RUNTIME_LAST_ATTEMPT/);
});

test('скачивание использует альтернативные клиентские стратегии, cookies и проверку аудиофайла', () => {
  const java = read('native/android/app/src/main/java/com/localify/crimson/YtDlpPlugin.java');
  assert.match(java, /web_safari/);
  assert.match(java, /"android"/);
  assert.match(java, /includeCookies/);
  assert.match(java, /--embed-metadata/);
  assert.match(java, /--embed-thumbnail/);
  assert.match(java, /isPlausibleAudioFile/);
  assert.match(java, /--audio-quality", "0"/);
  assert.match(java, /PO Token/);
});

test('cookies импортируются приватно, валидируются и не пишутся в логи', () => {
  const java = read('native/android/app/src/main/java/com/localify/crimson/YtDlpPlugin.java');
  assert.match(java, /validateNetscapeCookies\(content\)/);
  assert.match(java, /Os\.chmod\(destination\.getAbsolutePath\(\), 0600\)/);
  assert.match(java, /youtube-cookies\.txt/);
  assert.match(java, /safeMessage/);
  assert.doesNotMatch(java, /Log\.[diwe]\(TAG,\s*content/);
});

test('интерфейс содержит поиск плейлистов, импорт cookies и ручное обновление загрузчика', () => {
  const html = read('www/index.html');
  assert.match(html, /id="playlistSearchInput"/);
  assert.match(html, /id="cookiesPicker"/);
  assert.match(html, /id="updateYtDlp"/);
  assert.match(html, /id="importCookies"/);
  assert.match(html, /id="clearCookies"/);
});


test('playlist ordering module passes syntax validation', () => {
  execFileSync(process.execPath, ['--check', path.join(root, 'www/modules/playlist-order.mjs')], { stdio: 'pipe' });
});

test('playlist sorting is wired to persistence, touch drag-and-drop and active native queue sync', () => {
  const app = read('www/app.js');
  assert.match(app, /data-reorder-handle/);
  assert.match(app, /pointerdown/);
  assert.match(app, /pointermove/);
  assert.match(app, /pointerup/);
  assert.match(app, /persistPlaylistOrder\(playlist, nextIds, message\)/);
  // Плейлисты пишутся через защищённую запись (контрольная сумма + предыдущая копия), а не напрямую.
  assert.match(app, /writeGuarded\(localStorage, STORAGE_KEYS\.playlists/);
  assert.match(app, /setPlaybackPlaylist\(playlistId\)/);
  assert.match(app, /refreshActivePlaylistPlayback\(playlist\)/);
  assert.match(app, /syncNativePlayback\(true\)/);
  assert.match(app, /window\.scrollBy/);
  assert.match(app, /data-playlist-action="set-position"/);
});

test('компактное меню действий заменяет старую отдельную кнопку добавления в плейлист', () => {
  const app = read('www/app.js');
  const styles = read('www/crimson-theme.css');
  assert.match(app, /track-context-menu/);
  assert.match(app, /Добавить в плейлист/);
  assert.doesNotMatch(app, /playlist-add-action/);
  assert.match(app, /document\.querySelectorAll\('\.track-context-menu\[open\]/);
  assert.match(styles, /\.track-context-popover/);
});

test('свайп добавляет только вправо, запоминает выбранный плейлист и не перехватывает сортировку', () => {
  const app = read('www/app.js');
  assert.match(app, /classifyTrackSwipe\(dx, dy\)/);
  assert.match(app, /resolveSwipePlaylist\(state\.playlists, state\.quickAddPlaylistId, sourcePlaylistId\)/);
  assert.match(app, /saveQuickAddPlaylist\(playlist\.id\)/);
  assert.match(app, /\[data-reorder-handle\]/);
  assert.match(app, /openAddToPlaylistDialog\(gesture\.trackId, sourcePlaylistId\)/);
});

test('полоска прогресса видна в компактном плеере и синхронизируется с локальным и нативным аудио', () => {
  const app = read('www/app.js');
  const styles = read('www/crimson-theme.css');
  assert.match(app, /updateSeekVisual\(displayedElapsed, knownDuration\)/);
  assert.match(app, /audio\.addEventListener\('timeupdate'/);
  assert.match(app, /window\.CrimsonPlayback\.seekTo/);
  assert.match(styles, /#player:not\(\.player-fullscreen\) \.timeline\s*\{\s*display: flex !important/s);
  assert.match(styles, /::-webkit-slider-thumb/);
});

test('быстрое добавление свайпом можно отменить без удаления самой композиции', () => {
  const app = read('www/app.js');
  assert.match(app, /addTrackToPlaylist\(target\.id, gesture\.trackId, \{ undoable: true \}\)/);
  assert.match(app, /showToast\(message, 'Отменить'/);
  assert.match(app, /current\.trackIds\.splice\(index, 1\)/);
  assert.match(app, /refreshActivePlaylistPlayback\(current\)/);
});

test('все методы нативного плагина, которые вызывает app.js, объявлены в Java', () => {
  const app = read('www/app.js');
  const dir = 'native/android/app/src/main/java/com/localify/crimson/';
  const java = fs.readdirSync(path.join(root, dir)).filter((name) => name.endsWith('.java')).map((name) => read(dir + name)).join('\n');
  const declared = new Set([...java.matchAll(/@PluginMethod\s+public void (\w+)\(/g)].map((m) => m[1]));
  const used = new Set([...app.matchAll(/(?:window\.CrimsonYtDlp|\bplugin)\.(\w+)\(/g)].map((m) => m[1]));
  used.delete('addListener');
  const missing = [...used].filter((name) => !declared.has(name));
  assert.deepEqual(missing, []);
});

test('резервные копии: правила Auto Backup, hasFragileUserData и BackupStore подключены в prepare-android', () => {
  const script = read('scripts/prepare-android.js');
  assert.match(script, /hasFragileUserData/);
  assert.match(script, /crimson_backup_rules/);
  assert.match(script, /crimson_data_extraction_rules/);
  assert.match(script, /BackupStore\.java/);
  const rules = read('native/android/app/src/main/res/xml/crimson_backup_rules.xml');
  assert.match(rules, /path="backup\/"/);
  assert.doesNotMatch(rules, /domain="database"|domain="root"/);
});

test('резервная копия зеркалируется и читается из обеих пользовательских папок', () => {
  const java = read('native/android/app/src/main/java/com/localify/crimson/YtDlpPlugin.java');
  const save = java.slice(java.indexOf('public void saveBackup('), java.indexOf('public void readBackups('));
  const load = java.slice(java.indexOf('public void readBackups('), java.indexOf('public void wipeBackups('));
  assert.match(save, /BackupStore\.mirror\(getContext\(\), libraryTree, json\)/);
  assert.match(save, /BackupStore\.mirror\(getContext\(\), downloadTree, json\)/);
  assert.match(load, /storagePrefs\(\)\.getString\(LIBRARY_TREE_URI/);
  assert.match(load, /storagePrefs\(\)\.getString\(DOWNLOAD_TREE_URI/);
  assert.match(load, /BackupStore\.readAllCandidates\(getContext\(\), libraryTree, downloadTree\)/);
  const app = read('www/app.js');
  assert.match(app, /downloadConcurrency: readDownloadConcurrency\(\)/);
  assert.match(app, /liteMotion/);
  assert.match(app, /restoreBackupQueue\(\)/);
  assert.match(app, /async function restoreNativeBackupIfEmpty\(\)/);
  assert.match(app, /function saveQueue\(\) \{[\s\S]*?scheduleBackup\(\);/);
});

test('папки плейлистов используют манифест-ссылки и не создают аудиокопии', () => {
  const java = read('native/android/app/src/main/java/com/localify/crimson/YtDlpPlugin.java');
  const folders = read('www/modules/playlist-folders.mjs');
  const docs = read('docs/DATA-PERSISTENCE.md');
  assert.match(java, /sameDocumentContent\(DocumentFile document, File source\)/);
  assert.match(java, /manifest\.put\("managed", new JSONArray\(\)\)/);
  assert.doesNotMatch(java, /copyLocalFileToDocument/);
  assert.match(folders, /reference-only-v2/);
  assert.match(folders, /additions/);
  assert.match(docs, /без физических копий аудио/);
});

test('нижний плеер: блок кнопок привязан к строке трека, а не к центру всей панели', () => {
  const css = read('www/crimson-theme.css');
  assert.match(css, /#player:not\(\.player-fullscreen\) \.player-controls \{ top: 10px; bottom: auto; height: 56px; transform: none; \}/);
  assert.match(css, /\.timeline \{ margin-top: 8px/);
});

test('интерактивная полоска перемотки сохранена', () => {
  const html = read('www/index.html');
  assert.match(html, /<input id="seek" type="range"/);
});

test('анимации: нет анимации layout-свойств, нет content-visibility на строках, нет blur-теней', () => {
  const css = read('www/crimson-theme.css');
  const keyframes = [...css.matchAll(/@keyframes\s+[\w-]+\s*\{([\s\S]*?)\}\s*(?=@|\n\.|\n\/\*|\n\n|$)/g)].map((m) => m[0]).join('\n');
  assert.doesNotMatch(keyframes, /margin-left|(?:^|[^-])width\s*:|(?:^|[^-])left\s*:|(?:^|[^-])top\s*:/);
  assert.doesNotMatch(css, /\.track-row\s*\{[^}]*content-visibility/);
  assert.match(css, /\.track-row, \.empty-state \{ box-shadow: none !important; \}/);
  assert.match(css, /html\.lite-motion/);
  assert.match(read('www/index.html'), /id="liteMotion"/);
});


test('сканирование ждёт асинхронную регистрацию Capacitor listener до старта нативного потока', () => {
  const app = read('www/app.js');
  assert.match(app, /await attachScanListener\(\);\s*const started = await plugin\.startLibraryScan/);
  assert.match(app, /Promise\.resolve\(plugin\.addListener\('libraryScanEvent'/);
});

test('папки плейлистов создаются автоматически, без ручных кнопок в настройках', () => {
  const html = read('www/index.html');
  const app = read('www/app.js');
  const java = read('native/android/app/src/main/java/com/localify/crimson/YtDlpPlugin.java');
  assert.doesNotMatch(html, /id="(?:syncPlaylistFolders|restorePlaylistFolders)"/);
  assert.doesNotMatch(app, /\$\('#(?:syncPlaylistFolders|restorePlaylistFolders)'\)/);
  assert.match(app, /function savePlaylists\(\)[\s\S]*?scheduleFolderSync\(\)/);
  assert.match(java, /private DocumentFile playlistsRoot\(boolean create\)[\s\S]*?return root;/);
  assert.match(java, /appendPlaylistFolders\(root, folders\)/);
  assert.match(java, /appendPlaylistFolders\(legacyRoot, folders\)/);
  assert.match(java, /child\.findFile\(PLAYLIST_MANIFEST\) != null/);
});


test('очередь загрузок отображает статусы и ожидает регистрацию событий до запуска', () => {
  const app = read('www/app.js');
  assert.match(app, /onChange: \(id, snapshot\) =>/);
  assert.match(app, /await attachDownloadProgressListener\(\);/);
  assert.match(app, /async function enqueueYoutubeDownload\(video\)/);
});

test('удаление папок плейлистов никогда не удаляет выбранный корень пользователя', () => {
  const java = read('native/android/app/src/main/java/com/localify/crimson/YtDlpPlugin.java');
  const block = java.slice(java.indexOf('public void deleteAllPlaylistFolders'), java.indexOf('public void readPlaylistFolders'));
  assert.match(block, /deleteManagedPlaylistDirectories\(root\)/);
  assert.doesNotMatch(block, /root\.delete\(\)/);
});


test('Android native bridge is generated before Capacitor sync', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['preandroid:sync'], 'npm run prepare:android');
  assert.match(read('scripts/prepare-android.js'), /function bundleBridge\(\)/);
  assert.match(read('www/index.html'), /native-bridge\.bundle\.js/);
});

test('native queue updates preserve the active ExoPlayer item when only upcoming tracks change', () => {
  const java = read('native/android/app/src/main/java/com/localify/crimson/PlaybackForegroundService.java');
  assert.match(java, /samePrefixThroughCurrent/);
  assert.match(java, /player\.removeMediaItems\(tailStart, player\.getMediaItemCount\(\)\)/);
  assert.match(java, /player\.addMediaItems\(tailStart, mediaItems\.subList\(tailStart, mediaItems\.size\(\)\)\)/);
  assert.match(java, /Replacing the whole timeline causes an audible micro-pause/);
});
