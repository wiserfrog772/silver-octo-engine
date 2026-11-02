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
