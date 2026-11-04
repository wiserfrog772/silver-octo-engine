const test = require('node:test');
const assert = require('node:assert/strict');

let q; let p;
test.before(async () => {
  q = await import('../www/modules/download-queue.mjs');
  p = await import('../www/modules/download-progress.mjs');
});

const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise((r) => setTimeout(r, 0));

test('параллелизм ограничен, остальные ждут, очередь продолжается', async () => {
  const gates = new Map(); let active = 0; let peak = 0;
  const queue = q.createDownloadQueue({ concurrency: 2, run: async (job) => { active++; peak = Math.max(peak, active); const d = deferred(); gates.set(job.id, d); try { return await d.promise; } finally { active--; } } });
  const results = ['a', 'b', 'c', 'd', 'e'].map((id) => queue.add({ id }));
  await tick();
  assert.deepEqual(queue.counts(), { running: 2, queued: 3 });
  gates.get('a').resolve(1); await tick();
  assert.equal(queue.counts().running, 2);
  for (const id of ['b', 'c', 'd', 'e']) { await tick(); if (gates.has(id)) gates.get(id).resolve(1); }
  await tick(); for (const id of ['d', 'e']) if (gates.has(id)) gates.get(id).resolve(1);
  const done = await Promise.all(results);
  assert.ok(done.every((r) => r.state === 'done'));
  assert.ok(peak <= 2, 'пик параллельных заданий ' + peak);
});

test('ошибка одного трека не останавливает очередь', async () => {
  const queue = q.createDownloadQueue({ concurrency: 1, run: async (job) => { if (job.id === 'bad') throw new Error('403'); return 'ok'; } });
  const [a, bad, c] = await Promise.all([queue.add({ id: 'a' }), queue.add({ id: 'bad' }), queue.add({ id: 'c' })]);
  assert.deepEqual([a.state, bad.state, c.state], ['done', 'error', 'done']);
  assert.equal(bad.error.message, '403');
});

test('повторное добавление активного задания не создаёт дубль', async () => {
  let calls = 0; const d = deferred();
  const queue = q.createDownloadQueue({ concurrency: 1, run: async () => { calls++; return d.promise; } });
  const first = queue.add({ id: 'x' }); const second = queue.add({ id: 'x' });
  assert.equal(first, second);
  await tick(); d.resolve(1); await first;
  assert.equal(calls, 1);
  // после завершения (ошибка/готово) задание можно запустить снова
  await queue.add({ id: 'x' }); assert.equal(calls, 2);
});

test('отмена ожидающего и выполняющегося задания', async () => {
  const cancelled = []; const d = deferred();
  const queue = q.createDownloadQueue({ concurrency: 1,
    run: async (job) => { if (job.id === 'run') return d.promise; return 'ok'; },
    cancelNative: async (id) => { cancelled.push(id); d.reject(new Error('cancelled by native')); } });
  const running = queue.add({ id: 'run' }); const waiting = queue.add({ id: 'wait' }); const after = queue.add({ id: 'after' });
  await tick();
  assert.equal(await queue.cancel('wait'), true);
  assert.equal((await waiting).state, 'cancelled');
  assert.equal(await queue.cancel('run'), true);
  assert.deepEqual(cancelled, ['run']);
  assert.equal((await running).state, 'cancelled');
  assert.equal((await after).state, 'done', 'очередь продолжилась после отмены');
  assert.equal(await queue.cancel('unknown'), false);
});

test('количество одновременных загрузок меняется на лету и ограничено сверху', async () => {
  assert.equal(q.clampConcurrency(99), q.MAX_CONCURRENCY);
  assert.equal(q.clampConcurrency(0), 1);
  assert.equal(q.clampConcurrency('abc'), q.DEFAULT_CONCURRENCY);
  const gates = []; let active = 0; let peak = 0;
  const queue = q.createDownloadQueue({ concurrency: 1, run: async () => { active++; peak = Math.max(peak, active); const d = deferred(); gates.push(d); await d.promise; active--; } });
  const all = [1, 2, 3, 4].map((id) => queue.add({ id }));
  await tick(); assert.equal(active, 1);
  queue.setConcurrency(3); await tick(); assert.equal(active, 3);
  gates.forEach((g) => g.resolve()); await tick(); gates.forEach((g) => g.resolve()); await Promise.all(all);
  assert.equal(peak, 3);
});

test('форматирование и состояние прогресса: пример из задания', () => {
  assert.equal(p.formatBytes(18.6 * 1024 * 1024), '18.6 МБ');
  assert.equal(p.formatBytes(0), '');
  assert.equal(p.formatSpeed(4.8 * 1024 * 1024), '4.8 МБ/с');
  assert.equal(p.formatEta(3), '~3 сек.');
  assert.equal(p.formatEta(125), '~2 мин. 05 сек.');
  assert.equal(p.formatEta(NaN), '');
  const state = p.mergeProgress(null, { phase: 'downloading', progress: 68, speed: 4.8 * 1048576, downloaded: 18.6 * 1048576, total: 27.4 * 1048576, eta: 3 });
  const view = p.progressView(state);
  assert.deepEqual(view.lines, ['Скачивание: 68%', 'Скорость: 4.8 МБ/с', 'Загружено: 18.6 МБ / 27.4 МБ', 'Осталось: ~3 сек.']);
  assert.equal(view.percent, 68);
  assert.equal(view.indeterminate, false);
});

test('прогресс: известные значения не затираются, фазы не откатываются, статусы этапов', () => {
  let s = p.mergeProgress(null, { phase: 'downloading', progress: 40, speed: 1000, total: 5000, downloaded: 2000, eta: 3 });
  s = p.mergeProgress(s, { phase: 'downloading', progress: 45 });          // событие без скорости
  assert.equal(s.speed, 1000); assert.equal(s.total, 5000);
  s = p.mergeProgress(s, { phase: 'converting', progress: 100 });
  assert.equal(p.progressView(s).lines[0], 'Конвертация в MP3');
  assert.equal(s.speed, 0);
  s = p.mergeProgress(s, { phase: 'downloading', progress: 100, speed: 5 });   // запоздавшее событие
  assert.equal(s.phase, 'converting');
  assert.equal(p.progressView(p.mergeProgress(null, { phase: 'queued' })).lines[0], 'В очереди');
  assert.equal(p.mergeProgress(null, { phase: 'done', progress: 100 }).status, 'done');
});

test('ограничитель частоты обновлений: лишние события схлопываются, последнее не теряется', () => {
  let t = 0; const timers = []; const calls = [];
  const throttled = p.createThrottle((v) => calls.push(v), 250, { now: () => t, setTimer: (fn, ms) => { timers.push({ fn, at: t + ms }); return timers.length; }, clearTimer: () => {} });
  throttled(1); assert.deepEqual(calls, [1]);
  for (let i = 2; i <= 50; i++) { t += 5; throttled(i); }   // 49 событий за 245 мс
  assert.deepEqual(calls, [1]);
  t = 300; timers.forEach((x) => x.fn());
  assert.deepEqual(calls, [1, 50], '50 событий превратились в 2 обновления');
});
