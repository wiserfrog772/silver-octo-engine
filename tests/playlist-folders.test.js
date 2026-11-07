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
  assert.equal(state.skipped, 1, 'трек без локального файла не копируется и учитывается');
  assert.equal(state.manifest.entries.length, 4, 'ссылка на импортированный трек всё равно сохраняется');
  assert.equal(state.manifest.entries[3].ref.name, 'Из памяти браузера');
  assert.deepEqual(state.manifest.entries.slice(0, 3).map((e) => e.file), state.files.map((x) => x.fileName));
});

test('синхронизация: создание, обновление при изменении порядка/названия, удаление', () => {
  const pl = (extra = {}) => ({ id: 'p1', name: 'Любимое', trackIds: ['t1', 't2'], ...extra });
  let plan = f.planFolderSync({}, [pl()], byId);
  assert.equal(plan.upsert.length, 1);
  assert.equal(plan.upsert[0].previousName, '');
  const synced = { p1: { folderName: plan.upsert[0].state.folderName, sig: plan.upsert[0].sig } };
  assert.equal(f.planFolderSync(synced, [pl()], byId).upsert.length, 0, 'без изменений манифест не переписывается');
  const noPathTrack = { id: 'memory', name: 'Browser import', artist: 'X', nativePath: '' };
  const noPathLookup = (id) => id === 'memory' ? noPathTrack : byId(id);
  const firstMemory = f.planFolderSync({}, [{ id: 'memory-playlist', name: 'Memory', trackIds: [] }], noPathLookup);
  const storedMemory = { 'memory-playlist': { folderName: 'Memory', sig: firstMemory.upsert[0].sig } };
  const withMemoryTrack = f.planFolderSync(storedMemory, [{ id: 'memory-playlist', name: 'Memory', trackIds: ['memory'] }], noPathLookup);
  assert.equal(withMemoryTrack.upsert.length, 1, 'новая ссылка без nativePath тоже меняет манифест');
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

test('манифест восстанавливает плейлист без аудиокопий в его папке', () => {
  const state = f.buildFolderState({ id: 'p1', name: 'P', trackIds: ['t1', 't2'] }, byId);
  const folders = [{ dirName: 'P', manifest: JSON.stringify(state.manifest), files: [] }];
  const fresh = [{ id: 'N1', name: 'Numb', artist: 'Linkin Park' }, { id: 'N2', name: 'Hello', artist: 'Adele' }];
  const restored = f.playlistsFromFolders(folders, fresh, []);
  assert.deepEqual(restored.playlists[0].trackIds, ['N1', 'N2']);
  assert.equal(restored.unresolved.length, 0);
});

test('ручной аудиофайл в существующей папке импортируется и добавляется только в этот плейлист', () => {
  const state = f.buildFolderState({ id: 'p1', name: 'P', trackIds: ['t1'] }, byId);
  const folders = [{ dirName: 'P', manifest: JSON.stringify(state.manifest), files: [
    { name: 'Linkin Park - Numb.mp3', sourceId: 'content://old-copy' },
    { name: 'Adele - Hello.mp3', sourceId: 'content://new-track' }
  ] }];
  const current = [{ id: 'p1', name: 'P', trackIds: ['N1'] }];
  const first = f.playlistsFromFolders(folders, [{ id: 'N1', name: 'Numb', artist: 'Linkin Park' }], current);
  assert.equal(first.playlists.length, 0, 'существующий плейлист не заменяется');
  assert.deepEqual(first.unresolved.map((item) => item.file.sourceId), ['content://new-track']);

  const afterImport = f.playlistsFromFolders(folders, [
    { id: 'N1', name: 'Numb', artist: 'Linkin Park' },
    { id: 'N2', sourceId: 'content://new-track', name: 'Hello', artist: 'Adele' }
  ], current, new Map([['content://new-track', 'N2']]));
  assert.deepEqual(afterImport.additions, [{ playlistId: 'p1', trackIds: ['N2'] }]);
});

test('имя файла из папки разбирается теми же правилами, что и библиотека', () => {
  assert.deepEqual(f.identityForFolderFile({ name: 'Wiz Khalifa feat. Charlie Puth - See You Again.mp3' }), { name: 'See You Again', artist: 'Wiz Khalifa feat. Charlie Puth' });
  assert.deepEqual(f.identityForFolderFile({ name: 'Просто файл.mp3' }), { name: 'Просто файл', artist: 'Неизвестный исполнитель' });
});
