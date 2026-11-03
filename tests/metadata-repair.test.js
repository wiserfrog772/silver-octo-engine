const test = require('node:test');
const assert = require('node:assert/strict');

let r;
test.before(async () => { r = await import('../www/modules/metadata-repair.mjs'); });

const folder = (file, name, artist, extra = {}) => ({
  id: 'folder:content://tree/' + encodeURIComponent('primary:Music/' + file), sourceId: 'content://tree/' + encodeURIComponent('primary:Music/' + file),
  name, artist, ...extra
});

test('повреждённые названия из реальных жалоб находятся и исправляются по имени файла', () => {
  const tracks = [
    folder('Wiz Khalifa - See You Again (ft. Charlie Puth).mp3', 'See You Again (ft', 'Wiz Khalifa'),
    folder('Big Poe feat. Another Artist - Track Name.mp3', 'Big Poe feat', 'Неизвестный исполнитель'),
    folder('Artist - Mr. Brightside.m4a', 'Mr', 'Artist'),
    folder('Ленинград - Экспонат.mp3', 'Экспонат', 'Ленинград') // уже верно
  ];
  const plan = r.planRepairs(tracks);
  assert.equal(plan.length, 3);
  assert.deepEqual(plan.map((p) => [p.to.artist, p.to.name]), [
    ['Wiz Khalifa feat. Charlie Puth', 'See You Again'],
    ['Big Poe feat. Another Artist', 'Track Name'],
    ['Artist', 'Mr. Brightside']
  ]);
  assert.equal(plan[2].kind, 'truncated');
  assert.equal(plan[1].kind, 'missing-artist');
});

test('идентификаторы, плейлисты и аудиоданные не затрагиваются; откат возвращает старые значения', () => {
  const tracks = [folder('A - B (ft. C).mp3', 'B (ft', 'A', { nativePath: '/cache/x', size: 5, duration: 100 })];
  const plan = r.planRepairs(tracks);
  const { tracks: fixed, undo } = r.applyRepairs(tracks, plan);
  assert.equal(fixed[0].id, tracks[0].id);
  assert.equal(fixed[0].nativePath, '/cache/x');
  assert.equal(fixed[0].size, 5);
  assert.equal(fixed[0].name, 'B');
  assert.equal(tracks[0].name, 'B (ft', 'исходный объект не мутируется');
  const restored = r.undoRepairs(fixed, undo);
  assert.equal(restored[0].name, 'B (ft');
  assert.equal(restored[0].artist, 'A');
  assert.equal(r.planRepairs(fixed).length, 0, 'повторный запуск ничего не меняет');
});

test('нет оригинального имени файла — ничего не угадываем', () => {
  assert.equal(r.proposeRepair({ id: 'youtube:abc', name: 'Song (ft', artist: 'X' }), null);
  assert.equal(r.proposeRepair({ id: 'folder:opaque', sourceId: '12345', name: 'x', artist: '' }), null);
  assert.equal(r.proposeRepair(null), null);
  assert.equal(r.originalFileName({ fileName: 'a - b.mp3' }), 'a - b.mp3');
  assert.equal(r.originalFileName({ sourceId: 'content://t/primary%3AMusic%2FДа%20-%20Нет%20%28ft.%20X%29.mp3' }), 'Да - Нет (ft. X).mp3');
});

test('настоящие названия с цифрами и точками не считаются повреждёнными', () => {
  const tracks = [
    folder('Ariana Grande - 7 rings.mp3', '7 rings', 'Ariana Grande'),
    folder('Green Day - 21 Guns.mp3', '21 Guns', 'Green Day'),
    folder('AC_DC - T.N.T..mp3', 'T.N.T.', 'AC DC')
  ];
  assert.equal(r.planRepairs(tracks).length, 0);
});

test('описание для подтверждения', () => {
  const plan = r.planRepairs([folder('A - B (ft. C).mp3', 'B (ft', 'A')]);
  assert.match(r.describeRepairs(plan), /B \(ft {2}→ {2}A feat\. C — B/);
});
