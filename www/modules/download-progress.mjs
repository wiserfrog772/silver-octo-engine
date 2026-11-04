/**
 * Состояние и отображение прогресса скачивания. Все значения (скорость, объём) приходят из yt-dlp,
 * здесь они только форматируются; искусственных оценок нет.
 */
export const PHASES = Object.freeze({
  queued: 'В очереди', extracting: 'Получаю информацию', downloading: 'Скачивание', converting: 'Конвертация в MP3',
  metadata: 'Запись метаданных', thumbnail: 'Обложка', saving: 'Сохраняю в библиотеку', done: 'Готово', error: 'Ошибка', cancelled: 'Отменено'
});
export const ACTIVE_PHASES = new Set(['queued', 'extracting', 'downloading', 'converting', 'metadata', 'thumbnail', 'saving']);

export function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let size = bytes; let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return (unit === 0 ? Math.round(size) : size.toFixed(size >= 100 ? 0 : 1)) + ' ' + units[unit];
}
export function formatSpeed(bytesPerSecond) {
  const text = formatBytes(bytesPerSecond);
  return text ? text + '/с' : '';
}
export function formatEta(seconds) {
  const value = Math.round(Number(seconds));
  if (!Number.isFinite(value) || value < 0) return '';
  if (value < 1) return '< 1 сек.';
  if (value < 60) return '~' + value + ' сек.';
  const minutes = Math.floor(value / 60);
  return '~' + minutes + ' мин. ' + String(value % 60).padStart(2, '0') + ' сек.';
}

/** Сливает очередное событие в состояние; неизвестные значения не затирают известные. */
export function mergeProgress(previous, event) {
  const prev = previous || {};
  const e = event || {};
  const phase = PHASES[e.phase] ? e.phase : (prev.phase && ACTIVE_PHASES.has(prev.phase) ? prev.phase : 'downloading');
  const number = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);
  const next = {
    ...prev,
    status: ACTIVE_PHASES.has(phase) ? 'downloading' : phase,
    phase,
    progress: Math.max(0, Math.min(100, Number(e.progress ?? prev.progress) || 0)),
    speed: phase === 'downloading' ? number(e.speed, prev.speed || 0) : 0,
    downloaded: number(e.downloaded, prev.downloaded || 0),
    total: number(e.total, prev.total || 0),
    eta: phase === 'downloading' ? (Number.isFinite(Number(e.eta)) ? Number(e.eta) : prev.eta || 0) : 0,
    format: String(e.format ?? prev.format ?? ''),
    message: String(e.message ?? '')
  };
  // Фаза после скачивания не откатывается назад из-за запоздавшего события.
  const order = ['queued', 'extracting', 'downloading', 'converting', 'metadata', 'thumbnail', 'saving'];
  if (prev.phase && order.includes(prev.phase) && order.includes(phase) && order.indexOf(phase) < order.indexOf(prev.phase) && prev.phase !== 'downloading') {
    next.phase = prev.phase;
  }
  return next;
}

/** Готовые строки для интерфейса. */
export function progressView(info) {
  const p = info || {};
  const percent = Math.round(p.progress || 0);
  const lines = [PHASES[p.phase] ? (p.phase === 'downloading' ? 'Скачивание: ' + percent + '%' : PHASES[p.phase]) : 'Скачивание'];
  if (p.phase === 'downloading') {
    const speed = formatSpeed(p.speed);
    if (speed) lines.push('Скорость: ' + speed);
    const done = formatBytes(p.downloaded || (p.total ? (p.total * (p.progress || 0)) / 100 : 0));
    const total = formatBytes(p.total);
    if (done && total) lines.push('Загружено: ' + done + ' / ' + total);
    else if (done) lines.push('Загружено: ' + done);
    const eta = formatEta(p.eta);
    if (eta && p.speed) lines.push('Осталось: ' + eta);
  }
  const indeterminate = !['downloading', 'converting', 'metadata', 'thumbnail', 'saving'].includes(p.phase) ? true : p.phase !== 'downloading';
  return { lines, percent, indeterminate, phase: p.phase || 'downloading' };
}

/** Ограничитель частоты: обновляет интерфейс не чаще раза в minMs, последнее значение не теряется. */
export function createThrottle(fn, minMs = 250, { now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let last = -Infinity; let timer = null; let pending;
  const run = () => { timer = null; last = now(); const args = pending; pending = undefined; fn(...args); };
  const throttled = (...args) => {
    pending = args;
    const wait = minMs - (now() - last);
    if (wait <= 0) { if (timer) { clearTimer(timer); timer = null; } run(); } else if (!timer) timer = setTimer(run, wait);
  };
  throttled.flush = () => { if (timer) { clearTimer(timer); timer = null; } if (pending) run(); };
  return throttled;
}
