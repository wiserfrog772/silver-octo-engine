/**
 * Очередь скачиваний: ограниченный параллелизм, отмена отдельного задания, изоляция ошибок.
 * Параллельность разных треков настраивается здесь; параллельная загрузка фрагментов одного трека
 * регулируется отдельно параметром yt-dlp (--concurrent-fragments) и друг с другом не связана.
 */
export const MAX_CONCURRENCY = 4;
export const DEFAULT_CONCURRENCY = 2;

export function clampConcurrency(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_CONCURRENCY;
  return Math.max(1, Math.min(MAX_CONCURRENCY, n));
}

export function createDownloadQueue({ concurrency = DEFAULT_CONCURRENCY, run, onChange = () => {}, cancelNative = async () => {} } = {}) {
  let limit = clampConcurrency(concurrency);
  const jobs = new Map();      // id -> { id, state, job, controller, promise }
  const waiting = [];          // порядок ожидания

  const emit = (id) => { try { onChange(id, snapshotOf(id)); } catch (_) {} };
  const snapshotOf = (id) => { const entry = jobs.get(id); return entry ? { id, state: entry.state, error: entry.error || null } : null; };
  // A native cancellation is asynchronous: until run() settles, the worker still owns a slot.
  // Counting `cancelling` prevents a burst of cancel/add actions from exceeding the limit.
  const running = () => [...jobs.values()].filter((entry) => entry.state === 'running' || entry.state === 'cancelling').length;

  function pump() {
    while (running() < limit && waiting.length) {
      const id = waiting.shift();
      const entry = jobs.get(id);
      if (!entry || entry.state !== 'queued') continue;
      entry.state = 'running';
      emit(id);
      Promise.resolve()
        .then(() => run(entry.job, entry.signal))
        .then((result) => { if (entry.state === 'running') { entry.state = 'done'; entry.result = result; } })
        .catch((error) => {
          // Ошибка одного трека не останавливает очередь.
          if (entry.state === 'cancelling' || entry.cancelled) entry.state = 'cancelled';
          else { entry.state = 'error'; entry.error = error; }
        })
        .then(() => { if (entry.cancelled && entry.state !== 'done') entry.state = 'cancelled'; emit(id); entry.settle(entry); pump(); });
    }
  }

  /** Добавляет задание. Повторное добавление активного задания возвращает тот же результат (без дублей). */
  function add(job) {
    const id = String(job && job.id);
    const existing = jobs.get(id);
    if (existing && (existing.state === 'queued' || existing.state === 'running' || existing.state === 'cancelling')) return existing.promise;
    const entry = { id, job, state: 'queued', cancelled: false, signal: { cancelled: false } };
    entry.promise = new Promise((resolve) => { entry.settle = (e) => resolve({ id, state: e.state, result: e.result, error: e.error || null }); });
    jobs.set(id, entry);
    waiting.push(id);
    emit(id);
    pump();
    return entry.promise;
  }

  /** Отмена: ожидающее задание снимается сразу, выполняющееся останавливается через нативный слой. */
  async function cancel(id) {
    const entry = jobs.get(String(id));
    if (!entry) return false;
    if (entry.state === 'queued') {
      const index = waiting.indexOf(entry.id);
      if (index >= 0) waiting.splice(index, 1);
      entry.state = 'cancelled'; entry.cancelled = true; entry.signal.cancelled = true;
      emit(entry.id); entry.settle(entry);
      return true;
    }
    if (entry.state === 'running') {
      entry.cancelled = true; entry.signal.cancelled = true; entry.state = 'cancelling'; emit(entry.id);
      try { await cancelNative(entry.id); } catch (_) {}
      return true;
    }
    return false;
  }

  return {
    add, cancel,
    setConcurrency(value) { limit = clampConcurrency(value); pump(); },
    get concurrency() { return limit; },
    state: (id) => (jobs.get(String(id)) || {}).state || 'idle',
    counts: () => ({ running: running(), queued: waiting.length }),
    isActive: (id) => ['queued', 'running', 'cancelling'].includes((jobs.get(String(id)) || {}).state)
  };
}
