const test = require('node:test');
const assert = require('node:assert/strict');

let b;
test.before(async () => { b = await import('../www/modules/backup.mjs'); });

const tracks = [
  { id: 'folder:content://a/1', sourceId: 'content://a/1', name: 'Numb', artist: 'Linkin Park', duration: 185 },
  { id: 'youtube:abc12345678', sourceId: 'abc12345678', youtubeId: 'abc12345678', name: 'Blinding Lights', artist: 'The Weeknd', duration: 200 },
  { id: 'folder:content://a/3', sourceId: 'content://a/3', name: 'Hello', artist: 'Adele', duration: 295 }
];
const playlists = [
  { id: 'p1', name: 'Любимое', createdAt: 100, trackIds: [tracks[2].id, tracks[0].id, tracks[1].id] },
  { id: 'p2', name: 'Пустой', createdAt: 200, trackIds: [] }
];
const memoryStorage = () => { const m = new Map(); return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

test('снимок → текст → разбор сохраняет названия, порядок и настройки', () => {
  const snap = b.createSnapshot({ playlists, tracks, queue: [tracks[1].id], quickAddPlaylistId: 'p1', sortMode: 'title', settings: { a: 1 }, now: 5000 });
  const decoded = b.decodeBackup(b.encodeBackup(snap));
  assert.equal(decoded.ok, true);
  const p1 = decoded.snapshot.data.playlists[0];
  assert.equal(p1.name, 'Любимое');
  assert.deepEqual(p1.trackIds, [tracks[2].id, tracks[0].id, tracks[1].id]);
  assert.deepEqual(p1.refs.map((r) => r.name), ['Hello', 'Numb', 'Blinding Lights']);
  assert.equal(decoded.snapshot.data.quickAddPlaylistId, 'p1');
  assert.equal(decoded.snapshot.data.sortMode, 'title');
  assert.deepEqual(decoded.snapshot.data.settings, { a: 1 });
  assert.equal(decoded.snapshot.data.queue[0].name, 'Blinding Lights');
});

test('переустановка: после сканирования треки получают новые id, порядок сохраняется', () => {
  const text = b.encodeBackup(b.createSnapshot({ playlists, tracks, now: 1 }));
  const restored = b.decodeBackup(text).snapshot.data.playlists;
  // До сканирования библиотеки: плейлисты восстановлены, ссылки ждут
  let r = b.reconcilePlaylists(restored, []);
  assert.equal(r.pending, 3);
  assert.equal(r.playlists[0].name, 'Любимое');
  // После переустановки id изменились (другой URI источника, другой префикс), но название+исполнитель те же
  const reinstalled = [
    { id: 'folder:content://NEW/9', sourceId: 'content://NEW/9', name: 'Hello', artist: 'Adele', duration: 295 },
    { id: 'folder:content://NEW/7', sourceId: 'content://NEW/7', name: 'Numb', artist: 'Linkin Park', duration: 185 },
    { id: 'youtube:abc12345678', sourceId: 'abc12345678', youtubeId: 'abc12345678', name: 'Blinding Lights', artist: 'The Weeknd', duration: 200 }
  ];
  r = b.reconcilePlaylists(r.playlists, reinstalled);
  assert.deepEqual(r.playlists[0].trackIds, ['folder:content://NEW/9', 'folder:content://NEW/7', 'youtube:abc12345678']);
  assert.equal(r.pending, 0);
  // частичное сканирование: найденные подтягиваются, остальные ждут
  const partial = b.reconcilePlaylists(restored, [reinstalled[1]]);
  assert.deepEqual(partial.playlists[0].trackIds, ['folder:content://NEW/7']);
  assert.equal(partial.pending, 2);
  const complete = b.reconcilePlaylists(partial.playlists, reinstalled);
  assert.equal(complete.playlists[0].trackIds.length, 3);
});

test('повреждённая, обрезанная и чужая копии отклоняются без применения', () => {
  const text = b.encodeBackup(b.createSnapshot({ playlists, tracks, now: 1 }));
  assert.equal(b.decodeBackup(text.slice(0, text.length - 20)).ok, false);
  const tampered = text.replace('Любимое', 'Подмена');
  const bad = b.decodeBackup(tampered);
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Контрольная сумма/);
  assert.equal(b.decodeBackup('{"app":"other"}').ok, false);
  assert.equal(b.decodeBackup('').ok, false);
  const future = JSON.parse(text); future.schema = 99;
  assert.match(b.decodeBackup(JSON.stringify(future)).error, /новой версией/);
});

test('миграция формата v1 сохраняет плейлисты', () => {
  const v1 = JSON.stringify({ app: 'crimson', schema: 1, createdAt: 10, data: { playlists: [{ id: 'old', name: 'Старый', trackIds: ['t1', 't2'] }], queue: ['t1'] } });
  const decoded = b.decodeBackup(v1);
  assert.equal(decoded.ok, true);
  assert.equal(decoded.wasMigrated, true);
  assert.equal(decoded.snapshot.schema, 2);
  assert.deepEqual(decoded.snapshot.data.playlists[0].trackIds, ['t1', 't2']);
  assert.equal(decoded.snapshot.data.queue[0].id, 't1');
});

test('выбирается самая свежая исправная копия', () => {
  const old = b.encodeBackup(b.createSnapshot({ playlists, tracks, now: 100 }));
  const fresh = b.encodeBackup(b.createSnapshot({ playlists: [playlists[1]], tracks, now: 900 }));
  const { best, problems } = b.pickNewestValidBackup([
    { source: 'app', text: old }, { source: 'folder', text: fresh }, { source: 'broken', text: fresh.slice(0, 50) }
  ]);
  assert.equal(best.source, 'folder');
  assert.equal(problems.length, 1);
  assert.equal(b.pickNewestValidBackup([{ text: 'x' }]).best, null);
});

