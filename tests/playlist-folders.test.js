const test = require('node:test');
const assert = require('node:assert/strict');

let f;
test.before(async () => { f = await import('../www/modules/playlist-folders.mjs'); });

const tracks = [
  { id: 't1', name: 'Numb', artist: 'Linkin Park', nativePath: '/cache/a.mp3', fileName: 'Linkin Park - Numb.mp3', duration: 185 },
  { id: 't2', name: 'Hello', artist: 'Adele', nativePath: '/files/x.m4a', duration: 295 },
  { id: 't3', name: 'Hello', artist: 'Adele', nativePath: '/files/y.m4a', duration: 295 },
  { id: 't4', name: 'Из памяти браузера', artist: 'X', nativePath: '' }
];
const byId = (id) => tracks.find((t) => t.id === id) || null;

test('имена папок и файлов безопасны и уникальны', () => {
  assert.equal(f.safeName('AC/DC: Greatest?'), 'AC_DC_ Greatest_');
  assert.equal(f.safeName('  ...  '), 'Без названия');
  assert.equal(f.safeName('Плейлист. '), 'Плейлист');
  const state = f.buildFolderState({ id: 'p', name: 'Мой', trackIds: ['t1', 't2', 't3', 't4'] }, byId);
  assert.deepEqual(state.files.map((x) => x.fileName), ['Linkin Park - Numb.mp3', 'Adele - Hello.m4a', 'Adele - Hello (2).m4a']);
  assert.equal(state.skipped, 1, 'трек без локального файла пропущен и посчитан');
  assert.deepEqual(state.manifest.entries.map((e) => e.file), state.files.map((x) => x.fileName));
});

test('синхронизация: создание, обновление при изменении порядка/названия, удаление', () => {
  const pl = (extra = {}) => ({ id: 'p1', name: 'Любимое', trackIds: ['t1', 't2'], ...extra });
  let plan = f.planFolderSync({}, [pl()], byId);
  assert.equal(plan.upsert.length, 1);
  assert.equal(plan.upsert[0].previousName, '');
  const synced = { p1: { folderName: plan.upsert[0].state.folderName, sig: plan.upsert[0].sig } };
  assert.equal(f.planFolderSync(synced, [pl()], byId).upsert.length, 0, 'без изменений ничего не копируется');
  plan = f.planFolderSync(synced, [pl({ trackIds: ['t2', 't1'] })], byId);
  assert.equal(plan.upsert.length, 1, 'порядок изменился');
  plan = f.planFolderSync(synced, [pl({ name: 'Новое имя' })], byId);
  assert.equal(plan.upsert[0].previousName, 'Любимое', 'переименование передаёт прежнюю папку');
  plan = f.planFolderSync(synced, [], byId);
  assert.deepEqual(plan.remove, [{ id: 'p1', folderName: 'Любимое' }]);
  // одинаковые названия плейлистов → разные папки
  const two = f.planFolderSync({}, [pl(), pl({ id: 'p2' })], byId);
  assert.deepEqual(two.upsert.map((u) => u.state.folderName), ['Любимое', 'Любимое (2)']);
});

test('восстановление после переустановки: плейлисты, порядок и привязка к библиотеке', () => {
  const state = f.buildFolderState({ id: 'p1', name: 'Любимое', createdAt: 5, trackIds: ['t2', 't1'] }, byId);
  const folders = [{ dirName: 'Любимое', manifest: JSON.stringify(state.manifest), files: state.files.map((x) => ({ name: x.fileName, sourceId: 'content://folder/' + x.fileName })) }];
  // новая установка: id треков другие, но название+исполнитель те же
  const fresh = [
    { id: 'folder:N1', sourceId: 'content://new/1', name: 'Numb', artist: 'Linkin Park', duration: 185 },
    { id: 'folder:N2', sourceId: 'content://new/2', name: 'Hello', artist: 'Adele', duration: 295 }
  ];
  const result = f.playlistsFromFolders(folders, fresh, []);
  assert.equal(result.playlists.length, 1);
  assert.equal(result.playlists[0].name, 'Любимое');
  assert.deepEqual(result.playlists[0].trackIds, ['folder:N2', 'folder:N1'], 'порядок из манифеста');
  assert.equal(result.unresolved.length, 0);
  // библиотека пуста: файлы из папки нужно добавить в библиотеку
  const empty = f.playlistsFromFolders(folders, [], []);
  assert.equal(empty.playlists.length, 1);
  assert.equal(empty.unresolved.length, 2);
  // существующий плейлист (тот же id) не перезаписывается
  const again = f.playlistsFromFolders(folders, fresh, [{ id: 'p1', name: 'Любимое', trackIds: [] }]);
  assert.equal(again.playlists.length, 0);
  // повреждённый манифест и посторонние папки пропускаются
  assert.equal(f.playlistsFromFolders([{ dirName: 'x', manifest: '{oops', files: [] }, { dirName: 'y', manifest: '{"app":"other"}', files: [] }], fresh, []).playlists.length, 0);
});

test('файл, удалённый из папки, не попадает в восстановленный плейлист', () => {
  const state = f.buildFolderState({ id: 'p1', name: 'P', trackIds: ['t1', 't2'] }, byId);
  const folders = [{ dirName: 'P', manifest: JSON.stringify(state.manifest), files: [{ name: state.files[0].fileName, sourceId: 's' }] }];
  const fresh = [{ id: 'N1', name: 'Numb', artist: 'Linkin Park' }, { id: 'N2', name: 'Hello', artist: 'Adele' }];
  assert.deepEqual(f.playlistsFromFolders(folders, fresh, []).playlists[0].trackIds, ['N1']);
});

test('имя файла из папки разбирается теми же правилами, что и библиотека', () => {
  assert.deepEqual(f.identityForFolderFile({ name: 'Wiz Khalifa feat. Charlie Puth - See You Again.mp3' }), { name: 'See You Again', artist: 'Wiz Khalifa feat. Charlie Puth' });
  assert.deepEqual(f.identityForFolderFile({ name: 'Просто файл.mp3' }), { name: 'Просто файл', artist: 'Неизвестный исполнитель' });
});
