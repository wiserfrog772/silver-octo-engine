const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const androidRoot = path.join(root, 'android');
const appRoot = path.join(androidRoot, 'app');
const nativeSourceRoot = path.join(root, 'native', 'android', 'app', 'src', 'main');

function requireFile(file, message) {
  if (!fs.existsSync(file)) throw new Error(message + ': ' + file);
}
function patchGradle() {
  const file = path.join(appRoot, 'build.gradle');
  requireFile(file, 'Не найден android/app/build.gradle; сначала запусти npx cap add android');
  let text = fs.readFileSync(file, 'utf8');

  // Remove the previous wrapper before installing the GPL-3.0 youtubedl-android
  // runtime and its companion FFmpeg package.
  text = text.replace(/^\s*implementation ['"]dev\.ffmpegkit-maintained:yt-dlp-android[^'"]*['"]\s*;?\s*$/gm, '');
  const dependencies = [
    "implementation 'io.github.junkfood02.youtubedl-android:library:0.18.1'",
    "implementation 'io.github.junkfood02.youtubedl-android:ffmpeg:0.18.1'",
    "implementation 'androidx.documentfile:documentfile:1.0.1'",
    "implementation 'androidx.media3:media3-exoplayer:1.11.1'",
    "implementation 'androidx.media3:media3-session:1.11.1'"
  ];
  if (!/dependencies\s*\{/.test(text)) throw new Error('Не найден блок dependencies{} в app/build.gradle');
  for (const dependency of dependencies) {
    if (!text.includes(dependency)) {
      text = text.replace(/dependencies\s*\{/, (match) => match + '\n    ' + dependency);
    }
  }

  // Bundle only 64-bit ARM native libraries: x86 and 32-bit ARM devices are unsupported.
  text = text.replace(/ndk\s*\{\s*abiFilters[^}]*\}/g, '');
  if (!/defaultConfig\s*\{/.test(text)) throw new Error('Не найден блок defaultConfig{} в app/build.gradle');
  text = text.replace(/defaultConfig\s*\{/, (match) => match + "\n        ndk { abiFilters 'arm64-v8a' }");
  if (/minSdkVersion\s+rootProject\.ext\.minSdkVersion/.test(text)) {
    text = text.replace(/minSdkVersion\s+rootProject\.ext\.minSdkVersion/, 'minSdkVersion 24');
  } else if (/minSdkVersion\s+\d+/.test(text)) {
    text = text.replace(/minSdkVersion\s+\d+/, 'minSdkVersion 24');
  } else {
    throw new Error('Не найден minSdkVersion в app/build.gradle');
  }

  fs.writeFileSync(file, text);
}
function patchManifest() {
  const file = path.join(appRoot, 'src', 'main', 'AndroidManifest.xml');
  requireFile(file, 'Не найден AndroidManifest.xml');
  let text = fs.readFileSync(file, 'utf8');
  if (!text.includes('android.permission.INTERNET')) {
    text = text.replace('</manifest>', '    <uses-permission android:name="android.permission.INTERNET" />\n</manifest>');
  }
  for (const permission of [
    'android.permission.FOREGROUND_SERVICE',
    'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
    'android.permission.WAKE_LOCK'
  ]) {
    if (!text.includes(permission)) {
      text = text.replace('</manifest>', '    <uses-permission android:name="' + permission + '" />\n</manifest>');
    }
  }
  text = text.replace(/android:icon="[^"]*"/, 'android:icon="@drawable/localify_icon"');
  text = text.replace(/android:roundIcon="[^"]*"/, 'android:roundIcon="@drawable/localify_icon"');
  if (!/android:icon=/.test(text)) text = text.replace(/<application\b/, '<application android:icon="@drawable/localify_icon"');
  if (!/android:roundIcon=/.test(text)) text = text.replace(/<application\b/, '<application android:roundIcon="@drawable/localify_icon"');
  if (!text.includes('com.localify.crimson.PlaybackActionReceiver')) {
    text = text.replace('</application>', '        <receiver android:name="com.localify.crimson.PlaybackActionReceiver" android:enabled="true" android:exported="false" />\n    </application>');
  }
  if (!text.includes('com.localify.crimson.PlaybackForegroundService')) {
    text = text.replace('</application>', '        <service android:name="com.localify.crimson.PlaybackForegroundService" android:enabled="true" android:exported="true" android:foregroundServiceType="mediaPlayback"><intent-filter><action android:name="androidx.media3.session.MediaSessionService" /><action android:name="android.media.browse.MediaBrowserService" /></intent-filter></service>\n    </application>');
  } else if (!text.includes('androidx.media3.session.MediaSessionService')) {
    text = text.replace(/<service android:name="com\.localify\.crimson\.PlaybackForegroundService"([^>]*)\/>/, '<service android:name="com.localify.crimson.PlaybackForegroundService"$1><intent-filter><action android:name="androidx.media3.session.MediaSessionService" /><action android:name="android.media.browse.MediaBrowserService" /></intent-filter></service>');
  }
  if (!text.includes('androidx.media3.session.MediaButtonReceiver')) {
    text = text.replace('</application>', '        <receiver android:name="androidx.media3.session.MediaButtonReceiver" android:enabled="true" android:exported="true"><intent-filter><action android:name="android.intent.action.MEDIA_BUTTON" /></intent-filter></receiver>\n    </application>');
  }
  if (/android:extractNativeLibs=/.test(text)) {
    text = text.replace(/android:extractNativeLibs="[^"]*"/, 'android:extractNativeLibs="true"');
  } else {
    text = text.replace(/<application\b/, '<application android:extractNativeLibs="true"');
  }
  fs.writeFileSync(file, text);
}
function copyNativeFiles() {
  const packagePath = path.join('java', 'com', 'localify', 'crimson');
  const javaSourceRoot = path.join(nativeSourceRoot, packagePath);
  const javaTargetRoot = path.join(appRoot, 'src', 'main', packagePath);
  const drawableSourceRoot = path.join(nativeSourceRoot, 'res', 'drawable-nodpi');
  const drawableTargetRoot = path.join(appRoot, 'src', 'main', 'res', 'drawable-nodpi');
  fs.mkdirSync(javaTargetRoot, { recursive: true });
  fs.mkdirSync(drawableTargetRoot, { recursive: true });
  for (const name of ['MainActivity.java', 'YtDlpPlugin.java', 'PlaybackNotificationPlugin.java', 'PlaybackActionReceiver.java', 'PlaybackForegroundService.java']) {
    const src = path.join(javaSourceRoot, name);
    requireFile(src, 'Не найден исходник native plugin');
    fs.copyFileSync(src, path.join(javaTargetRoot, name));
  }
  const icon = path.join(drawableSourceRoot, 'localify_icon.png');
  requireFile(icon, 'Не найдена иконка Localify Crimson');
  fs.copyFileSync(icon, path.join(drawableTargetRoot, 'localify_icon.png'));
}
function bundleBridge() {
  const entry = path.join(root, 'src', 'native-bridge.js');
  const output = path.join(root, 'www', 'native-bridge.bundle.js');
  requireFile(entry, 'Не найден JS bridge для yt-dlp');
  execFileSync(path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'), [
    entry, '--bundle', '--platform=browser', '--format=iife', '--target=es2020', '--outfile=' + output
  ], { stdio: 'inherit' });
}
requireFile(androidRoot, 'Android-проект не создан: npx cap add android');
requireFile(appRoot, 'Android app-проект не создан');
bundleBridge();
copyNativeFiles();
patchGradle();
patchManifest();
console.log('Android project prepared: native LocalifyYtDlp plugin registered for in-app audio downloads');
