/**
 * Повторное определение исполнителя и названия у уже сохранённых треков.
 *
 * Меняются только поля name/artist в записи библиотеки. Идентификаторы треков, аудиофайлы и плейлисты
 * не затрагиваются. Перед применением приложение делает резервную копию, а старые значения
 * сохраняются в журнале отката.
 */
import { libraryNameFromFilename, stripAudioExtension, artistKey } from './track-identity.mjs';

const AUDIO_NAME_RE = /\.(?:mp3|m4a|aac|ogg|opus|wav|flac|webm|oga|mp4|wma|aiff?|alac)$/i;
const UNKNOWN_RE = /^(?:неизвестный исполнитель|unknown artist|<unknown>)$/i;

function safeDecode(value) {
  try { return decodeURIComponent(value); } catch (_) { return String(value); }
}

/**
 * Оригинальное имя файла трека из папки. Источник правды — имя документа в адресе (sourceId) или fileName:
 * кеш приложения заменяет не-латинские символы, поэтому по нему имя восстановить нельзя.
 */
export function originalFileName(track) {
  if (!track) return '';
  if (track.fileName && AUDIO_NAME_RE.test(track.fileName)) return String(track.fileName);
  const source = String(track.sourceId || '');
  if (source.startsWith('content://') || source.includes('%')) {
    const decoded = safeDecode(source);
    const name = decoded.split(/[\\/:]/).pop() || '';
    if (AUDIO_NAME_RE.test(name)) return name;
  }
  return '';
}

const same = (a, b) => String(a || '').trim().toLocaleLowerCase() === String(b || '').trim().toLocaleLowerCase();
const normArtist = (value) => (UNKNOWN_RE.test(String(value || '').trim()) ? '' : String(value || '').trim());

/** Предложение исправления для одного трека или null, если менять нечего. */
export function proposeRepair(track) {
  if (!track || !String(track.id || '').startsWith('folder:')) return null;
  const file = originalFileName(track);
  if (!file) return null;
  const parsed = libraryNameFromFilename(file);
  const next = { artist: parsed.artist || '', name: parsed.name || '' };
  if (!next.name || !/[\p{L}\p{N}]/u.test(next.name)) return null;
  const current = { artist: normArtist(track.artist), name: String(track.name || '').trim() };
  if (same(current.name, next.name) && artistKey(current.artist) === artistKey(next.artist)) return null;
  const truncated = current.name.length > 0 && next.name.length > current.name.length
    && next.name.toLocaleLowerCase().startsWith(current.name.toLocaleLowerCase());
  const lostArtist = !current.artist && Boolean(next.artist);
  return {
    id: track.id,
    file: stripAudioExtension(file),
    from: { artist: String(track.artist || ''), name: current.name },
    to: { artist: next.artist || 'Неизвестный исполнитель', name: next.name },
    kind: truncated ? 'truncated' : (lostArtist ? 'missing-artist' : 'changed')
  };
}

export function planRepairs(tracks) {
  const proposals = [];
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const proposal = proposeRepair(track);
    if (proposal) proposals.push(proposal);
  }
  return proposals;
}

/** Применяет предложения. Возвращает новые объекты треков и журнал отката со старыми значениями. */
export function applyRepairs(tracks, proposals) {
  const byId = new Map(proposals.map((proposal) => [proposal.id, proposal]));
  const undo = [];
  const next = tracks.map((track) => {
    const proposal = byId.get(track.id);
    if (!proposal) return track;
    undo.push({ id: track.id, artist: track.artist || '', name: track.name || '' });
    return { ...track, artist: proposal.to.artist, name: proposal.to.name };
  });
  return { tracks: next, undo };
}

export function undoRepairs(tracks, undo) {
  const byId = new Map((undo || []).map((entry) => [entry.id, entry]));
  return tracks.map((track) => {
    const entry = byId.get(track.id);
    return entry ? { ...track, artist: entry.artist, name: entry.name } : track;
  });
}

/** Краткое описание для окна подтверждения. */
export function describeRepairs(proposals, limit = 6) {
  const lines = proposals.slice(0, limit).map((p) => `• ${p.from.artist ? p.from.artist + ' — ' : ''}${p.from.name}  →  ${p.to.artist} — ${p.to.name}`);
  if (proposals.length > limit) lines.push(`… и ещё ${proposals.length - limit}`);
  return lines.join('\n');
}
