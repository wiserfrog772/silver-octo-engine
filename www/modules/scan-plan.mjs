/**
 * Планирование инкрементального сканирования папки с музыкой.
 * Чистая логика: нативный слой отдаёт найденные файлы пачками, а здесь решается, что добавить,
 * что обновить, что удалить и что пропустить как дубликат. Тяжёлые операции в UI не выполняются.
 */
import { artistKey, stripAudioExtension } from './track-identity.mjs';

const FOLDER_PREFIX = 'folder:';
const YT_ID_RE = /[[(]([A-Za-z0-9_-]{11})[)\]]\s*$/;

export const isFolderTrack = (track) => Boolean(track && String(track.id || '').startsWith(FOLDER_PREFIX));

export function youtubeIdFromFilename(name) {
  const base = String(name || '').replace(/\.[^.]+$/, '').trim();
  const match = base.match(YT_ID_RE);
  return match ? match[1] : '';
}

/** Отпечаток файла для поиска одного и того же трека под разными адресами (копия в другой папке). */
export function fileFingerprint(row) {
  const size = Number(row.size) || 0;
  if (size <= 0) return '';
  const name = stripAudioExtension(String(row.name || '')).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return `${name}|${size}`;
}

/** Что сообщить нативному слою, чтобы он не перечитывал неизменённые файлы. */
export function buildKnownSources(tracks) {
  const known = {};
  for (const track of tracks || []) {
    if (!isFolderTrack(track) || !track.sourceId) continue;
    known[String(track.sourceId)] = { size: Number(track.size) || 0, lastModified: Number(track.lastModified) || 0, hasDuration: Number(track.duration) > 0 };
  }
  return known;
}

export function isRowUnchanged(track, row) {
  if (!track || !row) return false;
  if (row.unchanged === true) return true;
  return Number(track.size) === Number(row.size) && Number(track.lastModified || 0) === Number(row.lastModified || 0) && Number(row.size) > 0;
}

/**
 * Сопоставляет найденные файлы с библиотекой.
 * @returns {{add, update, unchanged, duplicates, remove, seen}}
 */
export function planLibrarySync(existingTracks, rows, { complete = true } = {}) {
  const tracks = Array.isArray(existingTracks) ? existingTracks : [];
  const folderBySource = new Map();
  for (const track of tracks) if (isFolderTrack(track) && track.sourceId) folderBySource.set(String(track.sourceId), track);
  const downloadedByYoutube = new Map();
  for (const track of tracks) {
    if (isFolderTrack(track)) continue;
    const id = String(track.youtubeId || '') || (/^[A-Za-z0-9_-]{11}$/.test(String(track.sourceId || '')) ? String(track.sourceId) : '');
    if (id) downloadedByYoutube.set(id, track);
  }
  const fingerprints = new Map();
  for (const track of tracks) {
    const fp = fileFingerprint({ name: track.fileName || track.name, size: track.size });
    if (fp && !fingerprints.has(fp)) fingerprints.set(fp, track);
  }

  const plan = { add: [], update: [], unchanged: [], duplicates: [], remove: [], seen: new Set() };
  const batchSources = new Set();
  const batchPrints = new Set();
  for (const row of rows || []) {
    if (!row || !row.sourceId) continue;
    const sourceId = String(row.sourceId);
    plan.seen.add(sourceId);
    if (batchSources.has(sourceId)) { plan.duplicates.push({ row, reason: 'same-source' }); continue; }
    batchSources.add(sourceId);
    const existing = folderBySource.get(sourceId);
    if (existing) {
      if (isRowUnchanged(existing, row)) plan.unchanged.push(existing);
      else plan.update.push({ track: existing, row });
      continue;
    }
    // Файл, скачанный самим Crimson и лежащий в выбранной папке, повторно не добавляем.
    const ytId = youtubeIdFromFilename(row.name);
    if (ytId && downloadedByYoutube.has(ytId)) { plan.duplicates.push({ row, reason: 'downloaded', trackId: downloadedByYoutube.get(ytId).id }); continue; }
    const fp = fileFingerprint(row);
    if (fp && (batchPrints.has(fp) || fingerprints.has(fp))) {
      plan.duplicates.push({ row, reason: 'same-file', trackId: fingerprints.has(fp) ? fingerprints.get(fp).id : undefined });
      continue;
    }
    if (fp) batchPrints.add(fp);
    plan.add.push(row);
  }
  // Удаляем из библиотеки только после полного обхода: отменённое сканирование ничего не стирает.
  if (complete) for (const [sourceId, track] of folderBySource) if (!plan.seen.has(sourceId)) plan.remove.push(track);
  return plan;
}

/** Состояние индикатора выполнения. События приходят из нативного слоя. */
export function createScanState() {
  return { phase: 'idle', total: 0, processed: 0, added: 0, updated: 0, unchanged: 0, skipped: 0, corrupted: 0, duplicates: 0, message: '', percent: 0, currentName: '' };
}

export function reduceScanEvent(state, event) {
  const next = { ...state };
  const e = event || {};
  switch (e.type) {
    case 'start':
      return { ...createScanState(), phase: 'counting', message: 'Ищу аудиофайлы…' };
    case 'counted':
      next.phase = 'scanning'; next.total = Math.max(0, Number(e.total) || 0);
      next.message = next.total ? `Найдено файлов: ${next.total}` : 'Аудиофайлы не найдены';
      break;
    case 'progress':
      next.phase = 'scanning';
      next.processed = Math.max(next.processed, Number(e.processed) || 0);
      next.corrupted = Math.max(next.corrupted, Number(e.corrupted) || 0);
      next.currentName = String(e.currentName || next.currentName || '');
      next.message = 'Обрабатываю файлы…';
      break;
    case 'plan':
      next.added += e.added || 0; next.updated += e.updated || 0; next.unchanged += e.unchanged || 0; next.duplicates += e.duplicates || 0;
      break;
    case 'done':
      next.phase = 'done'; next.processed = Math.max(next.processed, next.total);
      next.message = 'Сканирование завершено'; break;
    case 'cancelled':
      next.phase = 'cancelled'; next.message = 'Сканирование отменено. Уже найденные треки сохранены.'; break;
    case 'error':
      next.phase = 'error'; next.message = String(e.message || 'Не удалось просканировать папку'); break;
    default: return state;
  }
  next.skipped = next.corrupted + next.duplicates;
  next.percent = next.total > 0 ? Math.min(100, Math.round((next.processed / next.total) * 100)) : (next.phase === 'done' ? 100 : 0);
  return next;
}

export const isScanActive = (state) => state.phase === 'counting' || state.phase === 'scanning';

/** Сводка по окончании. */
export function scanSummary(state) {
  const parts = [`добавлено ${state.added}`];
  if (state.updated) parts.push(`обновлено ${state.updated}`);
  if (state.unchanged) parts.push(`без изменений ${state.unchanged}`);
  if (state.duplicates) parts.push(`дубликатов пропущено ${state.duplicates}`);
  if (state.corrupted) parts.push(`повреждённых ${state.corrupted}`);
  return parts.join(', ');
}

/** Исполнитель в имени папки/файла сравнивается без учёта регистра (для будущих проверок). */
export const sameArtist = (a, b) => artistKey(a) === artistKey(b) && artistKey(a) !== '';
