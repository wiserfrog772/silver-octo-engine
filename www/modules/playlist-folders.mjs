/**
 * Плейлисты как обычные папки «Название [короткий ID]» прямо в выбранном корне; манифест хранит связи и порядок.
 * Аудио не копируется в каждую подборку. Папка лежит в выбранном пользователем хранилище и переживает
 * переустановку: после выбора той же папки плейлисты восстанавливаются вместе с порядком треков.
 */
import { hash53, refFromTrack, reconcilePlaylists, normalizePlaylist, buildTrackLookup, resolveTrackRef } from './backup.mjs';
import { libraryNameFromFilename, stripAudioExtension } from './track-identity.mjs';

export const PLAYLISTS_DIR = 'Crimson Playlists'; // legacy container, read only during migration

/** Папка плейлиста: читаемое имя + стабильный короткий ID, например Rock [06889c86]. */
export function playlistFolderName(playlist) {
  const id = String(playlist && playlist.id || '');
  const suffix = hash53(id).toString(16).padStart(8, '0').slice(-8);
  return `${safeName(playlist && playlist.name, 'Плейлист')} [${suffix}]`;
}
export const MANIFEST_NAME = 'crimson-playlist.json';
export const MANIFEST_KIND = 'crimson-playlist';
const AUDIO_EXT_RE = /\.(mp3|m4a|aac|ogg|opus|wav|flac|webm|oga|mp4|wma|aiff?|alac)$/i;

const clean = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

