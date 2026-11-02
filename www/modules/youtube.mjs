import { cleanArtistName, cleanTrackTitle } from './music-metadata.mjs';

export function normalizeYoutubeResults(results) {
  const unique = new Map();
  for (const item of (Array.isArray(results) ? results : [])) {
    if (!item || item.id == null) continue;
    const id = String(item.id);
    if (!id || unique.has(id)) continue;
    unique.set(id, {
      ...item,
      id,
      title: cleanTrackTitle(item.title) || 'Без названия',
      channel: cleanArtistName(item.channel || item.uploader),
      uploader: cleanArtistName(item.uploader || item.channel),
      thumbnail: item.thumbnail || `https://i.ytimg.com/vi/${encodeURIComponent(id)}/hqdefault.jpg`
    });
  }
  return Array.from(unique.values());
}

export function friendlyYoutubeError(error) {
  const raw = String(error && error.message ? error.message : error || 'Неизвестная ошибка').trim();
  const lower = raw.toLowerCase();
  if (/java\.util\.hashmap\.get|hashmap\.get takes 1 argument/.test(lower)) {
    return 'Встроенный загрузчик столкнулся с ошибкой параметров. Проверь обновление yt-dlp в настройках.';
  }
  if (/http error 403|403 forbidden/.test(lower)) {
    return 'YouTube отклонил запрос на аудиопоток (HTTP 403). Проверь обновление yt-dlp и подключение. Для некоторых клиентов YouTube требует PO Token; cookies сами по себе не всегда решают эту проблему.';
  }
  if (/ffmpeg|postprocessing|audio-convert|conversion/.test(lower)) {
    return 'Не удалось обработать аудио. Проверьте наличие и работоспособность FFmpeg.';
  }
  if (/cookie|sign in|login required|authentication|confirm you.?re not a bot|not a bot|age.restricted|members.only|private video|captcha|verify you.?re human/.test(lower)) {
    return 'YouTube требует авторизацию или отклонил текущую сессию. Проверь cookies.txt и импортируй свежий файл из своего сеанса YouTube.';
  }
  if (/requested format is not available|no video formats|formats are not available/.test(lower)) {
    return 'Не удалось получить аудиопоток в доступных форматах. Попробуй обновить yt-dlp.';
  }
  if (/network|timed out|timeout|connection|unable to download|temporary failure|name or service not known/.test(lower)) {
    return 'Не удалось скачать трек из-за сетевой ошибки. Проверь подключение и попробуй ещё раз.';
  }
  return raw.length > 220 ? raw.slice(0, 217) + '…' : raw;
}

export function validateNetscapeCookies(content) {
  const text = String(content || '').replace(/^\uFEFF/, '').trim();
  if (!text) return { valid: false, message: 'Файл cookies.txt пуст.' };
  const lines = text.split(/\r?\n/);
  const header = lines.some((line) => /^#\s*(?:Netscape(?: HTTP)?|HTTP) Cookie File/i.test(line));
  if (!header) return { valid: false, message: 'Ожидается cookies.txt в формате Netscape.' };
  let validRows = 0;
  let activeYoutubeRows = 0;
  const now = Math.floor(Date.now() / 1000);
  for (const original of lines) {
    const line = original.startsWith('#HttpOnly_') ? original.slice('#HttpOnly_'.length) : original;
    if (!line || line.startsWith('#')) continue;
    const fields = line.split('\t');
    if (fields.length !== 7) continue;
    const [domain, includeSubdomains, cookiePath, secure, expires, name] = fields;
    if (!domain || !/^(TRUE|FALSE)$/i.test(includeSubdomains) || !cookiePath.startsWith('/') ||
        !/^(TRUE|FALSE)$/i.test(secure) || !/^\d+$/.test(expires) || !name) continue;
    validRows += 1;
    if (/\.youtube\.com$|^youtube\.com$/i.test(domain) && (Number(expires) === 0 || Number(expires) > now)) {
      activeYoutubeRows += 1;
    }
  }
  if (!validRows) return { valid: false, message: 'В файле не найдено корректных строк cookies в формате Netscape.' };
  if (!activeYoutubeRows) return { valid: false, message: 'В файле нет действующих cookies для YouTube. Экспортируй свежий cookies.txt.' };
  return { valid: true, count: validRows };
}
