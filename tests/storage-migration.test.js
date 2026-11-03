const test = require('node:test');
const assert = require('node:assert/strict');

function fakeDb(existingStores = []) {
  const stores = new Map(existingStores.map((name) => [name, { indexes: new Set(), records: [{ id: 'keep' }] }]));
  const makeStore = (name) => ({
    get indexNames() { return { contains: (n) => stores.get(name).indexes.has(n) }; },
    createIndex(n) { stores.get(name).indexes.add(n); }
  });
  return {
    stores,
    db: {
      objectStoreNames: { contains: (n) => stores.has(n) },
      createObjectStore(n) { stores.set(n, { indexes: new Set(), records: [] }); return makeStore(n); }
    },
    transaction: { objectStore: (n) => makeStore(n) }
  };
}

test('миграция IndexedDB v0→v2 создаёт хранилище с индексами', async () => {
  const { upgradeLibraryStore, LIBRARY_INDEXES } = await import('../www/modules/storage.mjs');
  const f = fakeDb();
  upgradeLibraryStore(f.db, f.transaction, 0, 'tracks');
  assert.deepEqual([...f.stores.get('tracks').indexes].sort(), LIBRARY_INDEXES.map((i) => i.name).sort());
});

test('миграция v1→v2 добавляет индексы и не трогает сохранённые записи', async () => {
  const { upgradeLibraryStore } = await import('../www/modules/storage.mjs');
  const f = fakeDb(['tracks']);
  upgradeLibraryStore(f.db, f.transaction, 1, 'tracks');
  assert.equal(f.stores.get('tracks').records.length, 1);
  assert.ok(f.stores.get('tracks').indexes.has('sourceId'));
  // повторный запуск безопасен
  upgradeLibraryStore(f.db, f.transaction, 1, 'tracks');
  assert.equal(f.stores.get('tracks').indexes.size, 3);
  // уже актуальная версия ничего не меняет
  const g = fakeDb(['tracks']);
  upgradeLibraryStore(g.db, g.transaction, 2, 'tracks');
  assert.equal(g.stores.get('tracks').indexes.size, 0);
});
