const test = require('node:test');
const assert = require('node:assert/strict');

let s; let t;
test.before(async () => {
  s = await import('../www/modules/scan-plan.mjs');
  t = await import('../www/modules/track-interactions.mjs');
});

const row = (n, extra = {}) => ({ sourceId: 'content://m/' + n, name: `Track ${n}.mp3`, path: '/cache/' + n, size: 1000 + n, lastModified: 10, duration: 100 + n, ...extra });
const trackFrom = (r) => ({ id: 'folder:' + r.sourceId, sourceId: r.sourceId, name: 'Track', fileName: r.name, size: r.size, lastModified: r.lastModified, duration: r.duration });

test('новая папка: все файлы добавляются, повторы в одном обходе игнорируются', () => {
  const plan = s.planLibrarySync([], [row(1), row(2), row(2), row(3)]);
  assert.equal(plan.add.length, 3);
  assert.equal(plan.duplicates.length, 1);
});

test('повторное сканирование той же папки не создаёт дубликатов и не перечитывает файлы', () => {
  const rows = [row(1), row(2), row(3)];
  const existing = rows.map(trackFrom);
  const plan = s.planLibrarySync(existing, rows);
  assert.equal(plan.add.length, 0);
  assert.equal(plan.unchanged.length, 3);
  assert.equal(plan.update.length, 0);
  // нативный слой отметил неизменённые файлы, не прочитав метаданные
  const light = s.planLibrarySync(existing, [{ sourceId: rows[0].sourceId, unchanged: true }]);
  assert.equal(light.unchanged.length, 1);
});

test('новые и изменённые файлы определяются инкрементально', () => {
  const rows = [row(1), row(2)];
  const existing = rows.map(trackFrom);
  const plan = s.planLibrarySync(existing, [row(1), row(2, { size: 5555, lastModified: 99 }), row(3)]);
  assert.deepEqual(plan.add.map((r) => r.sourceId), ['content://m/3']);
  assert.equal(plan.update.length, 1);
  assert.equal(plan.unchanged.length, 1);
});

test('удалённые из папки файлы убираются только после полного обхода', () => {
  const existing = [row(1), row(2), row(3)].map(trackFrom);
  const full = s.planLibrarySync(existing, [row(1)]);
  assert.deepEqual(full.remove.map((x) => x.sourceId).sort(), ['content://m/2', 'content://m/3']);
  const cancelled = s.planLibrarySync(existing, [row(1)], { complete: false });
  assert.equal(cancelled.remove.length, 0);
});

test('файл, скачанный из YouTube, и копия того же файла в другой папке не дублируются', () => {
  const downloaded = { id: 'youtube:dQw4w9WgXcQ', youtubeId: 'dQw4w9WgXcQ', name: 'Song', size: 5000 };
  const plan = s.planLibrarySync([downloaded], [
    { sourceId: 'content://m/yt', name: 'Artist - Song [dQw4w9WgXcQ].m4a', size: 5001 },
    { sourceId: 'content://a/1', name: 'Song.mp3', size: 7777 },
    { sourceId: 'content://b/1', name: 'Song.mp3', size: 7777 }
  ]);
  assert.equal(plan.add.length, 1);
  assert.deepEqual(plan.duplicates.map((d) => d.reason).sort(), ['downloaded', 'same-file']);
});

test('известные источники передаются нативному слою', () => {
  const known = s.buildKnownSources([trackFrom(row(1)), { id: 'youtube:x', sourceId: 'x' }]);
  assert.deepEqual(Object.keys(known), ['content://m/1']);
  assert.equal(known['content://m/1'].size, 1001);
});

test('индикатор выполнения: подсчёт, проценты, повреждённые файлы, отмена', () => {
  let st = s.reduceScanEvent(s.createScanState(), { type: 'start' });
  assert.equal(st.phase, 'counting');
  assert.equal(s.isScanActive(st), true);
  st = s.reduceScanEvent(st, { type: 'counted', total: 200 });
  st = s.reduceScanEvent(st, { type: 'progress', processed: 50, corrupted: 2, currentName: 'a.mp3' });
  st = s.reduceScanEvent(st, { type: 'plan', added: 40, duplicates: 1, unchanged: 7 });
  assert.equal(st.percent, 25);
  assert.equal(st.skipped, 3);
  st = s.reduceScanEvent(st, { type: 'progress', processed: 30 });
  assert.equal(st.processed, 50, 'прогресс не откатывается назад');
  const cancelled = s.reduceScanEvent(st, { type: 'cancelled' });
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal(s.isScanActive(cancelled), false);
  const done = s.reduceScanEvent(st, { type: 'done' });
  assert.equal(done.percent, 100);
  assert.match(s.scanSummary(done), /добавлено 40/);
  assert.equal(s.reduceScanEvent(st, { type: 'unknown' }), st);
});

test('свайп: прогресс до порога, сопротивление после, фаза и срабатывание', () => {
  assert.deepEqual(t.swipeVisual(0), { progress: 0, offset: 0, phase: 'idle', armed: false });
  const half = t.swipeVisual(34);
  assert.equal(half.progress, 0.5); assert.equal(half.phase, 'pulling'); assert.equal(half.armed, false);
  const ready = t.swipeVisual(68);
  assert.equal(ready.phase, 'ready'); assert.equal(ready.armed, true);
  const far = t.swipeVisual(400);
  assert.ok(far.offset <= 104 && far.offset > 68);
  assert.equal(t.swipeVisual(-30).offset, 0);
  // согласуется с классификацией жеста
  assert.equal(t.classifyTrackSwipe(70, 3), 'commit');
  assert.equal(t.classifyTrackSwipe(40, 3), 'right');
  assert.equal(t.classifyTrackSwipe(10, 60), 'vertical');
});
