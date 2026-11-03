/** IndexedDB access kept outside the app/UI module so persistence can be tested independently. */

/** Индексы хранилища треков. Добавляются миграцией; уже сохранённые записи не затрагиваются. */
export const LIBRARY_INDEXES = [
  { name: 'sourceId', keyPath: 'sourceId' },
  { name: 'youtubeId', keyPath: 'youtubeId' },
  { name: 'addedAt', keyPath: 'addedAt' }
];

/** Миграция схемы: версия 1 — только хранилище; версия 2 — индексы. Данные никогда не удаляются. */
export function upgradeLibraryStore(db, transaction, oldVersion, storeName) {
  const store = db.objectStoreNames.contains(storeName)
    ? transaction.objectStore(storeName)
    : db.createObjectStore(storeName, { keyPath: 'id' });
  if (oldVersion < 2) {
    for (const index of LIBRARY_INDEXES) {
      if (!store.indexNames.contains(index.name)) store.createIndex(index.name, index.keyPath, { unique: false });
    }
  }
  return store;
}

export function createLibraryStore({ databaseName, version, storeName, indexedDBApi = globalThis.indexedDB }) {
  function open() {
    return new Promise((resolve, reject) => {
      if (!indexedDBApi) {
        reject(new Error('Это устройство не поддерживает локальное хранилище медиатеки.'));
        return;
      }
      const request = indexedDBApi.open(databaseName, version);
      request.onupgradeneeded = (event) => {
        upgradeLibraryStore(request.result, request.transaction, event && event.oldVersion || 0, storeName);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Не удалось открыть медиатеку.'));
    });
  }

  function getAll(db) {
    return new Promise((resolve, reject) => {
      const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error || new Error('Не удалось прочитать медиатеку.'));
    });
  }

  function putMany(db, records) {
    return new Promise((resolve, reject) => {
      if (!db || !records.length) { resolve(); return; }
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      records.forEach((record) => store.put(record));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Не удалось сохранить треки.'));
      tx.onabort = () => reject(tx.error || new Error('Сохранение отменено.'));
    });
  }

  function removeMany(db, ids) {
    return new Promise((resolve, reject) => {
      if (!db || !ids.length) { resolve(); return; }
      const tx = db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      ids.forEach((id) => store.delete(id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Не удалось удалить треки.'));
      tx.onabort = () => reject(tx.error || new Error('Удаление отменено.'));
    });
  }

  return { open, getAll, putMany, removeMany, close: (db) => { try { db && db.close(); } catch (_) {} } };
}

export function migratePreferenceKeys(storage, currentKeys, legacyKeys) {
  for (const name of Object.keys(legacyKeys)) {
    try {
      const legacy = storage.getItem(legacyKeys[name]);
      if (legacy === null) continue;
      const current = storage.getItem(currentKeys[name]);
      if (current === null || current === '[]') {
        storage.setItem(currentKeys[name], legacy);
        storage.removeItem(legacyKeys[name]);
      }
    } catch (_) {
      // Storage can be unavailable in private or quota-constrained WebViews.
    }
  }
}
