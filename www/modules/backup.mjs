/**
 * Сохранность пользовательских данных Crimson.
 *
 * Плейлисты хранят не только id треков, но и «ссылки» на них (название, исполнитель, источник).
 * Id треков живут только в данных приложения и теряются при переустановке, а ссылки
 * позволяют после восстановления найти те же композиции в заново отсканированной библиотеке.
 */
import { titleCore } from './library-match.mjs';
import { artistKey } from './track-identity.mjs';

export const BACKUP_APP = 'crimson';
export const BACKUP_SCHEMA = 2;
export const PLAYLIST_EXPORT_KIND = 'crimson-playlists';

/** Быстрый несекретный хеш (cyrb53): защищает от обрыва записи и порчи, а не от подделки. */
export function hash53(text, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  const value = String(text);
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

const clean = (value, max = 300) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

/** Ссылка на трек для хранения в плейлисте и резервной копии. */
export function refFromTrack(track) {
  if (!track) return null;
  const ref = {
    id: clean(track.id, 400),
    name: clean(track.name),
    artist: clean(track.artist),
    duration: Math.round(Number(track.duration) || 0)
  };
  if (track.sourceId) ref.sourceId = clean(track.sourceId, 600);
  if (track.youtubeId) ref.youtubeId = clean(track.youtubeId, 32);
  return ref;
}

function titleArtistKey(ref) {
  const title = titleCore(ref.name || '');
  if (!title) return '';
  return `${artistKey(ref.artist || '')}|${title.replace(/\s+/g, '')}`;
}

/** Строит индексы библиотеки для быстрого сопоставления ссылок. */
export function buildTrackLookup(tracks) {
  const byId = new Map();
  const bySource = new Map();
  const byYoutube = new Map();
  const byKey = new Map();
  const byTitle = new Map();
  for (const track of Array.isArray(tracks) ? tracks : []) {
    if (!track || track.id == null) continue;
    byId.set(String(track.id), track);
    if (track.sourceId) bySource.set(String(track.sourceId), track);
    if (track.youtubeId) byYoutube.set(String(track.youtubeId), track);
    const ref = { name: track.name, artist: track.artist };
    const key = titleArtistKey(ref);
    if (key && !byKey.has(key)) byKey.set(key, track);
    const titleOnly = titleCore(track.name || '').replace(/\s+/g, '');
    if (titleOnly) {
      if (!byTitle.has(titleOnly)) byTitle.set(titleOnly, []);
      byTitle.get(titleOnly).push(track);
    }
  }
  return { byId, bySource, byYoutube, byKey, byTitle };
}

/**
 * Находит трек по ссылке. Порядок надёжности: id → источник → videoId → «исполнитель+название».
 * Совпадение только по названию принимается лишь когда оно единственное.
 */
export function resolveTrackRef(ref, lookup) {
  if (!ref) return null;
  if (ref.id && lookup.byId.has(String(ref.id))) return lookup.byId.get(String(ref.id));
  if (ref.sourceId && lookup.bySource.has(String(ref.sourceId))) return lookup.bySource.get(String(ref.sourceId));
  if (ref.youtubeId && lookup.byYoutube.has(String(ref.youtubeId))) return lookup.byYoutube.get(String(ref.youtubeId));
  const key = titleArtistKey(ref);
  if (key && lookup.byKey.has(key)) return lookup.byKey.get(key);
  const titleOnly = titleCore(ref.name || '').replace(/\s+/g, '');
  const sameTitle = titleOnly ? lookup.byTitle.get(titleOnly) : null;
  if (sameTitle && sameTitle.length === 1) {
    const candidate = sameTitle[0];
    const noArtist = !ref.artist || !candidate.artist || /неизвестн|unknown/i.test(ref.artist + ' ' + candidate.artist);
    if (noArtist) return candidate;
  }
  return null;
}

function uniqueRefs(refs) {
  const seen = new Set();
  return refs.filter((ref) => {
    const key = ref.id ? 'id:' + ref.id : 'k:' + titleArtistKey(ref);
    const byName = 'k:' + titleArtistKey(ref);
    if (seen.has(key) || (ref.name && seen.has(byName))) return false;
    seen.add(key);
    if (ref.name) seen.add(byName);
    return true;
  });
}

/** Нормализует плейлист из любого поддерживаемого формата. */
export function normalizePlaylist(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const id = clean(raw.id, 120);
  const name = clean(raw.name, 120);
  if (!id || !name) return null;
  const refs = [];
  const seen = new Set();
  const addRef = (ref) => {
    if (!ref || !ref.id && !ref.name) return;
    const key = ref.id ? 'id:' + ref.id : 'k:' + titleArtistKey(ref);
    if (seen.has(key)) return;
    seen.add(key);
    refs.push(ref);
  };
  if (Array.isArray(raw.refs)) {
    for (const item of raw.refs) {
      if (!item || typeof item !== 'object') continue;
      addRef({
        id: clean(item.id, 400), name: clean(item.name), artist: clean(item.artist),
        duration: Math.max(0, Math.round(Number(item.duration) || 0)),
        ...(item.sourceId ? { sourceId: clean(item.sourceId, 600) } : {}),
        ...(item.youtubeId ? { youtubeId: clean(item.youtubeId, 32) } : {})
      });
    }
  }
  const trackIds = [];
  const seenIds = new Set();
  for (const value of Array.isArray(raw.trackIds) ? raw.trackIds : []) {
    const trackId = clean(value, 400);
    if (!trackId || seenIds.has(trackId)) continue;
    seenIds.add(trackId);
    trackIds.push(trackId);
    if (!refs.some((ref) => ref.id === trackId)) refs.push({ id: trackId, name: '', artist: '', duration: 0 });
  }
  return { id, name, trackIds, refs, createdAt: Number(raw.createdAt) > 0 ? Number(raw.createdAt) : now };
}

/** Приводит refs в соответствие с текущим составом и порядком trackIds, сохраняя ещё не найденные ссылки. */
export function syncPlaylistRefs(playlist, tracks) {
  const lookup = buildTrackLookup(tracks);
  const known = new Set(playlist.trackIds.map(String));
  const refs = [];
  for (const id of playlist.trackIds) {
    const track = lookup.byId.get(String(id));
    const previous = (playlist.refs || []).find((ref) => ref.id === String(id));
    refs.push(track ? refFromTrack(track) : (previous || { id: String(id), name: '', artist: '', duration: 0 }));
  }
  // Сохраняем ссылки, которые пока не удалось сопоставить (например, до сканирования папки).
  const pending = (playlist.refs || []).filter((ref) => !known.has(String(ref.id)) && (ref.name || ref.sourceId || ref.youtubeId) && !resolveTrackRef(ref, lookup));
  return { ...playlist, refs: refs.concat(pending) };
}

/**
 * Быстрое обновление refs без построения индекса всей библиотеки (для частых сохранений).
 * Ссылки на треки, которых сейчас нет в библиотеке, считаются ожидающими и сохраняются.
 */
export function updatePlaylistRefs(playlist, getTrack) {
  const known = new Set(playlist.trackIds.map(String));
  const previous = Array.isArray(playlist.refs) ? playlist.refs : [];
  const refs = playlist.trackIds.map((id) => {
    const track = getTrack(id);
    return track ? refFromTrack(track) : (previous.find((ref) => ref.id === String(id)) || { id: String(id), name: '', artist: '', duration: 0 });
  });
  const pending = previous.filter((ref) => !known.has(String(ref.id)) && (ref.name || ref.sourceId || ref.youtubeId) && !getTrack(ref.id));
  return refs.concat(pending);
}

/**
 * После изменения библиотеки подтягивает треки, которых раньше не было (восстановление после
 * переустановки). Порядок определяется порядком refs. Возвращает новые плейлисты и сводку.
 */
export function reconcilePlaylists(playlists, tracks) {
  const lookup = buildTrackLookup(tracks);
  let resolved = 0;
  let pending = 0;
  const next = (Array.isArray(playlists) ? playlists : []).map((playlist) => {
    if (!playlist.refs || !playlist.refs.length) return playlist;
    const ids = [];
    const seen = new Set();
    const refs = [];
    for (const ref of playlist.refs) {
      const track = resolveTrackRef(ref, lookup);
      if (track) {
        const id = String(track.id);
        if (!seen.has(id)) { seen.add(id); ids.push(id); refs.push(refFromTrack(track)); if (ref.id !== id) resolved += 1; }
      } else if (ref.name || ref.sourceId || ref.youtubeId) {
        pending += 1;
        refs.push(ref);
      }
    }
    // Если пользователь уже менял состав, порядок trackIds, сохранённый раньше, важнее.
    const merged = playlist.trackIds.filter((id) => lookup.byId.has(String(id)));
    const additions = ids.filter((id) => !merged.includes(id));
    const trackIds = playlist.trackIds.length && !playlist.trackIds.every((id) => lookup.byId.has(String(id)))
      ? ids : merged.concat(additions);
    return { ...playlist, trackIds, refs };
  });
  return { playlists: next, resolved, pending };
}

/** Снимок всего, что должно пережить переустановку. */
export function createSnapshot({ playlists = [], tracks = [], queue = [], quickAddPlaylistId = null, playbackPlaylistId = null, sortMode = 'recent', settings = {}, now = Date.now() } = {}) {
  const lookup = buildTrackLookup(tracks);
  const items = playlists.map((playlist) => normalizePlaylist(playlist, { now })).filter(Boolean).map((playlist) => {
    const synced = syncPlaylistRefs(playlist, tracks);
    return { id: synced.id, name: synced.name, createdAt: synced.createdAt, trackIds: synced.trackIds, refs: synced.refs };
  });
  const queueRefs = queue.map((id) => lookup.byId.get(String(id))).filter(Boolean).map(refFromTrack);
  return {
    app: BACKUP_APP,
    schema: BACKUP_SCHEMA,
    createdAt: now,
    data: {
      playlists: items,
      queue: queueRefs,
      quickAddPlaylistId: quickAddPlaylistId || null,
      playbackPlaylistId: playbackPlaylistId || null,
      sortMode: String(sortMode || 'recent'),
      settings: settings && typeof settings === 'object' ? settings : {}
    }
  };
}

export function encodeBackup(snapshot) {
  const body = JSON.stringify(snapshot.data);
  return JSON.stringify({ app: snapshot.app, schema: snapshot.schema, createdAt: snapshot.createdAt, checksum: hash53(body), data: snapshot.data });
}

/** Миграции формата: каждая переводит данные на следующую версию, ничего не теряя. */
const MIGRATIONS = {
  // v1 — первые выгрузки: плейлисты содержали только trackIds, без refs и без настроек.
  1(envelope) {
    const data = envelope.data || {};
    return {
      ...envelope, schema: 2,
      data: {
        playlists: (data.playlists || []).map((p) => ({ ...p, refs: Array.isArray(p.refs) ? p.refs : [] })),
        queue: Array.isArray(data.queue) ? data.queue.map((id) => (typeof id === 'string' ? { id, name: '', artist: '', duration: 0 } : id)) : [],
        quickAddPlaylistId: data.quickAddPlaylistId || null,
        playbackPlaylistId: data.playbackPlaylistId || null,
        sortMode: data.sortMode || 'recent',
        settings: data.settings || {}
      }
    };
  }
};

export function migrateEnvelope(envelope) {
  let current = envelope;
  let guard = 0;
  while (current.schema < BACKUP_SCHEMA && guard++ < 20) {
    const migrate = MIGRATIONS[current.schema];
    if (!migrate) throw new Error('Неизвестная версия резервной копии: ' + current.schema);
    current = migrate(current);
  }
  return current;
}

/** Безопасный разбор: ничего не применяет, возвращает результат или причину отказа. */
export function decodeBackup(text) {
  let envelope;
  try { envelope = JSON.parse(String(text)); } catch (_) { return { ok: false, error: 'Файл повреждён или обрезан (некорректный JSON).' }; }
  if (!envelope || typeof envelope !== 'object' || envelope.app !== BACKUP_APP) return { ok: false, error: 'Это не резервная копия Crimson.' };
  if (!Number.isInteger(envelope.schema) || envelope.schema < 1) return { ok: false, error: 'Не удалось определить версию резервной копии.' };
  if (envelope.schema > BACKUP_SCHEMA) return { ok: false, error: 'Копия создана более новой версией Crimson. Обнови приложение.' };
  if (envelope.checksum !== undefined && envelope.checksum !== hash53(JSON.stringify(envelope.data))) {
    return { ok: false, error: 'Контрольная сумма не совпала: копия повреждена.' };
  }
  if (!envelope.data || !Array.isArray(envelope.data.playlists)) return { ok: false, error: 'В копии нет данных плейлистов.' };
  let migrated;
  try { migrated = migrateEnvelope(envelope); } catch (error) { return { ok: false, error: error.message }; }
  const playlists = migrated.data.playlists.map((playlist) => normalizePlaylist(playlist, { now: migrated.createdAt || Date.now() })).filter(Boolean);
  return {
    ok: true,
    wasMigrated: envelope.schema < BACKUP_SCHEMA,
    snapshot: { app: BACKUP_APP, schema: BACKUP_SCHEMA, createdAt: Number(migrated.createdAt) || 0, data: { ...migrated.data, playlists } }
  };
}

/** Из нескольких кандидатов (файл приложения, папка пользователя, Auto Backup) берёт самую свежую исправную. */
export function pickNewestValidBackup(candidates) {
  let best = null;
  const problems = [];
  for (const candidate of candidates || []) {
    if (!candidate || !candidate.text) continue;
    const decoded = decodeBackup(candidate.text);
    if (!decoded.ok) { problems.push({ source: candidate.source || '', error: decoded.error }); continue; }
    if (!best || decoded.snapshot.createdAt > best.snapshot.createdAt) best = { ...decoded, source: candidate.source || '' };
  }
  return { best, problems };
}

/** Какие из резервных копий удалить, оставив N последних. */
export function planBackupRotation(files, keep = 5) {
  const sorted = (files || []).slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return { keep: sorted.slice(0, keep), remove: sorted.slice(keep) };
}

/** Экспорт только плейлистов: можно перенести на другое устройство. */
export function exportPlaylists(playlists, tracks, now = Date.now()) {
  const snapshot = createSnapshot({ playlists, tracks, now });
  const data = { playlists: snapshot.data.playlists };
  return JSON.stringify({ app: BACKUP_APP, kind: PLAYLIST_EXPORT_KIND, schema: BACKUP_SCHEMA, createdAt: now, checksum: hash53(JSON.stringify(data)), data });
}

/**
 * Импорт плейлистов: ничего не затирает. Одноимённый плейлист с тем же id объединяется,
 * при конфликте id создаётся копия. Возвращает новый список и отчёт.
 */
export function importPlaylists(text, existing, tracks, { makeId = () => 'pl-' + Math.random().toString(36).slice(2, 10) } = {}) {
  let envelope;
  try { envelope = JSON.parse(String(text)); } catch (_) { return { ok: false, error: 'Файл повреждён или обрезан.' }; }
  if (!envelope || envelope.app !== BACKUP_APP || !envelope.data || !Array.isArray(envelope.data.playlists)) {
    return { ok: false, error: 'Это не файл плейлистов Crimson.' };
  }
  if (envelope.checksum !== undefined && envelope.checksum !== hash53(JSON.stringify(envelope.data))) {
    return { ok: false, error: 'Контрольная сумма не совпала: файл повреждён.' };
  }
  const lookup = buildTrackLookup(tracks);
  const result = (existing || []).map((playlist) => ({ ...playlist }));
  const report = { added: 0, merged: 0, tracksMatched: 0, tracksMissing: 0 };
  for (const raw of envelope.data.playlists) {
    const incoming = normalizePlaylist(raw);
    if (!incoming) continue;
    const trackIds = [];
    for (const ref of incoming.refs.length ? incoming.refs : incoming.trackIds.map((id) => ({ id, name: '', artist: '', duration: 0 }))) {
      const track = resolveTrackRef(ref, lookup);
      if (track) { if (!trackIds.includes(String(track.id))) trackIds.push(String(track.id)); report.tracksMatched += 1; } else report.tracksMissing += 1;
    }
    const same = result.find((playlist) => playlist.id === incoming.id && playlist.name === incoming.name);
    if (same) {
      same.trackIds = same.trackIds.concat(trackIds.filter((id) => !same.trackIds.includes(id)));
      same.refs = uniqueRefs(syncPlaylistRefs(same, tracks).refs.concat(incoming.refs.filter((ref) => !resolveTrackRef(ref, lookup))));
      report.merged += 1;
    } else {
      const id = result.some((playlist) => playlist.id === incoming.id) ? makeId() : incoming.id;
      const unresolved = incoming.refs.filter((ref) => !resolveTrackRef(ref, lookup));
      result.push({ ...incoming, id, trackIds, refs: uniqueRefs(syncPlaylistRefs({ ...incoming, trackIds }, tracks).refs.concat(unresolved)) });
      report.added += 1;
    }
  }
  return { ok: true, playlists: result, report };
}

/** Проверка целостности хранилища плейлистов. repair=true возвращает исправленный список. */
export function checkPlaylistIntegrity(playlists, tracks, { repair = false } = {}) {
  const lookup = buildTrackLookup(tracks);
  const issues = [];
  const ids = new Set();
  const fixed = [];
  for (const playlist of Array.isArray(playlists) ? playlists : []) {
    const normalized = normalizePlaylist(playlist);
    if (!normalized) { issues.push({ type: 'invalid-playlist' }); continue; }
    if (ids.has(normalized.id)) { issues.push({ type: 'duplicate-playlist-id', playlist: normalized.name }); continue; }
    ids.add(normalized.id);
    const dangling = normalized.trackIds.filter((id) => !lookup.byId.has(id));
    if (dangling.length) issues.push({ type: 'missing-tracks', playlist: normalized.name, count: dangling.length });
    if (Array.isArray(playlist.trackIds) && playlist.trackIds.length !== normalized.trackIds.length) issues.push({ type: 'duplicate-tracks', playlist: normalized.name });
    fixed.push(repair ? { ...normalized, trackIds: normalized.trackIds.filter((id) => lookup.byId.has(id) || !tracks.length) } : normalized);
  }
  return { ok: issues.length === 0, issues, playlists: fixed };
}

/**
 * Защищённая запись в key-value хранилище (localStorage): значение хранится в конверте с контрольной
 * суммой, предыдущая исправная версия остаётся в «.bak». Обрыв записи не оставляет нечитаемых данных.
 */
export function writeGuarded(storage, key, value) {
  const body = JSON.stringify(value);
  const envelope = JSON.stringify({ v: 1, sum: hash53(body), body });
  const previous = storage.getItem(key);
  if (previous && readEnvelope(previous) !== undefined) storage.setItem(key + '.bak', previous);
  storage.setItem(key, envelope);
  // Проверка записи: читаем обратно и сверяем.
  if (storage.getItem(key) !== envelope) throw new Error('Запись не подтвердилась.');
}

function readEnvelope(text) {
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.v === 1 && typeof parsed.body === 'string') {
      return hash53(parsed.body) === parsed.sum ? JSON.parse(parsed.body) : undefined;
    }
    return undefined;
  } catch (_) { return undefined; }
}

/** Читает защищённое значение; поддерживает старый формат (обычный JSON) без потери данных. */
export function readGuarded(storage, key, fallback = null) {
  const sources = [key, key + '.bak'];
  for (let i = 0; i < sources.length; i++) {
    let text;
    try { text = storage.getItem(sources[i]); } catch (_) { continue; }
    if (!text) continue;
    const value = readEnvelope(text);
    if (value !== undefined) return { value, recovered: i > 0, legacy: false };
    if (i === 0) {
      // Старый формат без конверта: обычный JSON.
      try {
        const legacy = JSON.parse(text);
        if (legacy && typeof legacy === 'object' && !('body' in legacy && 'sum' in legacy)) return { value: legacy, recovered: false, legacy: true };
      } catch (_) { /* повреждён — пробуем копию */ }
    }
  }
  return { value: fallback, recovered: false, legacy: false, missing: true };
}
