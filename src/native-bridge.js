import { registerPlugin } from '@capacitor/core';

const registerLocalifyYtDlp = () => {
  if (window.LocalifyYtDlp) return;
  // Register only after Capacitor has finished loading the native WebView bridge.
  // registerPlugin captures PluginHeaders at registration time, so doing this while
  // the document is still parsing can permanently create an unimplemented proxy.
  window.LocalifyYtDlp = registerPlugin('LocalifyYtDlp');
  window.LocalifyPlayback = registerPlugin('LocalifyPlayback');
  window.dispatchEvent(new Event('localify-yt-dlp-ready'));
  window.dispatchEvent(new Event('localify-playback-ready'));
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', registerLocalifyYtDlp, { once: true });
} else {
  registerLocalifyYtDlp();
}
