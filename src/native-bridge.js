import { registerPlugin } from '@capacitor/core';

const registerCrimsonYtDlp = () => {
  if (window.CrimsonYtDlp) return;
  // Register only after Capacitor has finished loading the native WebView bridge.
  // registerPlugin captures PluginHeaders at registration time, so doing this while
  // the document is still parsing can permanently create an unimplemented proxy.
  window.CrimsonYtDlp = registerPlugin('CrimsonYtDlp');
  window.CrimsonPlayback = registerPlugin('CrimsonPlayback');
  window.dispatchEvent(new Event('crimson-yt-dlp-ready'));
  window.dispatchEvent(new Event('crimson-playback-ready'));
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', registerCrimsonYtDlp, { once: true });
} else {
  registerCrimsonYtDlp();
}