test('ротация: остаются только последние копии', () => {
  const files = Array.from({ length: 8 }, (_, i) => ({ name: 'f' + i, createdAt: i }));
  const plan = b.planBackupRotation(files, 5);
  assert.equal(plan.keep.length, 5);
  assert.deepEqual(plan.remove.map((f) => f.name), ['f2', 'f1', 'f0']);
});

test('экспорт и импорт плейлистов без потерь и без затирания существующих', () => {
  const file = b.exportPlaylists(playlists, tracks, 7);
  const existing = [{ id: 'mine', name: 'Мой', trackIds: [tracks[0].id], refs: [], createdAt: 1 }];
  const imported = b.importPlaylists(file, existing, tracks);
  assert.equal(imported.ok, true);
  assert.equal(imported.playlists.length, 3);
  assert.deepEqual(imported.playlists.find((p) => p.id === 'p1').trackIds, [tracks[2].id, tracks[0].id, tracks[1].id]);
  assert.deepEqual(imported.playlists.find((p) => p.id === 'mine').trackIds, [tracks[0].id]);
  // повторный импорт объединяет, а не дублирует
  const again = b.importPlaylists(file, imported.playlists, tracks);
  assert.equal(again.playlists.length, 3);
  assert.equal(again.report.merged, 2);
  assert.equal(again.playlists.find((p) => p.id === 'p1').trackIds.length, 3);
  // конфликт id при другом названии создаёт копию
  const conflict = b.importPlaylists(file, [{ id: 'p1', name: 'Другое', trackIds: [], refs: [], createdAt: 1 }], tracks, { makeId: () => 'new-id' });
  assert.ok(conflict.playlists.some((p) => p.id === 'new-id' && p.name === 'Любимое'));
  assert.equal(b.importPlaylists(file.replace('Любимое', 'X'), [], tracks).ok, false);
  assert.equal(b.importPlaylists('not json', [], tracks).ok, false);
  // треки, которых нет в библиотеке, считаются и ждут
  const missing = b.importPlaylists(file, [], [tracks[0]]);
  assert.equal(missing.report.tracksMissing, 2);
  assert.equal(missing.playlists.find((p) => p.id === 'p1').refs.length, 3);
});

test('проверка целостности находит и исправляет проблемы', () => {
  const broken = [
    { id: 'a', name: 'A', trackIds: ['x', 'x', tracks[0].id] },
    { id: 'a', name: 'Дубль id', trackIds: [] },
    { id: '', name: 'без id', trackIds: [] },
    null
  ];
  const report = b.checkPlaylistIntegrity(broken, tracks);
  assert.equal(report.ok, false);
  const types = report.issues.map((i) => i.type).sort();
  assert.deepEqual(types, ['duplicate-playlist-id', 'duplicate-tracks', 'invalid-playlist', 'invalid-playlist', 'missing-tracks']);
  const repaired = b.checkPlaylistIntegrity(broken, tracks, { repair: true });
  assert.deepEqual(repaired.playlists[0].trackIds, [tracks[0].id]);
  assert.equal(b.checkPlaylistIntegrity(playlists, tracks).ok, true);
});

test('защищённая запись: восстановление из копии при порче, поддержка старого формата', () => {
  const storage = memoryStorage();
  b.writeGuarded(storage, 'k', { n: 1 });
  b.writeGuarded(storage, 'k', { n: 2 });
  assert.deepEqual(b.readGuarded(storage, 'k').value, { n: 2 });
  // порча основной записи (обрыв при сохранении): читается предыдущая исправная копия
  storage.setItem('k', storage.getItem('k').slice(0, 15));
  const recovered = b.readGuarded(storage, 'k');
  assert.deepEqual(recovered.value, { n: 1 });
  assert.equal(recovered.recovered, true);
  // подмена содержимого без пересчёта суммы
  storage.setItem('k', JSON.stringify({ v: 1, sum: 'deadbeef', body: '{"n":3}' }));
  assert.equal(b.readGuarded(storage, 'k').recovered, true);
  // старый формат (до внедрения конверта) читается без потерь
  storage.setItem('legacy', JSON.stringify([{ id: 'p', name: 'Old', trackIds: [] }]));
  const legacy = b.readGuarded(storage, 'legacy');
  assert.equal(legacy.legacy, true);
  assert.equal(legacy.value[0].name, 'Old');
  assert.equal(b.readGuarded(storage, 'nothing', []).missing, true);
  // запись, не подтвердившаяся при чтении, сообщает об ошибке
  const lossy = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
  assert.throws(() => b.writeGuarded(lossy, 'k', 1));
});

test('быстрое обновление refs сохраняет ожидающие ссылки и убирает удалённые пользователем', () => {
  const lookup = new Map(tracks.map((t) => [t.id, t]));
  const getTrack = (id) => lookup.get(id) || null;
  const playlist = {
    id: 'p', name: 'P', trackIds: [tracks[0].id],
    refs: [
      { id: tracks[0].id, name: 'Numb', artist: 'Linkin Park' },
      { id: tracks[1].id, name: 'Blinding Lights', artist: 'The Weeknd' }, // удалён пользователем: трек в библиотеке есть
      { id: 'folder:gone', name: 'Старый трек', artist: 'X' } // ожидает сканирования
    ]
  };
  const refs = b.updatePlaylistRefs(playlist, getTrack);
  assert.deepEqual(refs.map((r) => r.id), [tracks[0].id, 'folder:gone']);
});