/** Допустимое имя папки/файла: запрещённые символы заменяются, точки и пробелы по краям убираются. */
export function safeName(value, fallback = 'Без названия', max = 80) {
  const name = clean(value).replace(/[\\/:*?"<>|]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, max).replace(/[. ]+$/g, '');
  return name || fallback;
}

function uniqueName(base, used, ext = '') {
  let candidate = base + ext;
  let n = 2;
  while (used.has(candidate.toLocaleLowerCase())) candidate = `${base} (${n++})${ext}`;
  used.add(candidate.toLocaleLowerCase());
  return candidate;
}

export function extensionOf(path) {
  const match = String(path || '').match(AUDIO_EXT_RE);
  return match ? '.' + match[1].toLowerCase() : '';
}

/** Стабильное имя ссылки на трек в манифесте плейлиста; аудиофайл с этим именем не создаётся. */
export function trackFileName(track, used) {
  const ext = extensionOf(track.fileName) || extensionOf(track.nativePath) || '.mp3';
  const original = track.fileName && AUDIO_EXT_RE.test(track.fileName) ? stripAudioExtension(track.fileName) : '';
  const base = safeName(original || ((track.artist && !/неизвестн|unknown/i.test(track.artist) ? track.artist + ' - ' : '') + (track.name || 'Без названия')), 'Без названия', 100);
  return uniqueName(base, used, ext);
}

/** Состояние папки плейлиста: логические ссылки на исходные файлы и манифест для восстановления. */
export function buildFolderState(playlist, getTrack) {
  const used = new Set([MANIFEST_NAME.toLocaleLowerCase()]);
  const files = [];
  const entries = [];
  let skipped = 0;
  for (const id of playlist.trackIds || []) {
    const track = getTrack(id);
    if (!track) continue;
    const fileName = trackFileName(track, used);
    // Ref remains recoverable even for in-memory imports without a persistent native file path.
    entries.push({ file: fileName, ref: refFromTrack(track) });
    if (!track.nativePath) { skipped += 1; continue; }
    files.push({ path: track.nativePath, fileName });
  }
  const manifest = {
    app: 'crimson', kind: MANIFEST_KIND, schema: 2,
    id: playlist.id, name: playlist.name, createdAt: playlist.createdAt || 0,
    entries
  };
  return { name: playlist.name, folderName: playlistFolderName(playlist), files, manifest, skipped };
}

export function folderSignature(state) {
  // v2 switches playlist folders from per-playlist audio copies to reference-only manifests.
  // The version marker forces one migration sync for existing installations.
  return hash53(JSON.stringify([
    'reference-only-v2', state.folderName,
    state.files.map((f) => [f.fileName, f.path]),
    state.manifest.entries
  ]));
}

/**
 * Сравнивает плейлисты с тем, что уже записано в папки. Возвращает, что создать/обновить и что удалить.
 * @param synced  { [playlistId]: { folderName, sig } } — последнее синхронизированное состояние
 */
export function planFolderSync(synced, playlists, getTrack) {
  const upsert = [];
  const seen = new Set();
  const usedFolders = new Set();
  for (const playlist of playlists) {
    seen.add(playlist.id);
    const state = buildFolderState(playlist, getTrack);
    // ID уже делает имена уникальными даже при одинаковых названиях.
    state.folderName = uniqueName(state.folderName, usedFolders);
    const sig = folderSignature(state);
    const previous = synced[playlist.id];
    if (previous && previous.sig === sig && previous.folderName === state.folderName) continue;
    upsert.push({ id: playlist.id, previousName: previous ? previous.folderName : '', state, sig });
  }
  const remove = Object.keys(synced).filter((id) => !seen.has(id)).map((id) => ({ id, folderName: synced[id].folderName }));
  return { upsert, remove };
}

export function parseManifest(text) {
  let data;
  try { data = JSON.parse(String(text)); } catch (_) { return { ok: false, error: 'манифест повреждён' }; }
  if (!data || data.app !== 'crimson' || data.kind !== MANIFEST_KIND || !data.id || !Array.isArray(data.entries)) return { ok: false, error: 'не манифест плейлиста Crimson' };
  return { ok: true, manifest: data };
}

/**
 * Плейлисты из найденных папок. Уже существующие (по id) не затрагиваются.
 * Ссылки манифеста восстанавливаются и без аудиокопий. Новые файлы, вручную положенные в папку,
 * возвращаются в unresolved для импорта; additions содержит новые связи для уже существующих плейлистов.
 * @param folders [{ dirName, manifest: string, files: [{ name, sourceId, size, lastModified }] }]
 * @param fileTracks Map(sourceId или имени файла в нижнем регистре → id трека библиотеки)
 */
export function playlistsFromFolders(folders, tracks, existing = [], fileTracks = new Map()) {
  const existingById = new Map(existing.map((playlist) => [String(playlist.id), playlist]));
  const created = [];
  const unresolved = [];
  const additions = [];
  const synced = {};
  const lookup = buildTrackLookup(tracks);

  for (const folder of folders || []) {
    const parsed = parseManifest(folder.manifest);
    if (!parsed.ok) continue;
    const { manifest } = parsed;
    const present = new Map((folder.files || [])
      .filter((file) => file && file.name && extensionOf(file.name))
      .map((file) => [String(file.name).toLocaleLowerCase(), file]));
    const manifestEntries = manifest.entries.filter((entry) => entry && (entry.file || entry.ref));
    const represented = new Set(manifestEntries.map((entry) => String(entry.file || '').toLocaleLowerCase()).filter(Boolean));
    synced[manifest.id] = { folderName: folder.dirName, sig: '' };

    const refs = [];
    const candidates = [];
    for (const entry of manifestEntries) {
      const fileKey = String(entry.file || '').toLocaleLowerCase();
      const linkedFile = fileKey ? present.get(fileKey) : null;
      const originalRef = entry.ref && typeof entry.ref === 'object' ? entry.ref : {};
      const fileTrackId = (linkedFile && fileTracks.get(String(linkedFile.sourceId || ''))) || (fileKey ? fileTracks.get(fileKey) : '');
      const ref = {
        id: fileTrackId || originalRef.id || '',
        name: originalRef.name || '', artist: originalRef.artist || '',
        duration: Math.max(0, Math.round(Number(originalRef.duration) || 0)),
        ...(originalRef.sourceId ? { sourceId: originalRef.sourceId } : {}),
        ...(originalRef.youtubeId ? { youtubeId: originalRef.youtubeId } : {})
      };
      if (ref.id || ref.name || ref.sourceId || ref.youtubeId) refs.push(ref);
      // Existing manifests may still have audio copies. Only ingest one if it is present and
      // cannot be resolved against the canonical library yet.
      if (linkedFile) candidates.push({ file: linkedFile, ref });
    }

    // Audio put into a playlist directory manually is a new playlist item, not an orphan.
    for (const [key, file] of present) {
      if (represented.has(key)) continue;
      const identity = identityForFolderFile(file);
      const ref = {
        id: fileTracks.get(String(file.sourceId || '')) || fileTracks.get(key) || '', name: identity.name, artist: identity.artist,
        duration: Math.max(0, Math.round(Number(file.duration) || 0)),
        ...(file.sourceId ? { sourceId: String(file.sourceId) } : {})
      };
      refs.push(ref);
      candidates.push({ file, ref });
    }

    const knownPlaylist = existingById.get(String(manifest.id));
    if (knownPlaylist) {
      // Existing playlist contents/order remain authoritative. Only append genuinely new
      // files discovered in the physical folder; do not reset a user's in-app edits.
      const pendingIds = [];
      for (const candidate of candidates) {
        const resolved = resolveTrackRef(candidate.ref, lookup);
        if (resolved) {
          if (!(knownPlaylist.trackIds || []).some((id) => String(id) === String(resolved.id))) pendingIds.push(String(resolved.id));
        } else if (candidate.file && candidate.file.sourceId) {
          unresolved.push({ playlistId: manifest.id, file: candidate.file, ref: candidate.ref });
        }
      }
      if (pendingIds.length) additions.push({ playlistId: manifest.id, trackIds: [...new Set(pendingIds)] });
      continue;
    }

    const base = normalizePlaylist({
      id: manifest.id, name: manifest.name || folder.dirName, createdAt: manifest.createdAt,
      trackIds: [], refs
    });
    if (!base) continue;
    const { playlists: [resolved] } = reconcilePlaylists([base], tracks);
    created.push(resolved);

    for (const candidate of candidates) {
      if (!resolveTrackRef(candidate.ref, lookup) && candidate.file && candidate.file.sourceId) {
        unresolved.push({ playlistId: manifest.id, file: candidate.file, ref: candidate.ref });
      }
    }
  }
  return { playlists: created, unresolved, synced, additions };
}

/** Имя и исполнитель для файла, найденного в папке плейлиста (когда его нет в библиотеке). */
export function identityForFolderFile(file) {
  const parsed = libraryNameFromFilename(file.name);
  return { name: parsed.name, artist: parsed.artist || 'Неизвестный исполнитель' };
}
