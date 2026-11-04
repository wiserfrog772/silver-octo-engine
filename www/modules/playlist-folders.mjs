/**
 * Плейлисты как папки: «Crimson Playlists/<Название>/» с музыкой и манифестом crimson-playlist.json.
 * Папка лежит в выбранной пользователем папке, поэтому переживает переустановку: после выбора той же папки
 * плейлисты восстанавливаются вместе с порядком треков.
 */
import { hash53, refFromTrack, reconcilePlaylists, normalizePlaylist } from './backup.mjs';
import { libraryNameFromFilename, stripAudioExtension } from './track-identity.mjs';

export const PLAYLISTS_DIR = 'Crimson Playlists';
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

/** Имя файла внутри папки плейлиста: «Исполнитель - Название.ext», уникальное в пределах папки. */
export function trackFileName(track, used) {
  const ext = extensionOf(track.fileName) || extensionOf(track.nativePath) || '.mp3';
  const original = track.fileName && AUDIO_EXT_RE.test(track.fileName) ? stripAudioExtension(track.fileName) : '';
  const base = safeName(original || ((track.artist && !/неизвестн|unknown/i.test(track.artist) ? track.artist + ' - ' : '') + (track.name || 'Без названия')), 'Без названия', 100);
  return uniqueName(base, used, ext);
}

/** Состояние папки плейлиста: какие файлы должны лежать в ней и что записать в манифест. */
export function buildFolderState(playlist, getTrack) {
  const used = new Set([MANIFEST_NAME.toLocaleLowerCase()]);
  const files = [];
  const entries = [];
  let skipped = 0;
  for (const id of playlist.trackIds || []) {
    const track = getTrack(id);
    if (!track) continue;
    if (!track.nativePath) { skipped += 1; continue; }   // трек без локального файла (например, импорт из памяти браузера) копировать нечем
    const fileName = trackFileName(track, used);
    files.push({ path: track.nativePath, fileName });
    entries.push({ file: fileName, ref: refFromTrack(track) });
  }
  const manifest = {
    app: 'crimson', kind: MANIFEST_KIND, schema: 1,
    id: playlist.id, name: playlist.name, createdAt: playlist.createdAt || 0,
    entries
  };
  return { name: playlist.name, folderName: safeName(playlist.name, 'Плейлист'), files, manifest, skipped };
}

export function folderSignature(state) {
  return hash53(JSON.stringify([state.folderName, state.files.map((f) => [f.fileName, f.path])]));
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
    // одинаковые названия плейлистов получают разные папки
    const base = state.folderName;
    state.folderName = uniqueName(base, usedFolders);
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
 * Файлы, которых нет в библиотеке, возвращаются в unresolved — приложение добавит их в библиотеку из самой папки.
 * @param folders [{ dirName, manifest: string, files: [{ name, sourceId, size, lastModified }] }]
 * @param fileTracks Map(имя файла в нижнем регистре → id трека библиотеки)
 */
export function playlistsFromFolders(folders, tracks, existing = [], fileTracks = new Map()) {
  const known = new Set(existing.map((p) => p.id));
  const created = [];
  const unresolved = [];
  const synced = {};
  for (const folder of folders || []) {
    const parsed = parseManifest(folder.manifest);
    if (!parsed.ok) continue;
    const { manifest } = parsed;
    const present = new Map((folder.files || []).map((f) => [String(f.name).toLocaleLowerCase(), f]));
    synced[manifest.id] = { folderName: folder.dirName, sig: '' };
    if (known.has(manifest.id)) continue;
    const entries = manifest.entries.filter((e) => e && e.file && present.has(String(e.file).toLocaleLowerCase()));
    const base = normalizePlaylist({
      id: manifest.id, name: manifest.name, createdAt: manifest.createdAt,
      // fileTracks: имя файла → id трека, добавленного в библиотеку прямо из этой папки (приоритетнее сопоставления по названию)
      trackIds: [], refs: entries.map((e) => ({ ...e.ref, id: fileTracks.get(String(e.file).toLocaleLowerCase()) || '' }))
    });
    if (!base) continue;
    // Сопоставляем ссылки с библиотекой; порядок задаёт манифест.
    const { playlists: [resolved] } = reconcilePlaylists([base], tracks);
    created.push(resolved);
    const resolvedKeys = new Set();
    resolved.trackIds.forEach((id) => resolvedKeys.add(id));
    entries.forEach((entry, index) => {
      const ref = base.refs[index];
      const stillPending = (resolved.refs || []).some((r) => r.name === ref.name && r.artist === ref.artist && !tracks.some((t) => String(t.id) === String(r.id)));
      if (stillPending || !resolved.trackIds.length) unresolved.push({ playlistId: manifest.id, file: present.get(String(entry.file).toLocaleLowerCase()), ref: entry.ref });
    });
  }
  return { playlists: created, unresolved, synced };
}

/** Имя и исполнитель для файла, найденного в папке плейлиста (когда его нет в библиотеке). */
export function identityForFolderFile(file) {
  const parsed = libraryNameFromFilename(file.name);
  return { name: parsed.name, artist: parsed.artist || 'Неизвестный исполнитель' };
}
