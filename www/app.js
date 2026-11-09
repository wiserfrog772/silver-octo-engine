import { createLibraryStore, migratePreferenceKeys } from './modules/storage.mjs';
import { cleanTrackTitle, cleanArtistName } from './modules/music-metadata.mjs';
import { uniqueExistingTrackIds, sortLibraryTracks, playbackIdsForView as resolvePlaybackIds, filterPlaylistCards, filterPlaylistTracks } from './modules/player.mjs';
import { escapeHtml, formatTimeLabel, pluralTrackCount } from './modules/ui.mjs';
import { normalizeYoutubeResults, friendlyYoutubeError, validateNetscapeCookies } from './modules/youtube.mjs';
import { movePlaylistTrack, movePlaylistTrackToPosition } from './modules/playlist-order.mjs';
import { classifyTrackSwipe, resolveSwipePlaylist, seekProgressPercent, swipeVisual } from './modules/track-interactions.mjs';
import { buildTrackMetadata, libraryNameFromFilename, stripAudioExtension } from './modules/track-identity.mjs';
import { createLibraryMatcher, matchBadge, MATCH_LEVEL } from './modules/library-match.mjs';
import { createSnapshot, encodeBackup, decodeBackup, pickNewestValidBackup, exportPlaylists, importPlaylists, checkPlaylistIntegrity, reconcilePlaylists, updatePlaylistRefs, normalizePlaylist, writeGuarded, readGuarded } from './modules/backup.mjs';
import { createDownloadQueue, clampConcurrency, DEFAULT_CONCURRENCY } from './modules/download-queue.mjs';
import { mergeProgress, progressView, createThrottle, ACTIVE_PHASES } from './modules/download-progress.mjs';
import { planFolderSync, playlistsFromFolders } from './modules/playlist-folders.mjs';
import { planRepairs, applyRepairs, undoRepairs, describeRepairs } from './modules/metadata-repair.mjs';
import { planLibrarySync, buildKnownSources, createScanState, reduceScanEvent, isScanActive, scanSummary, isFolderTrack } from './modules/scan-plan.mjs';

(() => {
  'use strict';

  // Technical identifier kept from the previous product name on purpose:
  // IndexedDB cannot be renamed in place, and changing it would hide every track
  // that existing installations have already imported.
  const DB_NAME = 'localify-crimson-mobile';
  const DB_VERSION = 2; // v2: индексы sourceId / youtubeId / addedAt (миграция без потери данных)
  const STORE = 'tracks';
  const STORAGE_KEYS = {
    queue: 'crimson.mobile.queue',
    downloadConcurrency: 'crimson.mobile.download-concurrency',
    playlistFolders: 'crimson.mobile.playlist-folders',
    playlists: 'crimson.mobile.playlists',
    playbackPlaylist: 'crimson.mobile.playback-playlist',
    quickAddPlaylist: 'crimson.mobile.quick-add-playlist',
    sort: 'crimson.mobile.sort'
  };
  const LEGACY_STORAGE_KEYS = {
    queue: 'localify.mobile.queue',
    playlists: 'localify.mobile.playlists'
  };
  const SORT_MODES = ['recent', 'title', 'artist'];
  const LITE_MOTION_KEY = 'crimson.mobile.lite-motion';
  const libraryStore = createLibraryStore({ databaseName: DB_NAME, version: DB_VERSION, storeName: STORE });
  const SWIPE_HINT = '<div class="track-swipe-hint" aria-hidden="true"><span class="swipe-icon"><svg viewBox="0 0 24 24" class="swipe-icon-add"><path d="M4 6h12M4 12h8M4 18h6M18 12v8m-4-4h8"/></svg><svg viewBox="0 0 24 24" class="swipe-icon-done"><path d="M5 13l4 4L19 7"/></svg></span><small>Добавить в плейлист</small></div>';
  const libraryMatcher = createLibraryMatcher();
  const collator = new Intl.Collator(['ru', 'en'], { numeric: true, sensitivity: 'base' });

  migratePreferenceKeys(localStorage, STORAGE_KEYS, LEGACY_STORAGE_KEYS);

  function readSortMode() {
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.sort);
      return SORT_MODES.includes(stored) ? stored : 'recent';
    } catch (_) { return 'recent'; }
  }
  const $ = (selector) => document.querySelector(selector);
  const state = {
    db: null,
    libraryLoaded: false,
    pendingNativeSnapshot: null,
    applyingNativeSnapshot: false,
    tracks: [],
    view: 'library',
    query: '',
    ytQuery: '', ytResults: [], ytLoading: false, ytStatus: 'Подготовка yt-dlp…', ytStatusError: false, ytDownloads: {}, currentRemoteTrack: null,
    ytSearchCache: new Map(), ytSearchRequestId: 0,
    currentId: null,
    queue: [],
    playbackOrder: [],
    playlists: [],
    currentPlaylistId: null,
    playbackPlaylistId: null,
    playlistQuery: '',
    editingPlaylistId: null,
    pendingPlaylistTrackId: null,
    pendingImportPlaylistId: null,
    quickAddPlaylistId: (() => { try { return localStorage.getItem('crimson.mobile.quick-add-playlist') || null; } catch (_) { return null; } })(),
    shuffle: false,
    repeat: false,
    isPlaying: false,
    toastTimer: null,
    seekDragging: false,
    pendingSeekTime: null,
    downloadListenerAttached: false, downloadListenerPromise: null,
    libraryRefreshing: false,
    libraryRefreshRequested: false,
    libraryRefreshRequestedSilent: true,
    lastFolderScanAt: 0,
    scan: createScanState(), scanSeen: null, scanListenerAttached: false, scanListenerPromise: null, scanAdded: 0,
    allowEmptyBackup: false, renderLimit: 150, libraryDirty: true, backupTimer: null, lastBackupAt: 0, backupStatus: '',
    lastMediaMetadataKey: '',
    lastMediaPlaybackState: '',
    nativePlaybackLastKey: '',
    nativeQueueLastKey: '',
    nativeQueueOrder: null,
    nativeQueueSyncPromise: null,
    nativeQueueSyncRequested: false,
    nativePlaybackListenerAttached: false,
    nativePosition: 0,
    nativeDuration: 0,
    nativePositionUpdatedAt: 0,
    nativeProgressTimer: null,
    resumeOnVisible: false,
    intentionalPausePending: false,
    playerCoverKey: '',
    searchRenderTimer: null,
    sortMode: readSortMode(), pendingQueueRefs: null
  };
  const audio = $('#audio');
  const filePicker = $('#filePicker');

  function recordWebDiagnostic(kind, message, stack, source) {
    const plugin = window.CrimsonPlayback;
    if (!plugin || typeof plugin.reportWebError !== 'function') return;
    try {
      const result = plugin.reportWebError({
        message: String(message || kind || 'Unknown WebView error'),
        stack: String(stack || ''),
        source: String(source || '')
      });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (_) {}
  }

  window.addEventListener('error', (event) => {
    if (!event || event.error || event.message) {
      recordWebDiagnostic(
        'WINDOW_ERROR',
        event && event.message || 'Unhandled window error',
        event && event.error && event.error.stack || '',
        event && event.filename ? event.filename + ':' + event.lineno + ':' + event.colno : ''
      );
    }
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event && event.reason;
    recordWebDiagnostic(
      'UNHANDLED_REJECTION',
      reason && reason.message ? reason.message : String(reason || 'Unhandled promise rejection'),
      reason && reason.stack ? reason.stack : '',
      'unhandledrejection'
    );
  });

  function makeId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
    return 'track-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
  }

  function openDatabase() { return libraryStore.open(); }
  function getAllRecords() { return libraryStore.getAll(state.db); }
  function putRecord(record) { return putRecords([record]); }
  function putRecords(records) { return libraryStore.putMany(state.db, records); }
  function removeRecord(id) { return removeRecords([id]); }
  function removeRecords(ids) { return libraryStore.removeMany(state.db, ids); }

  function storedShape(track) {
    return {
      id: track.id, name: track.name, artist: track.artist, blob: track.blob || null,
      fileName: track.fileName || '', lastModified: Number(track.lastModified) || 0, nativePath: track.nativePath || '', sourceId: track.sourceId || '', addedAt: track.addedAt,
      duration: Number(track.duration) || 0, size: Number(track.size) || 0,
      album: track.album || '', year: track.year || '', genre: track.genre || '',
      importKey: track.importKey || '', youtubeId: track.youtubeId || '', coverBlob: track.coverBlob || null,
      coverUrl: track.coverUrl || '', coverPath: track.coverPath || '',
      coverChecked: track.coverChecked === true,
      durationChecked: track.durationChecked === true
    };
  }

  function convertNativePath(path) {
    try { if (window.Capacitor && typeof window.Capacitor.convertFileSrc === 'function') return window.Capacitor.convertFileSrc(path); } catch (_) {}
    return path || '';
  }

  function validCoverUrl(value) {
    const url = String(value || '');
    return /^https:\/\//i.test(url) || /^data:image\/(?:png|jpe?g|webp);base64,/i.test(url);
  }

  function coverForTrack(track) {
    if (!track) return '';
    if (track.coverDisplayUrl) return track.coverDisplayUrl;
    if (validCoverUrl(track.coverUrl)) return track.coverUrl;
    return track.coverPath ? convertNativePath(track.coverPath) : '';
  }

  function attachUrl(record) {
    const url = record.blob instanceof Blob ? URL.createObjectURL(record.blob) : convertNativePath(record.nativePath);
    const coverDisplayUrl = record.coverBlob instanceof Blob
      ? URL.createObjectURL(record.coverBlob)
      : (validCoverUrl(record.coverUrl) ? record.coverUrl : convertNativePath(record.coverPath));
    return { ...record, url, coverDisplayUrl };
  }

  function releaseTrackUrls(track) {
    if (!track) return;
    if (track.blob instanceof Blob && track.url && track.url.startsWith('blob:')) URL.revokeObjectURL(track.url);
    if (track.coverBlob instanceof Blob && track.coverDisplayUrl && track.coverDisplayUrl.startsWith('blob:')) URL.revokeObjectURL(track.coverDisplayUrl);
  }

  function scheduleIdleWork(callback, timeoutMs = 1500, fallbackDelayMs = 700) {
    const schedule = () => {
      if (document.hidden) {
        const onVisible = () => {
          if (document.hidden) return;
          document.removeEventListener('visibilitychange', onVisible);
          schedule();
        };
        document.addEventListener('visibilitychange', onVisible);
        return;
      }
      const run = () => {
        if (document.hidden) {
          schedule();
          return;
        }
        callback();
      };
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(run, { timeout: timeoutMs });
      } else {
        setTimeout(run, fallbackDelayMs);
      }
    };
    schedule();
  }

  function nativeAudioExtension(track) {
    const fileName = String(track && track.fileName || '');
    const match = fileName.match(/\.([A-Za-z0-9]{2,8})$/);
    if (match) return match[1].toLowerCase();
    const mime = String(track && track.blob && track.blob.type || '').toLowerCase();
    const byMime = {
      'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a',
      'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/opus': 'opus',
      'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/flac': 'flac',
      'audio/webm': 'webm', 'audio/3gpp': '3gp'
    };
    return byMime[mime] || 'audio';
  }

  function bytesToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x6000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, Math.min(offset + 0x6000, bytes.length)));
    }
    return btoa(binary);
  }

  async function writeBlobToNative(id, name, blob) {
    const plugin = window.CrimsonPlayback;
    if (!(blob instanceof Blob) || !blob.size || !plugin ||
        typeof plugin.beginTrackTransfer !== 'function' ||
        typeof plugin.appendTrackTransferChunk !== 'function' ||
        typeof plugin.finishTrackTransfer !== 'function') return '';
    id = String(id || '');
    if (!id) return '';
    await plugin.beginTrackTransfer({ id, name: String(name || 'audio.bin') });
    try {
      const chunkSize = 512 * 1024;
      for (let offset = 0; offset < blob.size; offset += chunkSize) {
        const chunk = await blob.slice(offset, Math.min(offset + chunkSize, blob.size)).arrayBuffer();
        await plugin.appendTrackTransferChunk({ id, data: bytesToBase64(chunk) });
      }
      const result = await plugin.finishTrackTransfer({ id });
      return String(result && result.path || '');
    } catch (error) {
      try { await plugin.cancelTrackTransfer({ id }); } catch (_) {}
      throw error;
    }
  }

  async function writeTrackBlobToNative(track) {
    if (!track) return '';
    return writeBlobToNative(
      String(track.id || ''),
      String(track.fileName || (String(track.name || 'track') + '.' + nativeAudioExtension(track))),
      track.blob
    );
  }

  async function ensureNativeTrack(track) {
    if (!track || track.nativePath || !(track.blob instanceof Blob)) return track;
    const nativePath = await writeTrackBlobToNative(track);
    if (!nativePath) return track;
    const updatedRecord = storedShape({ ...track, nativePath, blob: null });
    await putRecord(updatedRecord);
    releaseTrackUrls(track);
    const attached = attachUrl(updatedRecord);
    state.tracks = state.tracks.map((item) => item.id === attached.id ? attached : item);
    if (state.currentId === attached.id) state.playerCoverKey = '';
    return attached;
  }

  async function ensureNativeArtwork(track) {
    if (!track || track.coverPath || /^https:\/\//i.test(String(track.coverUrl || '')) ||
        !(track.coverBlob instanceof Blob)) return track;
    const id = 'cover-' + String(track.id || '').replace(/[^A-Za-z0-9._-]/g, '_');
    const extension = String(track.coverBlob.type || '').toLowerCase().includes('png') ? 'png'
      : (String(track.coverBlob.type || '').toLowerCase().includes('webp') ? 'webp' : 'jpg');
    const coverPath = await writeBlobToNative(id, 'cover.' + extension, track.coverBlob);
    if (!coverPath) return track;
    const updatedRecord = storedShape({ ...track, coverPath, coverBlob: null });
    await putRecord(updatedRecord);
    releaseTrackUrls(track);
    const attached = attachUrl(updatedRecord);
    state.tracks = state.tracks.map((item) => item.id === attached.id ? attached : item);
    if (state.currentId === attached.id) state.playerCoverKey = '';
    return attached;
  }

  function fileUriForNativePath(path) {
    const value = String(path || '');
    return 'file://' + value.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  }

  function normalizedPart(value) {
    return String(value || '').normalize('NFKC').trim().toLocaleLowerCase().replace(/\s+/g, ' ');
  }

  function extractYouTubeIdFromTitle(value) {
    const title = stripAudioExtension(String(value || '').trim());
    const match = title.match(/(?:\[([A-Za-z0-9_-]{11})\]|\(([A-Za-z0-9_-]{11})\))\s*$/);
    return match ? (match[1] || match[2] || '') : '';
  }

  function recordDedupKeys(record) {
    const keys = [];
    const sourceId = String(record.sourceId || '');
    if (sourceId) keys.push('source:' + sourceId);
    const youtubeId = String(record.youtubeId || '') ||
      (/^[A-Za-z0-9_-]{11}$/.test(sourceId) ? sourceId : extractYouTubeIdFromTitle(record.name));
    if (youtubeId) keys.push('youtube:' + youtubeId);
    if (record.importKey) keys.push('import:' + String(record.importKey));
    const size = Number(record.size) || 0;
    if (size > 0) {
      // Also compare metadata across source types: a downloaded YouTube track and
      // the same file later found in the selected Android folder have different IDs.
      keys.push('meta:' + normalizedPart(record.name) + '|' + normalizedPart(record.artist) + '|' + size);
      if (normalizedPart(record.artist) === normalizedPart('Неизвестный исполнитель')) {
        keys.push('legacy:' + normalizedPart(record.name) + '|' + size);
      }
    }
    return keys;
  }

  function deduplicateStoredRecords(records) {
    const sorted = records.slice().sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    const seen = new Map(), unique = [], duplicateIds = [], changedIds = new Set();
    for (const record of sorted) {
      const keys = recordDedupKeys(record);
      const existing = keys.map((key) => seen.get(key)).find(Boolean);
      if (!existing) {
        unique.push(record);
        keys.forEach((key) => seen.set(key, record));
        continue;
      }
      duplicateIds.push(record.id);
      for (const field of ['blob', 'coverBlob', 'coverUrl', 'coverPath', 'nativePath', 'sourceId', 'importKey', 'coverChecked']) {
        if (!existing[field] && record[field]) {
          existing[field] = record[field];
          changedIds.add(existing.id);
        }
      }
      if (!(Number(existing.duration) > 0) && Number(record.duration) > 0) {
        existing.duration = Number(record.duration);
        changedIds.add(existing.id);
      }
      keys.forEach((key) => seen.set(key, existing));
    }
    return {
      records: unique,
      duplicateIds,
      changedRecords: unique.filter((record) => changedIds.has(record.id))
    };
  }

  const esc = escapeHtml;
  const formatTime = formatTimeLabel;
  const pluralTracks = pluralTrackCount;

  function showToast(message, actionLabel = '', actionHandler = null) {
    const toast = $('#toast');
    toast.replaceChildren();
    const text = document.createElement('span');
    text.textContent = String(message || '');
    toast.append(text);
    if (actionLabel && typeof actionHandler === 'function') {
      const action = document.createElement('button');
      action.type = 'button';
      action.className = 'toast-action';
      action.textContent = String(actionLabel);
      action.setAttribute('aria-label', String(actionLabel));
      action.addEventListener('click', () => {
        toast.classList.remove('visible');
        actionHandler();
      }, { once: true });
      toast.append(action);
    }
    toast.classList.add('visible');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.remove('visible'), 3600);
  }

  // Индекс по id: раньше каждый вызов был линейным поиском, а плейлисты и очередь вызывают его для каждого трека.
  const trackIndex = { source: null, length: -1, map: new Map() };
  function trackById(id) {
    if (trackIndex.source !== state.tracks || trackIndex.length !== state.tracks.length) {
      trackIndex.source = state.tracks; trackIndex.length = state.tracks.length;
      trackIndex.map = new Map(state.tracks.map((track) => [track.id, track]));
    }
    return trackIndex.map.get(id) || null;
  }

  function cleanYouTubeTitle(title, videoId) {
    return cleanTrackTitle(title, videoId) || 'YouTube';
  }

  function currentTrack() {
    return trackById(state.currentId) || state.currentRemoteTrack || null;
  }

  function playlistById(id) {
    return state.playlists.find((playlist) => playlist.id === id) || null;
  }

  function uniqueTrackIds(ids) {
    return uniqueExistingTrackIds(ids, (id) => !!trackById(id));
  }

  function setPlaybackPlaylist(playlistId) {
    state.playbackPlaylistId = playlistId && playlistById(playlistId) ? playlistId : null;
    try { localStorage.setItem(STORAGE_KEYS.playbackPlaylist, state.playbackPlaylistId || ''); } catch (_) {}
  }

  function savePlaylists() {
    try {
      state.playlists.forEach((playlist) => { playlist.refs = updatePlaylistRefs(playlist, trackById); });
      // Запись с контрольной суммой и предыдущей исправной копией: обрыв записи не повредит плейлисты.
      writeGuarded(localStorage, STORAGE_KEYS.playlists, state.playlists.map((playlist) => ({
        id: playlist.id, name: playlist.name, trackIds: playlist.trackIds, refs: playlist.refs, createdAt: playlist.createdAt || Date.now()
      })));
    } catch (_) { showToast('Не удалось сохранить плейлисты на устройстве.'); }
    if (state.playlists.length) state.allowEmptyBackup = true;
    scheduleBackup();
    scheduleFolderSync();
  }

  function saveQuickAddPlaylist(playlistId) {
    state.quickAddPlaylistId = playlistId && playlistById(playlistId) ? playlistId : null;
    try {
      if (state.quickAddPlaylistId) localStorage.setItem(STORAGE_KEYS.quickAddPlaylist, state.quickAddPlaylistId);
      else localStorage.removeItem(STORAGE_KEYS.quickAddPlaylist);
    } catch (_) {}
    scheduleBackup();
  }

  function libraryTracks() {
    return sortLibraryTracks(state.tracks, state.sortMode, collator);
  }

  function libraryOrderIds() {
    return libraryTracks().map((track) => track.id);
  }

  function playbackIdsForView() {
    return resolvePlaybackIds({
      view: state.view,
      playlist: playlistById(state.currentPlaylistId),
      playbackOrder: state.playbackOrder,
      libraryOrder: libraryOrderIds(),
      uniqueIds: uniqueTrackIds
    });
  }

  function viewTracks() {
    let tracks = libraryTracks();
    if (state.view === 'queue') {
      const current = currentTrack();
      const currentId = current && current.id;
      const ordered = uniqueTrackIds(state.playbackOrder);
      const currentIndex = ordered.indexOf(currentId);
      const upcomingFromOrder = currentIndex >= 0 ? ordered.slice(currentIndex + 1) : ordered.filter((id) => id !== currentId);
      // Show the current track, explicitly queued tracks, and the rest of the active
      // playback order instead of making the queue look empty after the current item starts.
      const candidates = [
        ...(current ? [current] : []),
        ...state.queue.map(trackById).filter(Boolean),
        ...upcomingFromOrder.map(trackById).filter(Boolean)
      ];
      const seen = new Set();
      tracks = candidates.filter((track) => {
        if (!track || !track.id || seen.has(track.id)) return false;
        seen.add(track.id);
        return true;
      });
    }
    const query = state.query.trim().toLocaleLowerCase();
    if (query) tracks = tracks.filter((track) => (track.name + ' ' + track.artist).toLocaleLowerCase().includes(query));
    return tracks;
  }

  function coverMarkup(track) {
    const cover = coverForTrack(track);
    const active = currentTrack();
    const playing = Boolean(active && active.id === track.id && state.isPlaying);
    const artwork = cover
      ? '<img class="track-cover-image" src="' + esc(cover) + '" alt="" loading="lazy" decoding="async">'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
    return '<div class="track-cover' + (cover ? ' has-cover' : '') + '">' + artwork +
      (playing ? '<span class="playing-bars"><i></i><i></i><i></i><i></i></span>' : '') + '</div>';
  }

  function updatePlayingRows() {
    const active = currentTrack();
    document.querySelectorAll('.track-row').forEach((row) => {
      const playing = Boolean(active && row.dataset.track === active.id);
      row.classList.toggle('playing', playing);
      const cover = row.querySelector('.track-cover');
      if (!cover) return;
      let bars = cover.querySelector('.playing-bars');
      if (playing && state.isPlaying && !bars) {
        cover.insertAdjacentHTML('beforeend', '<span class="playing-bars"><i></i><i></i><i></i><i></i></span>');
      } else if ((!playing || !state.isPlaying) && bars) {
        bars.remove();
      }
    });
  }

  function emptyMarkup() {
    if (state.view === 'queue') {
      const heading = state.query ? 'Ничего не найдено' : 'Очередь пуста';
      const message = state.query
        ? 'Попробуй другой запрос.'
        : (currentTrack()
          ? 'Текущий трек показан в очереди, а следующие композиции появятся здесь после добавления.'
          : 'Добавь треки в очередь кнопкой с символом «+» рядом с музыкой.');
      return '<div class="empty-state"><div class="empty-glyph">≋</div><h3>' + heading + '</h3><p>' + message + '</p>' +
        (!state.query ? '<button class="primary-button" data-go-library="true">Открыть медиатеку</button>' : '') + '</div>';
    }
    return '<div class="empty-state"><div class="empty-glyph">♫</div><h3>' + (state.query ? 'Ничего не найдено' : 'Твоя медиатека пока пуста') + '</h3><p>' + (state.query ? 'Попробуй другое название или имя исполнителя.' : 'Добавь аудиофайлы с телефона. Они останутся в приложении и будут доступны без интернета.') + '</p>' + (!state.query ? '<button class="primary-button" data-import="true">Добавить музыку</button>' : '') + '</div>';
  }

  const SORT_LABELS = { recent: 'Сначала новые', title: 'По названию', artist: 'По исполнителю' };
  let loadMoreObserver = null;
  function observeLoadMore() {
    const button = $('#trackList').querySelector('[data-load-more]');
    if (!button) return;
    const more = () => { state.renderLimit += 200; renderList(); };
    button.onclick = more;
    if (!('IntersectionObserver' in window)) return;
    if (loadMoreObserver) loadMoreObserver.disconnect();
    loadMoreObserver = new IntersectionObserver((entries) => { if (entries.some((entry) => entry.isIntersecting)) { loadMoreObserver.disconnect(); more(); } }, { rootMargin: '400px' });
    loadMoreObserver.observe(button);
  }

  function renderFilterBar() {
    const bar = $('#filterBar');
    if (!bar) return;
    bar.classList.toggle('hidden', state.view === 'queue');
    bar.querySelectorAll('[data-sort]').forEach((button) => {
      const active = button.dataset.sort === state.sortMode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    const active = $('#activeFilters');
    const chips = [];
    if (state.sortMode !== 'recent') chips.push('<button type="button" class="filter-chip" data-clear="sort" aria-label="Сбросить сортировку">' + esc(SORT_LABELS[state.sortMode]) + '<span aria-hidden="true">×</span></button>');
    if (state.query) chips.push('<button type="button" class="filter-chip" data-clear="query" aria-label="Сбросить поиск">«' + esc(state.query.slice(0, 24)) + '»<span aria-hidden="true">×</span></button>');
    if (chips.length > 1) chips.push('<button type="button" class="filter-reset" data-clear="all">Сбросить всё</button>');
    active.innerHTML = chips.join('');
    active.classList.toggle('has-filters', chips.length > 0);
  }

  function renderList() {
    const isYoutube = state.view === 'youtube';
    const isSettings = state.view === 'settings';
    const isPlaylists = state.view === 'playlists';
    $('#librarySection').classList.toggle('hidden', isYoutube || isSettings || isPlaylists);
    $('#playlistsSection').classList.toggle('hidden', !isPlaylists);
    $('#settingsSection').classList.toggle('hidden', !isSettings);
    $('#onlineSection').classList.toggle('hidden', !isYoutube);
    const tracks = viewTracks();
    const list = $('#trackList');
    $('#trackCount').textContent = state.view === 'queue' ? pluralTracks(tracks.length) + ' в очереди' : pluralTracks(tracks.length);
    const visibleQueueCount = state.view === 'queue'
      ? Math.max(0, tracks.length - (currentTrack() ? 1 : 0))
      : state.queue.length;
    $('#queueBadge').textContent = visibleQueueCount;
    $('#queueBadge').classList.toggle('hidden', visibleQueueCount === 0);
    $('#sectionTitle').textContent = state.view === 'queue' ? 'Очередь' : 'Моя музыка';
    document.querySelectorAll('.nav-item[data-view]').forEach((button) => {
      const active = button.dataset.view === state.view;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
    });
    renderFilterBar();
    if (isYoutube || isSettings || isPlaylists) return;
    if (!tracks.length) { list.innerHTML = emptyMarkup(); return; }
    const limited = state.view === 'library' && tracks.length > state.renderLimit;
    const shownTracks = limited ? tracks.slice(0, state.renderLimit) : tracks;
    const activeTrackNow = currentTrack();
    list.innerHTML = shownTracks.map((track) => {
      const active = activeTrackNow;
      const playing = Boolean(active && active.id === track.id);
      const currentQueueTrack = state.view === 'queue' && playing;
      const explicitlyQueued = state.view === 'queue' && state.queue.includes(track.id);
      const meta = currentQueueTrack
        ? '<span class="queue-current-label">Сейчас играет</span>'
        : (state.view === 'queue' && !explicitlyQueued
          ? '<span class="queue-current-label">Далее по списку</span>'
          : (Number(track.duration) > 0 ? formatTime(track.duration) : '—:—'));
      const queueAction = currentQueueTrack || !explicitlyQueued ? '' :
        '<button class="track-action" data-action="remove-queue" data-id="' + esc(track.id) + '" aria-label="Убрать из очереди" title="Убрать из очереди"><svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg></button>';
      const mainAction = state.view === 'queue'
        ? queueAction
        : '<button class="track-action" data-action="enqueue" data-id="' + esc(track.id) + '" aria-label="Добавить в очередь" title="В очередь"><svg viewBox="0 0 24 24"><path d="M4 6h12M4 12h12M4 18h7M19 14v7m-3.5-3.5h7"/></svg></button>';
      const playlistAction = track.isRemote ? '' :
        '<details class="track-context-menu"><summary class="track-action track-more-action" aria-label="Другие действия с композицией" title="Действия">⋮</summary>' +
          '<div class="track-context-popover" role="group" aria-label="Действия с композицией"><button type="button" data-action="add-to-playlist" data-id="' + esc(track.id) + '">Добавить в плейлист…</button></div></details>';
      return '<article class="track-row' + (playing ? ' playing' : '') + '" data-track="' + esc(track.id) + '">' +
        SWIPE_HINT + coverMarkup(track) +
        '<div class="track-main" data-action="play" data-id="' + esc(track.id) + '" role="button" tabindex="0" aria-label="Воспроизвести ' + esc(track.name) + '">' +
          '<div class="track-name">' + esc(track.name) + '</div><div class="track-artist">' + esc(track.artist || 'Неизвестный исполнитель') + '</div>' +
        '</div>' +
        '<div class="track-meta">' + meta + '</div>' +
        '<div class="track-actions">' + mainAction + playlistAction + '</div></article>';
    }).join('') + (limited ? '<button type="button" class="load-more" data-load-more>Показать ещё (' + (tracks.length - shownTracks.length) + ')</button>' : '');
    if (limited) observeLoadMore();
  }

  function renderPlaylistTrack(track, position, total) {
    const canMoveUp = position > 0;
    const canMoveDown = position < total - 1;
    return '<article class="track-row playlist-track-row" data-playlist-track="' + esc(track.id) + '" data-position="' + (position + 1) + '">' +
      SWIPE_HINT +
      '<button class="playlist-reorder-handle" data-reorder-handle="true" type="button" aria-label="Перетащить ' + esc(track.name) + '" title="Перетащить для изменения порядка">⠿</button>' +
      '<span class="playlist-track-position" aria-label="Позиция ' + (position + 1) + '">' + (position + 1) + '</span>' +
      coverMarkup(track) +
      '<div class="track-main" data-action="play" data-id="' + esc(track.id) + '" role="button" tabindex="0" aria-label="Воспроизвести ' + esc(track.name) + '">' +
        '<div class="track-name">' + esc(track.name) + '</div><div class="track-artist">' + esc(track.artist || 'Неизвестный исполнитель') + '</div>' +
      '</div><div class="track-meta">' + (Number(track.duration) > 0 ? formatTime(track.duration) : '—:—') + '</div>' +
      '<div class="track-actions">' +
        '<details class="playlist-track-menu"><summary class="track-action" aria-label="Действия с треком" title="Дополнительные действия">⋮</summary>' +
          '<div class="playlist-track-menu-popover" role="group" aria-label="Действия с треком">' +
            '<button type="button" data-playlist-action="add-to-playlist" data-id="' + esc(track.id) + '">Добавить в другой плейлист…</button>' +
            '<button type="button" data-playlist-action="enqueue-track" data-id="' + esc(track.id) + '">Добавить в очередь</button>' +
            '<button type="button" data-playlist-action="move-up" data-id="' + esc(track.id) + '"' + (canMoveUp ? '' : ' disabled') + '>Переместить выше</button>' +
            '<button type="button" data-playlist-action="move-down" data-id="' + esc(track.id) + '"' + (canMoveDown ? '' : ' disabled') + '>Переместить ниже</button>' +
            '<button type="button" data-playlist-action="set-position" data-id="' + esc(track.id) + '">Указать позицию…</button>' +
            '<button type="button" data-playlist-action="remove-track" data-id="' + esc(track.id) + '">Убрать из плейлиста</button>' +
          '</div>' +
        '</details>' +
      '</div></article>';
  }

  function capturePlaylistRowPositions() {
    const positions = new Map();
    document.querySelectorAll('#playlistContent .track-row[data-playlist-track]').forEach((row) => {
      positions.set(row.dataset.playlistTrack, row.getBoundingClientRect());
    });
    return positions;
  }

  function animatePlaylistRows(previousPositions) {
    if (!previousPositions || !previousPositions.size ||
        (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    document.querySelectorAll('#playlistContent .track-row[data-playlist-track]').forEach((row) => {
      const previous = previousPositions.get(row.dataset.playlistTrack);
      if (!previous || typeof row.animate !== 'function') return;
      const current = row.getBoundingClientRect();
      const deltaY = previous.top - current.top;
      if (Math.abs(deltaY) < 1) return;
      row.animate([
        { transform: 'translateY(' + deltaY + 'px)' },
        { transform: 'translateY(0)' }
      ], { duration: 190, easing: 'cubic-bezier(.2,.8,.2,1)' });
    });
  }

  function refreshActivePlaylistPlayback(playlist) {
    if (!playlist || state.playbackPlaylistId !== playlist.id) return;
    state.playbackOrder = uniqueTrackIds(playlist.trackIds);
    state.nativeQueueOrder = null;
    state.nativeQueueLastKey = '';
    if (isNativePlaybackNotificationAvailable() && currentTrack()) void syncNativePlayback(true);
  }

  function persistPlaylistOrder(playlist, nextIds, message) {
    if (!playlist || !Array.isArray(nextIds) || nextIds.length !== playlist.trackIds.length ||
        new Set(nextIds).size !== nextIds.length || nextIds.some((id) => !playlist.trackIds.includes(id))) return false;
    if (nextIds.every((id, index) => id === playlist.trackIds[index])) return false;

    const previousPositions = capturePlaylistRowPositions();
    playlist.trackIds = nextIds.slice();
    savePlaylists();

    // Only the playlist that started the active playback owns its sequential order.
    // A change in another playlist must never disturb the currently playing source.
    // setQueue rebuilds the ExoPlayer timeline at the same current media ID and
    // playback position; shuffle/repeat flags and manually queued items are retained.
    refreshActivePlaylistPlayback(playlist);

    renderPlaylists();
    animatePlaylistRows(previousPositions);
    if (message) showToast(message);
    return true;
  }

  function movePlaylistTrackBy(playlist, trackId, offset) {
    if (!playlist) return;
    const ids = uniqueTrackIds(playlist.trackIds);
    const index = ids.indexOf(trackId);
    const targetIndex = index + offset;
    if (index < 0 || targetIndex < 0 || targetIndex >= ids.length) return;
    const next = movePlaylistTrack(ids, trackId, ids[targetIndex], offset < 0 ? 'before' : 'after');
    persistPlaylistOrder(playlist, next, 'Порядок плейлиста сохранён.');
  }

  function movePlaylistTrackToUserPosition(playlist, trackId) {
    if (!playlist) return;
    const ids = uniqueTrackIds(playlist.trackIds);
    const currentPosition = ids.indexOf(trackId) + 1;
    const value = window.prompt('Новая позиция трека (1–' + ids.length + '):', String(currentPosition));
    if (value === null) return;
    const position = Number(String(value).trim());
    const next = movePlaylistTrackToPosition(ids, trackId, position);
    if (!next) {
      showToast('Укажи целый номер позиции от 1 до ' + ids.length + '.');
      return;
    }
    persistPlaylistOrder(playlist, next, 'Трек перемещён на позицию ' + position + '.');
  }

  function renderPlaylists() {
    const root = $('#playlistContent');
    if (!root) return;
    const playlist = playlistById(state.currentPlaylistId);
    if (playlist) {
      const orderedIds = uniqueTrackIds(playlist.trackIds);
      const allTracks = orderedIds.map(trackById).filter(Boolean);
      const tracks = filterPlaylistTracks(allTracks, state.playlistQuery);
      const content = tracks.length
        ? '<div class="track-list playlist-track-list" data-playlist-track-list="' + esc(playlist.id) + '">' + tracks.map((track) => renderPlaylistTrack(track, orderedIds.indexOf(track.id), orderedIds.length)).join('') + '</div>'
        : (allTracks.length
          ? '<div class="empty-state"><h3>Ничего не найдено</h3><p>Измени запрос поиска по трекам или исполнителям.</p></div>'
          : '<div class="empty-state playlist-drop-target" data-playlist-drop="' + esc(playlist.id) + '"><div class="empty-glyph">♫</div><h3>Плейлист пуст</h3><p>Добавь файлы музыки сюда или нажми кнопку добавления. Добавленные треки останутся и в общей медиатеке.</p><button class="primary-button" data-playlist-action="add-music" data-id="' + esc(playlist.id) + '" type="button">＋ Добавить музыку</button><button class="secondary-button" data-playlist-action="back" type="button">Моя музыка</button></div>');
      root.innerHTML = '<div class="playlist-detail playlist-drop-target" data-playlist-drop="' + esc(playlist.id) + '"><div class="playlist-detail-heading">' +
        '<button class="secondary-button playlist-back-button" data-playlist-action="back" type="button">← Все плейлисты</button>' +
        '<div class="playlist-detail-copy"><h3>' + esc(playlist.name) + '</h3><span>' + pluralTracks(tracks.length) + '</span></div>' +
        '<div class="playlist-detail-actions">' +
          '<button class="primary-button" data-playlist-action="play-all" data-id="' + esc(playlist.id) + '" type="button">▶ Слушать</button>' +
          '<button class="secondary-button" data-playlist-action="add-music" data-id="' + esc(playlist.id) + '" type="button">＋ Добавить музыку</button>' +
          '<button class="secondary-button" data-playlist-action="enqueue-from-current" data-id="' + esc(playlist.id) + '" type="button">В очередь от текущего</button>' +
          '<button class="secondary-button" data-playlist-action="rename" data-id="' + esc(playlist.id) + '" type="button">Переименовать</button>' +
          '<button class="ghost-button" data-playlist-action="delete" data-id="' + esc(playlist.id) + '" type="button">Удалить</button>' +
        '</div></div>' + content + '</div>';
      return;
    }
    state.currentPlaylistId = null;
    if (!state.playlists.length) {
      root.innerHTML = '<div class="empty-state"><div class="empty-glyph">♫</div><h3>Создай свой первый плейлист</h3><p>Собери музыку по настроению, жанру или случаю. Плейлисты сохраняются на этом устройстве.</p><button class="primary-button" data-playlist-action="create" type="button">＋ Создать плейлист</button></div>';
      return;
    }
    const visiblePlaylists = filterPlaylistCards(state.playlists, state.playlistQuery);
    if (!visiblePlaylists.length) {
      root.innerHTML = '<div class="empty-state"><h3>Плейлисты не найдены</h3><p>Попробуй изменить поисковый запрос.</p></div>';
      return;
    }
    root.innerHTML = '<div class="playlist-grid">' + visiblePlaylists.map((item) => {
      const count = uniqueTrackIds(item.trackIds).length;
      return '<article class="playlist-card" data-playlist-card="' + esc(item.id) + '">' +
        '<button class="playlist-card-open" data-playlist-action="open" data-id="' + esc(item.id) + '" type="button" aria-label="Открыть плейлист ' + esc(item.name) + '">' +
          '<span class="playlist-card-art" aria-hidden="true">♫</span><span class="playlist-card-copy"><b>' + esc(item.name) + '</b><small>' + pluralTracks(count) + '</small></span><span class="playlist-card-arrow">›</span>' +
        '</button><div class="playlist-card-actions">' +
          '<button class="secondary-button" data-playlist-action="play-all" data-id="' + esc(item.id) + '" type="button">▶ Слушать</button>' +
          '<button class="secondary-button" data-playlist-action="enqueue-from-current" data-id="' + esc(item.id) + '" type="button">В очередь</button>' +
          '<button class="ghost-button" data-playlist-action="rename" data-id="' + esc(item.id) + '" type="button" aria-label="Переименовать ' + esc(item.name) + '">✎</button>' +
          '<button class="ghost-button" data-playlist-action="delete" data-id="' + esc(item.id) + '" type="button" aria-label="Удалить ' + esc(item.name) + '">×</button>' +
        '</div></article>';
    }).join('') + '</div>';
  }

  function enqueueTracksFromCurrent(ids, label, playlistId = null) {
    const order = uniqueTrackIds(ids);
    if (!order.length) { showToast('В этом списке пока нет треков.'); return; }
    const currentIndex = order.indexOf(state.currentId);
    const upcoming = currentIndex >= 0 ? order.slice(currentIndex + 1) : order;
    const queued = new Set(state.queue);
    if (state.currentId) queued.add(state.currentId);
    const additions = upcoming.filter((id) => !queued.has(id));
    state.queue.push(...additions);
    state.playbackOrder = order;
    setPlaybackPlaylist(playlistId);
    saveQueue();
    render();
    showToast(additions.length
      ? 'В очередь добавлено: ' + pluralTracks(additions.length) + (label ? ' · ' + label : '') + '.'
      : 'После текущего трека новых песен для очереди нет.');
  }

  function openPlaylistNameDialog(id) {
    const playlist = id ? playlistById(id) : null;
    state.editingPlaylistId = playlist ? playlist.id : null;
    $('#playlistNameDialogTitle').textContent = playlist ? 'Переименовать плейлист' : 'Новый плейлист';
    $('#playlistNameInput').value = playlist ? playlist.name : '';
    $('#playlistNameDialog').showModal();
    $('#playlistNameInput').focus();
  }

  function openAddToPlaylistDialog(trackId, excludePlaylistId = null) {
    const track = trackById(trackId);
    if (!track) return;
    state.pendingPlaylistTrackId = trackId;
    $('#addToPlaylistTrackName').textContent = '«' + track.name + '»';
    const choices = state.playlists.filter((playlist) => playlist.id !== excludePlaylistId);
    const availableChoices = choices.filter((playlist) => !playlist.trackIds.includes(trackId));
    $('#playlistTargetSelect').innerHTML = choices.length
      ? choices.map((playlist) => '<option value="' + esc(playlist.id) + '"' + (playlist.trackIds.includes(trackId) ? ' disabled' : '') + '>' + esc(playlist.name) + (playlist.trackIds.includes(trackId) ? ' · уже добавлен' : '') + '</option>').join('')
      : '<option value="" selected>Создай новый плейлист</option>';
    const preferred = availableChoices.find((playlist) => playlist.id === state.quickAddPlaylistId) || availableChoices[0];
    if (preferred) $('#playlistTargetSelect').value = preferred.id;
    $('#playlistTargetSelect').disabled = !availableChoices.length;
    $('#addToPlaylistForm button[type="submit"]').disabled = !availableChoices.length;
    $('#addToPlaylistDialog').showModal();
  }

  function addTrackToPlaylist(playlistId, trackId, options = {}) {
    const playlist = playlistById(playlistId);
    if (!playlist || !trackById(trackId)) return false;
    if (playlist.trackIds.includes(trackId)) {
      showToast('Этот трек уже есть в плейлисте.');
      return false;
    }
    playlist.trackIds.push(trackId);
    savePlaylists();
    saveQuickAddPlaylist(playlist.id);
    refreshActivePlaylistPlayback(playlist);
    render();
    const message = 'Добавлено в плейлист «' + playlist.name + '».';
    if (options.undoable) {
      showToast(message, 'Отменить', () => {
        const current = playlistById(playlistId);
        const index = current ? current.trackIds.indexOf(trackId) : -1;
        if (index < 0) return;
        current.trackIds.splice(index, 1);
        savePlaylists();
        refreshActivePlaylistPlayback(current);
        render();
        showToast('Добавление отменено.');
      });
    } else showToast(message);
    return true;
  }

  function setPlayerFullscreen(open) {
    const player = $('#player');
    const isOpen = Boolean(open);
    player.classList.toggle('player-fullscreen', isOpen);
    player.setAttribute('aria-expanded', String(isOpen));
    document.body.classList.toggle('player-overlay-open', isOpen);
  }

  function renderPlayer() {
    const track = currentTrack();
    $('#nowTitle').textContent = track ? track.name : 'Выбери свой первый трек';
    $('#nowArtist').textContent = track ? (track.artist || 'Неизвестный исполнитель') : 'Твоя музыка ждёт';
    const coverUrl = coverForTrack(track);
    const coverKey = track ? String(track.id) + '|' + coverUrl : 'empty';
    if (state.playerCoverKey !== coverKey) {
      $('#playerCover').innerHTML = coverUrl
        ? '<img class="player-cover-image" src="' + esc(coverUrl) + '" alt="" decoding="async">'
        : '<span>♫</span>';
      const coverImage = $('#playerCover').querySelector('img');
      if (coverImage) {
        coverImage.addEventListener('error', () => {
          if (state.playerCoverKey === coverKey) {
            // Allow a later render to retry a transiently failed artwork URL.
            state.playerCoverKey = '';
            $('#playerCover').innerHTML = '<span>♫</span>';
          }
        }, { once: true });
      }
      state.playerCoverKey = coverKey;
    }
    $('#playIcon').innerHTML = state.isPlaying
      ? '<path d="M7 5h4v14H7zM15 5h4v14h-4z"/>'
      : '<path d="m8 5 12 7-12 7z"/>';
    $('#playPause').setAttribute('aria-label', state.isPlaying ? 'Пауза' : 'Воспроизвести');
    const native = isNativePlaybackNotificationAvailable();
    const audioDuration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    const knownDuration = !track ? 0 : (native ? (state.nativeDuration || Number(track.duration) || 0) : (audioDuration || Number(track.duration) || 0));
    const elapsed = track ? currentPlaybackPosition() : 0;
    $('#seek').disabled = !track || knownDuration <= 0;
    $('#duration').textContent = knownDuration > 0 ? formatTime(knownDuration) : (track ? '—:—' : '0:00');
    const displayedElapsed = knownDuration > 0 ? Math.min(knownDuration, elapsed) : elapsed;
    $('#elapsed').textContent = formatTime(displayedElapsed);
    updateSeekVisual(displayedElapsed, knownDuration);
    if (!state.seekDragging) $('#seek').value = knownDuration > 0 ? String(Math.round(Math.min(1, displayedElapsed / knownDuration) * 1000)) : '0';
    $('#shuffle').classList.toggle('selected', state.shuffle);
    $('#repeat').classList.toggle('selected', state.repeat);
    $('#repeatDot').classList.toggle('hidden', !state.repeat);
    $('#repeat').title = state.repeat ? 'Повтор текущего трека включён' : 'Повтор выключен';
    if (track && !isNativePlaybackNotificationAvailable() && 'mediaSession' in navigator && typeof window.MediaMetadata === 'function') {
      const metadataKey = String(track.id) + '|' + coverUrl;
      try {
        if (state.lastMediaMetadataKey !== metadataKey) {
          const metadata = { title: track.name, artist: track.artist || 'Crimson', album: 'Моя музыка' };
          if (coverUrl) metadata.artwork = [{ src: coverUrl, sizes: '512x512', type: 'image/jpeg' }];
          navigator.mediaSession.metadata = new MediaMetadata(metadata);
          state.lastMediaMetadataKey = metadataKey;
        }
        const playbackState = state.isPlaying ? 'playing' : 'paused';
        if (state.lastMediaPlaybackState !== playbackState) {
          navigator.mediaSession.playbackState = playbackState;
          state.lastMediaPlaybackState = playbackState;
        }
      } catch (_) {}
    }
    if (!state.applyingNativeSnapshot) void syncNativePlayback();
  }

  function render() {
    renderList();
    if (state.view === 'playlists') renderPlaylists();
    if (state.view === 'youtube') renderOnlineResults();
    renderPlayer();
  }

  // ===== Сохранность данных: резервные копии, восстановление, экспорт/импорт, проверка =====
  function waitForNativePlugin(timeoutMs = 1500) {
    if (window.CrimsonYtDlp) return Promise.resolve(window.CrimsonYtDlp);
    return new Promise((resolve) => {
      const done = () => resolve(window.CrimsonYtDlp || null);
      window.addEventListener('crimson-yt-dlp-ready', done, { once: true });
      setTimeout(done, timeoutMs);
    });
  }
  const backupPlugin = () => (window.CrimsonYtDlp && typeof window.CrimsonYtDlp.saveBackup === 'function' ? window.CrimsonYtDlp : null);

  function buildBackupSnapshot() {
    let liteMotion = null;
    try { liteMotion = localStorage.getItem(LITE_MOTION_KEY) === '1'; } catch (_) {}
    return createSnapshot({
      playlists: state.playlists, tracks: state.tracks, queue: state.queue,
      quickAddPlaylistId: state.quickAddPlaylistId, playbackPlaylistId: state.playbackPlaylistId,
      sortMode: state.sortMode,
      settings: {
        sortMode: state.sortMode,
        downloadConcurrency: readDownloadConcurrency(),
        liteMotion
      }
    });
  }

  /** Восстанавливает настройки и ссылки очереди из снимка без подмены трековых ID. */
  function restoreBackupPreferences(data) {
    const snapshot = data && typeof data === 'object' ? data : {};
    const settings = snapshot.settings && typeof snapshot.settings === 'object' ? snapshot.settings : {};
    const sortMode = SORT_MODES.includes(settings.sortMode) ? settings.sortMode : snapshot.sortMode;
    if (SORT_MODES.includes(sortMode)) {
      state.sortMode = sortMode;
      try { localStorage.setItem(STORAGE_KEYS.sort, sortMode); } catch (_) {}
    }
    if (Number.isFinite(Number(settings.downloadConcurrency)) && settings.downloadConcurrency !== null && settings.downloadConcurrency !== '') {
      const value = clampConcurrency(settings.downloadConcurrency);
      try { localStorage.setItem(STORAGE_KEYS.downloadConcurrency, String(value)); } catch (_) {}
      downloadQueue.setConcurrency(value);
      const control = $('#downloadConcurrency');
      if (control) control.value = String(value);
    }
    if (typeof settings.liteMotion === 'boolean') {
      try { localStorage.setItem(LITE_MOTION_KEY, settings.liteMotion ? '1' : '0'); } catch (_) {}
      applyLiteMotion(settings.liteMotion);
      const control = $('#liteMotion');
      if (control) control.checked = settings.liteMotion;
    }
    if (snapshot.quickAddPlaylistId) {
      state.quickAddPlaylistId = String(snapshot.quickAddPlaylistId);
      try { localStorage.setItem(STORAGE_KEYS.quickAddPlaylist, state.quickAddPlaylistId); } catch (_) {}
    }
    if (snapshot.playbackPlaylistId) {
      state.playbackPlaylistId = String(snapshot.playbackPlaylistId);
      try { localStorage.setItem(STORAGE_KEYS.playbackPlaylist, state.playbackPlaylistId); } catch (_) {}
    }
    if (Array.isArray(snapshot.queue)) state.pendingQueueRefs = snapshot.queue;
  }

  function restoreBackupQueue() {
    if (!Array.isArray(state.pendingQueueRefs)) return;
    const holder = { id: 'crimson-backup-queue', name: 'Backup queue', trackIds: [], refs: state.pendingQueueRefs };
    const reconciled = reconcilePlaylists([holder], state.tracks).playlists[0];
    state.queue = uniqueTrackIds(reconciled ? reconciled.trackIds : []);
    state.pendingQueueRefs = null;
    saveQueue();
  }

  function scheduleBackup() {
    clearTimeout(state.backupTimer);
    state.backupTimer = setTimeout(() => { void saveBackupNow(); }, 1800);
  }

  async function saveBackupNow() {
    clearTimeout(state.backupTimer);
    const plugin = backupPlugin();
    if (!plugin || !state.libraryLoaded) return null;
    // Пустое состояние не затирает хорошую копию: после неудачного восстановления ничего не теряется.
    if (!state.playlists.length && !state.allowEmptyBackup) return null;
    try {
      const result = await plugin.saveBackup({ json: encodeBackup(buildBackupSnapshot()) });
      state.lastBackupAt = Date.now();
      state.backupStatus = 'Последняя копия: ' + new Date(state.lastBackupAt).toLocaleString('ru-RU');
      refreshDataStatus();
      return result;
    } catch (error) {
      console.warn('Backup failed', error);
      state.backupStatus = 'Не удалось сохранить резервную копию: ' + (error && error.message || error);
      refreshDataStatus();
      return null;
    }
  }

  function refreshDataStatus(extra = '') {
    const node = $('#dataStatus');
    if (!node) return;
    const count = state.playlists.length;
    node.textContent = [pluralPlaylists(count), state.backupStatus || 'Резервная копия создаётся автоматически после изменений.', extra].filter(Boolean).join(' · ');
  }
  function pluralPlaylists(n) {
    const last = n % 10, tens = n % 100;
    if (tens > 10 && tens < 20) return n + ' плейлистов';
    if (last === 1) return n + ' плейлист';
    return n + (last > 1 && last < 5 ? ' плейлиста' : ' плейлистов');
  }

  /** Читает копии из приватной папки приложения и из выбранной папки пользователя. */
  async function readNativeBackups() {
    await waitForNativePlugin();
    const plugin = window.CrimsonYtDlp;
    if (!plugin || typeof plugin.readBackups !== 'function') return [];
    try { const result = await plugin.readBackups(); return Array.isArray(result && result.backups) ? result.backups : []; } catch (_) { return []; }
  }

  async function loadStoredPlaylists() {
    const stored = readGuarded(localStorage, STORAGE_KEYS.playlists, []);
    state.allowEmptyBackup = !stored.missing;
    let list = Array.isArray(stored.value) ? stored.value : [];
    let note = stored.recovered ? 'Плейлисты восстановлены из предыдущей исправной копии.' : '';
    if (stored.missing) {
      // Данных нет: первый запуск или переустановка. Ищем резервную копию.
      const { best } = pickNewestValidBackup(await readNativeBackups());
      if (best) {
        const extras = best.snapshot.data;
        list = Array.isArray(extras.playlists) ? extras.playlists : [];
        restoreBackupPreferences(extras);
        note = 'Данные Crimson восстановлены из резервной копии. Треки подтянутся после сканирования папки.';
      }
    }
    return { playlists: list.map((item) => normalizePlaylist(item)).filter(Boolean), note };
  }

  async function exportPlaylistsFile() {
    const plugin = await waitForNativePlugin();
    if (!plugin || typeof plugin.exportFile !== 'function') { showToast('Экспорт доступен в установленном APK.'); return; }
    try {
      await plugin.exportFile({ name: 'crimson-playlists.json', text: exportPlaylists(state.playlists, state.tracks) });
      showToast('Плейлисты экспортированы.');
    } catch (error) { if (!/отмен/i.test(String(error && error.message || error))) showToast('Не удалось экспортировать: ' + (error && error.message || error)); }
  }

  async function importPlaylistsFile() {
    const plugin = await waitForNativePlugin();
    if (!plugin || typeof plugin.importFile !== 'function') { showToast('Импорт доступен в установленном APK.'); return; }
    try {
      const picked = await plugin.importFile();
      const result = importPlaylists(picked.text, state.playlists, state.tracks);
      if (!result.ok) { showToast(result.error); return; }
      await saveBackupNow(); // снимок текущего состояния перед применением
      state.playlists = result.playlists.map((item) => ({ ...item, trackIds: uniqueTrackIds(item.trackIds) }));
      savePlaylists(); render();
      const r = result.report;
      showToast('Импорт: новых ' + r.added + ', объединено ' + r.merged + (r.tracksMissing ? ', не найдено треков: ' + r.tracksMissing : '') + '.');
    } catch (error) { if (!/отмен/i.test(String(error && error.message || error))) showToast('Не удалось импортировать: ' + (error && error.message || error)); }
  }

  async function restoreFromBackup() {
    const { best, problems } = pickNewestValidBackup(await readNativeBackups());
    if (!best) { showToast(problems.length ? 'Копии найдены, но повреждены: ' + problems[0].error : 'Резервные копии не найдены.'); return; }
    const when = best.snapshot.createdAt ? new Date(best.snapshot.createdAt).toLocaleString('ru-RU') : 'неизвестно';
    if (!window.confirm('Восстановить плейлисты (' + best.snapshot.data.playlists.length + ') из копии от ' + when + '? Текущие плейлисты будут заменены; перед этим сохранится их копия.')) return;
    await saveBackupNow();
    const reconciled = reconcilePlaylists(best.snapshot.data.playlists, state.tracks);
    state.playlists = reconciled.playlists.map((item) => ({ ...item, trackIds: uniqueTrackIds(item.trackIds) }));
    restoreBackupPreferences(best.snapshot.data); restoreBackupQueue();
    savePlaylists(); render();
    showToast('Восстановлено плейлистов: ' + state.playlists.length + (reconciled.pending ? '. Не найдено пока треков: ' + reconciled.pending : '.'));
  }

  async function restoreFromChosenFile() {
    const plugin = await waitForNativePlugin();
    if (!plugin || typeof plugin.importFile !== 'function') return;
    try {
      const picked = await plugin.importFile();
      const decoded = decodeBackup(picked.text);
      if (!decoded.ok) { showToast(decoded.error); return; }
      if (!window.confirm('Заменить текущие плейлисты данными из файла (' + decoded.snapshot.data.playlists.length + ')?')) return;
      await saveBackupNow();
      const reconciled = reconcilePlaylists(decoded.snapshot.data.playlists, state.tracks);
      state.playlists = reconciled.playlists.map((item) => ({ ...item, trackIds: uniqueTrackIds(item.trackIds) }));
      restoreBackupPreferences(decoded.snapshot.data); restoreBackupQueue();
      savePlaylists(); render();
      showToast('Данные восстановлены из файла.');
    } catch (error) { if (!/отмен/i.test(String(error && error.message || error))) showToast('Не удалось восстановить: ' + (error && error.message || error)); }
  }

  async function runIntegrityCheck() {
    const problems = [];
    try {
      const records = await getAllRecords();
      if (!Array.isArray(records)) problems.push('база треков вернула некорректные данные');
    } catch (error) { problems.push('база треков недоступна: ' + (error && error.message || error)); }
    const stored = readGuarded(localStorage, STORAGE_KEYS.playlists, []);
    if (stored.recovered) problems.push('основная запись плейлистов была повреждена и восстановлена из копии');
    const report = checkPlaylistIntegrity(state.playlists, state.tracks);
    report.issues.forEach((issue) => {
      if (issue.type === 'missing-tracks') problems.push('в плейлисте «' + issue.playlist + '» ссылок на отсутствующие треки: ' + issue.count);
      else problems.push('проблема структуры: ' + issue.type);
    });
    if (problems.length && report.issues.length) {
      state.playlists = report.playlists.filter((p) => p).map((playlist) => {
        const live = state.playlists.find((item) => item.id === playlist.id);
        return live ? { ...live, trackIds: uniqueTrackIds(playlist.trackIds) } : playlist;
      });
      savePlaylists(); render();
    }
    refreshDataStatus(problems.length ? 'Проверка: исправлено/найдено — ' + problems.join('; ') : 'Проверка пройдена: проблем не найдено');
    showToast(problems.length ? 'Проверка завершена: найдено замечаний — ' + problems.length : 'Проверка целостности пройдена.');
  }

  async function wipeAllUserData() {
    if (!window.confirm('Удалить ВСЕ данные Crimson: плейлисты (включая созданные папки плейлистов), настройки, медиатеку и резервные копии? Это действие нельзя отменить.')) return;
    if (!window.confirm('Точно удалить всё? Файлы музыки в выбранных папках останутся нетронутыми.')) return;
    try {
      const plugin = window.CrimsonYtDlp;
      if (plugin && typeof plugin.deleteAllPlaylistFolders === 'function') await plugin.deleteAllPlaylistFolders();
      if (plugin && typeof plugin.wipeBackups === 'function') await plugin.wipeBackups();
      Object.keys(localStorage).filter((key) => key.startsWith('crimson.mobile.') || key.startsWith('localify.mobile.')).forEach((key) => localStorage.removeItem(key));
      libraryStore.close(state.db); state.db = null;
      await new Promise((resolve) => { const r = indexedDB.deleteDatabase(DB_NAME); r.onsuccess = r.onerror = r.onblocked = () => resolve(); });
      location.reload();
    } catch (error) { showToast('Не удалось удалить данные: ' + (error && error.message || error)); }
  }

  /** Вызывается после любого изменения состава библиотеки. */
  function notifyLibraryChanged({ skipReconcile = false } = {}) {
    state.libraryDirty = true;
    if (!skipReconcile && state.playlists.some((playlist) => (playlist.refs || []).some((ref) => !trackById(ref.id) && (ref.name || ref.sourceId || ref.youtubeId)))) {
      const result = reconcilePlaylists(state.playlists, state.tracks);
      if (result.resolved) {
        state.playlists = result.playlists.map((item) => ({ ...item, trackIds: uniqueTrackIds(item.trackIds) }));
        savePlaylists();
      }
    }
    if (state.view === 'youtube') renderOnlineResults();
  }

  async function loadLibrary() {
    try {
      state.db = await openDatabase();
      const allRecords = await getAllRecords();
      // Older builds accidentally persisted YouTube preview streams as empty local tracks.
      const playableRecords = allRecords.filter((record) => record &&
        ((record.blob instanceof Blob) || String(record.nativePath || '').trim().length > 0));
      const orphanIds = allRecords.filter((record) => record && !playableRecords.includes(record))
        .map((record) => record.id).filter(Boolean);
      if (orphanIds.length) await removeRecords(orphanIds);
      // Normalize names before deduplication; older builds stored downloaded files and
      // folder-scanned copies as separate records even though both carry the same video ID.
      for (const record of playableRecords) {
        const extractedId = extractYouTubeIdFromTitle(record.name);
        let migrated = false;
        if (extractedId && !record.youtubeId) {
          record.youtubeId = extractedId;
          migrated = true;
        }
        const sourceVideoId = /^[A-Za-z0-9_-]{11}$/.test(String(record.sourceId || ''))
          ? String(record.sourceId) : String(record.youtubeId || extractedId || '');
        const cleanedTitle = cleanYouTubeTitle(record.name, sourceVideoId);
        if (cleanedTitle !== record.name) {
          record.name = cleanedTitle;
          migrated = true;
        }
        if (migrated) record._migrationChanged = true;
      }
      const deduped = deduplicateStoredRecords(playableRecords);
      if (deduped.duplicateIds.length) await removeRecords(deduped.duplicateIds);
      const changed = new Map(deduped.changedRecords.map((record) => [record.id, record]));
      for (const record of deduped.records) {
        if (record._migrationChanged) changed.set(record.id, record);
        // Repair titles persisted by older builds when yt-dlp appended the source ID.
        const sourceVideoId = /^[A-Za-z0-9_-]{11}$/.test(String(record.sourceId || ''))
          ? String(record.sourceId) : String(record.youtubeId || '');
        const cleanedTitle = cleanYouTubeTitle(record.name, sourceVideoId);
        if (cleanedTitle !== record.name) {
          record.name = cleanedTitle;
          changed.set(record.id, record);
        }
        // Downloaded files keep the video ID in their title even when imported from a folder,
        // so recover the same thumbnail URL if older records did not store artwork.
        const artworkVideoId = /^[A-Za-z0-9_-]{11}$/.test(String(record.sourceId || ''))
          ? String(record.sourceId) : String(record.youtubeId || '');
        if (!record.coverUrl && /^[A-Za-z0-9_-]{11}$/.test(artworkVideoId)) {
          record.coverUrl = 'https://i.ytimg.com/vi/' + encodeURIComponent(artworkVideoId) + '/hqdefault.jpg';
          changed.set(record.id, record);
        }
      }
      if (changed.size) await putRecords(Array.from(changed.values()).map(storedShape));
      state.tracks = deduped.records.map(attachUrl).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
      state.libraryLoaded = true;
      scheduleLegacyArtworkMigration(deduped.records);
      const ids = new Set(state.tracks.map((track) => track.id));
      try {
        state.queue = JSON.parse(localStorage.getItem(STORAGE_KEYS.queue) || '[]').filter((id) => ids.has(id));
      } catch (_) {
        state.queue = [];
      }
      try {
        const loaded = await loadStoredPlaylists();
        // Ссылки на треки сопоставляются с библиотекой: после переустановки id другие, а плейлисты остаются.
        const reconciled = reconcilePlaylists(loaded.playlists, state.tracks);
        state.playlists = reconciled.playlists.map((item) => ({ ...item, name: item.name.slice(0, 60), trackIds: uniqueTrackIds(item.trackIds) }));
        restoreBackupQueue();
        if (loaded.note) showToast(loaded.note);
      } catch (error) { console.error('Playlists load failed', error); state.playlists = []; }
      savePlaylists();
      if (state.quickAddPlaylistId && !playlistById(state.quickAddPlaylistId)) saveQuickAddPlaylist(null);
      try {
        const savedPlaybackPlaylist = localStorage.getItem(STORAGE_KEYS.playbackPlaylist);
        state.playbackPlaylistId = savedPlaybackPlaylist && playlistById(savedPlaybackPlaylist)
          ? savedPlaybackPlaylist : null;
        if (!state.playbackPlaylistId && savedPlaybackPlaylist) localStorage.removeItem(STORAGE_KEYS.playbackPlaylist);
      } catch (_) { state.playbackPlaylistId = null; }
      state.playbackOrder = libraryOrderIds();
      notifyLibraryChanged({ skipReconcile: true });
      render();
      setTimeout(() => { void restorePlaylistsFromFolders({ silent: true }); }, 1500);
      setTimeout(() => {
        const damaged = planRepairs(state.tracks).length;
        if (damaged) showToast('Найдено треков с повреждёнными названиями: ' + damaged + '. Настройки → «Исправить названия».');
      }, 3000);
      if (state.pendingNativeSnapshot) {
        const snapshot = state.pendingNativeSnapshot;
        state.pendingNativeSnapshot = null;
        applyNativePlaybackState(snapshot);
      } else if (isNativePlaybackNotificationAvailable()) {
        void refreshNativePlaybackState();
      }
      scheduleMissingDurations(state.tracks);
      // Keep launch responsive; the optional SAF folder scan runs when Settings is opened.
      void refreshFolderSettings();
    } catch (error) {
      console.error(error);
      showToast(error.message || 'Не удалось загрузить медиатеку.');
    }
  }

  function parseFilename(filename) {
    const parsed = libraryNameFromFilename(filename);
    return { artist: parsed.artist || 'Неизвестный исполнитель', name: parsed.name || 'Без названия' };
  }

  function supportedAudio(file) {
    if (file.type && file.type.toLowerCase().startsWith('audio/')) return true;
    return /\.(mp3|m4a|aac|ogg|opus|wav|flac|webm|oga|mp4)$/i.test(file.name || '');
  }

  async function extractEmbeddedCover(file) {
    try {
      const head = new Uint8Array(await file.slice(0, Math.min(10, file.size)).arrayBuffer());
      const textAt = (bytes, offset, text) => {
        for (let i = 0; i < text.length; i++) if (bytes[offset + i] !== text.charCodeAt(i)) return false;
        return true;
      };
      const syncSafe = (bytes, offset) => ((bytes[offset] & 127) << 21) | ((bytes[offset + 1] & 127) << 14) | ((bytes[offset + 2] & 127) << 7) | (bytes[offset + 3] & 127);
      const u32 = (bytes, offset) => (((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]) >>> 0;
      if (head.length >= 10 && textAt(head, 0, 'ID3') && head[3] >= 3) {
        const tagSize = syncSafe(head, 6);
        if (tagSize > 0 && tagSize <= 16 * 1024 * 1024 && file.size >= 10 + tagSize) {
          const tag = new Uint8Array(await file.slice(10, 10 + tagSize).arrayBuffer());
          let offset = 0;
          if ((head[5] & 64) && tag.length >= 4) offset = 4 + u32(tag, 0);
          while (offset + 10 <= tag.length) {
            const frame = String.fromCharCode(tag[offset], tag[offset + 1], tag[offset + 2], tag[offset + 3]);
            if (!/^[A-Z0-9]{4}$/.test(frame)) break;
            const frameSize = head[3] === 4 ? syncSafe(tag, offset + 4) : u32(tag, offset + 4);
            if (frameSize <= 0 || offset + 10 + frameSize > tag.length) break;
            if (frame === 'APIC') {
              const body = tag.subarray(offset + 10, offset + 10 + frameSize);
              const encoding = body[0];
              let mimeEnd = 1;
              while (mimeEnd < body.length && body[mimeEnd] !== 0) mimeEnd++;
              const mime = new TextDecoder().decode(body.subarray(1, mimeEnd)) || 'image/jpeg';
              let descStart = mimeEnd + 2;
              if (descStart > body.length) break;
              let imageStart = -1;
              if (encoding === 1 || encoding === 2) {
                for (let i = descStart; i + 1 < body.length; i += 2) {
                  if (body[i] === 0 && body[i + 1] === 0) { imageStart = i + 2; break; }
                }
              } else {
                descStart = mimeEnd + 2;
                imageStart = body.indexOf(0, descStart);
                if (imageStart >= 0) imageStart += 1;
              }
              if (imageStart >= 0 && imageStart < body.length) return new Blob([body.subarray(imageStart)], { type: mime.startsWith('image/') ? mime : 'image/jpeg' });
            }
            offset += 10 + frameSize;
          }
        }
      }
      if (head.length >= 4 && textAt(head, 0, 'fLaC')) {
        let offset = 4;
        while (offset + 4 <= file.size) {
          const header = new Uint8Array(await file.slice(offset, offset + 4).arrayBuffer());
          if (header.length !== 4) break;
          const type = header[0] & 127;
          const length = (header[1] << 16) | (header[2] << 8) | header[3];
          offset += 4;
          if (length <= 0 || offset + length > file.size) break;
          if (type === 6 && length <= 12 * 1024 * 1024) {
            const picture = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
            let p = 4;
            const mimeLength = u32(picture, p); p += 4;
            const mime = new TextDecoder().decode(picture.subarray(p, p + mimeLength)) || 'image/jpeg'; p += mimeLength;
            const descLength = u32(picture, p); p += 4 + descLength + 16;
            const imageLength = u32(picture, p); p += 4;
            if (imageLength > 0 && p + imageLength <= picture.length) return new Blob([picture.subarray(p, p + imageLength)], { type: mime.startsWith('image/') ? mime : 'image/jpeg' });
            break;
          }
          offset += length;
          if (header[0] & 128) break;
        }
      }
      // iTunes artwork in M4A/MP4 is commonly stored in a covr/data atom near the end.
      if (file.size > 32) {
        const start = Math.max(0, file.size - 4 * 1024 * 1024);
        const tail = new Uint8Array(await file.slice(start).arrayBuffer());
        for (let i = 4; i + 8 < tail.length; i++) {
          if (!textAt(tail, i, 'covr')) continue;
          for (let j = i + 4; j + 8 < tail.length && j < i + 4096; j++) {
            if (!textAt(tail, j, 'data')) continue;
            const atomSize = u32(tail, j - 4);
            const dataStart = j + 12;
            const dataEnd = j - 4 + atomSize;
            if (atomSize >= 16 && dataEnd <= tail.length && dataEnd > dataStart) {
              const typeCode = u32(tail, j + 4);
              const mime = typeCode === 14 ? 'image/png' : 'image/jpeg';
              return new Blob([tail.subarray(dataStart, dataEnd)], { type: mime });
            }
          }
        }
      }
    } catch (_) {}
    return null;
  }

  async function optimizeCoverBlob(blob) {
    if (!(blob instanceof Blob) || !blob.size || typeof createImageBitmap !== 'function') return blob || null;
    let bitmap = null;
    try {
      bitmap = await createImageBitmap(blob);
      const longestSide = Math.max(bitmap.width, bitmap.height);
      if (longestSide <= 512 && blob.size <= 220 * 1024) return blob;
      const scale = Math.min(1, 512 / Math.max(1, longestSide));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      if (!context) return blob;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const compact = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.82));
      return compact && compact.size < blob.size ? compact : blob;
    } catch (_) {
      return blob;
    } finally {
      if (bitmap && typeof bitmap.close === 'function') bitmap.close();
    }
  }

  function importKeyFor(file) {
    return [normalizedPart(file.name), Number(file.size) || 0, Number(file.lastModified) || 0].join('|');
  }

  function legacyImportKey(file) {
    const filenameBase = String(file.name || '').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
    return 'legacy:' + normalizedPart(filenameBase) + '|' + (Number(file.size) || 0);
  }

  function scheduleLegacyArtworkMigration(records) {
    const pending = records.filter((record) => record && !record.coverChecked &&
      record.blob instanceof Blob && !record.coverBlob && !record.coverUrl && !record.coverPath);
    if (!pending.length) return;
    let offset = 0;
    const runBatch = async () => {
      const batch = pending.slice(offset, offset + 2);
      offset += batch.length;
      if (!batch.length) return;
      const updates = await Promise.all(batch.map(async (record) => {
        record.coverBlob = await optimizeCoverBlob(await extractEmbeddedCover(record.blob));
        record.coverChecked = true;
        return record;
      }));
      try { await putRecords(updates.map(storedShape)); } catch (error) { console.warn('Artwork migration could not be saved', error); }
      for (const update of updates) {
        const current = trackById(update.id);
        if (!current) continue;
        if (current.coverDisplayUrl && current.coverDisplayUrl.startsWith('blob:')) URL.revokeObjectURL(current.coverDisplayUrl);
        const patched = {
          ...current,
          coverBlob: update.coverBlob || null,
          coverChecked: true,
          coverDisplayUrl: update.coverBlob instanceof Blob ? URL.createObjectURL(update.coverBlob) : ''
        };
        state.tracks = state.tracks.map((track) => track.id === patched.id ? patched : track);
      }
      renderList();
      if (state.currentId && updates.some((record) => record.id === state.currentId)) {
        state.playerCoverKey = '';
        renderPlayer();
      }
      if (offset < pending.length) scheduleArtworkBatch();
    };
    scheduleIdleWork(() => { void runBatch(); }, 1500, 900);
  }

  function probeAudioDuration(blob, timeoutMs = 7000) {
    if (!(blob instanceof Blob) || !blob.size) return Promise.resolve(0);
    return new Promise((resolve) => {
      const probe = document.createElement('audio');
      let url;
      try { url = URL.createObjectURL(blob); } catch (_) { resolve(0); return; }
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        probe.removeEventListener('loadedmetadata', onMetadata);
        probe.removeEventListener('durationchange', onMetadata);
        probe.removeEventListener('error', onError);
        try { probe.pause(); probe.removeAttribute('src'); probe.load(); } catch (_) {}
        URL.revokeObjectURL(url);
        const duration = Number(value);
        resolve(Number.isFinite(duration) && duration > 0 ? duration : 0);
      };
      const onMetadata = () => finish(probe.duration);
      const onError = () => finish(0);
      const timer = setTimeout(() => finish(0), timeoutMs);
      probe.preload = 'metadata';
      probe.addEventListener('loadedmetadata', onMetadata, { once: true });
      probe.addEventListener('durationchange', onMetadata, { once: true });
      probe.addEventListener('error', onError, { once: true });
      probe.src = url;
      try { probe.load(); } catch (_) { finish(0); }
    });
  }

  function scheduleMissingDurations(records) {
    const pending = (records || []).filter((record) => record && record.blob instanceof Blob &&
      !(Number(record.duration) > 0) && record.durationChecked !== true);
    if (!pending.length) return;
    let offset = 0;
    const runBatch = async () => {
      const batch = pending.slice(offset, offset + 2);
      offset += batch.length;
      if (!batch.length) return;
      const updates = await Promise.all(batch.map(async (record) => ({
        id: record.id,
        duration: await probeAudioDuration(record.blob),
        durationChecked: true
      })));
      const updateById = new Map(updates.map((item) => [item.id, item]));
      for (const track of state.tracks) {
        const update = updateById.get(track.id);
        if (!update) continue;
        if (update.duration > 0) track.duration = update.duration;
        track.durationChecked = true;
      }
      try {
        const recordsToSave = updates.map((update) => {
          const track = trackById(update.id);
          if (!track) return null;
          return storedShape({ ...track, duration: update.duration || track.duration || 0, durationChecked: true });
        }).filter(Boolean);
        if (recordsToSave.length) await putRecords(recordsToSave);
      } catch (error) {
        console.warn('Audio duration metadata could not be saved', error);
      }
      renderList();
      if (updates.some((item) => item.id === state.currentId)) renderPlayer();
      if (offset < pending.length) scheduleNextBatch();
    };
    scheduleIdleWork(() => { void runBatch(); }, 1800, 700);
  }

  async function importFiles(files) {
    if (!state.db) {
      state.pendingImportPlaylistId = null;
      showToast('Медиатека ещё загружается. Попробуй ещё раз.');
      return;
    }
    const selected = Array.from(files || []).filter(supportedAudio);
    if (!selected.length) {
      state.pendingImportPlaylistId = null;
      showToast('Выбери аудиофайлы в поддерживаемом формате.');
      return;
    }
    const targetPlaylist = playlistById(state.pendingImportPlaylistId);
    const known = new Set();
    state.tracks.forEach((track) => recordDedupKeys(track).forEach((key) => known.add(key)));
    const candidates = [];
    for (const file of selected) {
      const names = parseFilename(file.name);
      const importKey = importKeyFor(file);
      const probe = { name: names.name, artist: names.artist, size: file.size || 0, importKey };
      const keys = recordDedupKeys(probe);
      keys.push(legacyImportKey(file));
      if (keys.some((key) => known.has(key))) continue;
      keys.forEach((key) => known.add(key));
      candidates.push({ file, names, importKey });
    }
    if (!candidates.length) {
      state.pendingImportPlaylistId = null;
      showToast('Эти треки уже есть в медиатеке — дубликаты не добавлены.');
      filePicker.value = '';
      return;
    }
    let added = 0;
    try {
      const records = [];
      for (let offset = 0; offset < candidates.length; offset += 4) {
        const batch = candidates.slice(offset, offset + 4);
        const prepared = await Promise.all(batch.map(async ({ file, names, importKey }) => ({
          id: makeId(), name: names.name, artist: names.artist, blob: file, fileName: file.name || '',
          importKey, coverBlob: await optimizeCoverBlob(await extractEmbeddedCover(file)), coverChecked: true,
          addedAt: Date.now(), duration: 0, durationChecked: false, size: file.size || 0
        })));
        records.push(...prepared);
      }
      if (isNativePlaybackNotificationAvailable()) {
        for (const record of records) {
          try {
            const nativePath = await writeTrackBlobToNative(record);
            if (nativePath) {
              record.nativePath = nativePath;
              record.blob = null;
            }
          } catch (error) {
            console.warn('Could not save imported audio for native playback', error);
          }
        }
      }
      await putRecords(records);
      const attached = records.map(attachUrl);
      state.tracks = attached.concat(state.tracks).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
      if (targetPlaylist) {
        const existingIds = new Set(targetPlaylist.trackIds);
        for (const track of attached) {
          if (!existingIds.has(track.id)) {
            targetPlaylist.trackIds.push(track.id);
            existingIds.add(track.id);
          }
        }
        savePlaylists();
        refreshActivePlaylistPlayback(targetPlaylist);
      }
      scheduleMissingDurations(attached);
      added = records.length;
    } catch (error) {
      console.error(error);
    }
    if (added) notifyLibraryChanged();
    render();
    if (added) showToast('Добавлено: ' + pluralTracks(added) + (added < selected.length ? '. Остальные уже были в медиатеке.' : '.'));
    else showToast('Не удалось сохранить файлы. Проверь свободное место на телефоне.');
    filePicker.value = '';
    if (state.pendingImportPlaylistId) {
      state.pendingImportPlaylistId = null;
      state.view = 'playlists';
      render();
    }
  }

  function saveQueue() {
    try { localStorage.setItem(STORAGE_KEYS.queue, JSON.stringify(state.queue)); } catch (_) {}
    scheduleBackup();
  }

  function enqueue(id) {
    if (!trackById(id)) return;
    if (state.queue.includes(id)) {
      showToast('Этот трек уже в очереди.');
      return;
    }
    state.queue.push(id);
    if (!state.playbackOrder.length) state.playbackOrder = libraryOrderIds();
    saveQueue();
    render();
    showToast('Добавлено в очередь.');
  }

  async function deleteTrack(id) {
    const track = trackById(id);
    if (!track) return;
    const wasCurrent = state.currentId === id || (state.currentRemoteTrack && state.currentRemoteTrack.id === id);
    if (wasCurrent && isNativePlaybackNotificationAvailable()) {
      try { await window.CrimsonPlayback.clear(); } catch (_) {}
      state.nativeQueueOrder = null;
      state.nativeQueueLastKey = '';
    } else if (wasCurrent) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    if (wasCurrent) {
      state.currentId = null;
      state.currentRemoteTrack = null;
      state.isPlaying = false;
    }
    state.tracks = state.tracks.filter((item) => item.id !== id);
    state.queue = state.queue.filter((item) => item !== id);
    state.playbackOrder = state.playbackOrder.filter((item) => item !== id);
    state.playlists.forEach((playlist) => {
      playlist.trackIds = playlist.trackIds.filter((item) => item !== id);
      if (Array.isArray(playlist.refs)) playlist.refs = playlist.refs.filter((ref) => ref.id !== id);
    });
    const activePlaybackPlaylist = playlistById(state.playbackPlaylistId);
    if (activePlaybackPlaylist) refreshActivePlaylistPlayback(activePlaybackPlaylist);
    saveQueue();
    savePlaylists();
    try {
      await removeRecord(id);
      if (isNativePlaybackNotificationAvailable() &&
          window.CrimsonPlayback && typeof window.CrimsonPlayback.deleteTrackFile === 'function') {
        const nativeFiles = [track.nativePath, track.coverPath].filter(Boolean);
        for (const path of new Set(nativeFiles)) {
          try { await window.CrimsonPlayback.deleteTrackFile({ path }); } catch (_) {}
        }
      }
      releaseTrackUrls(track);
      notifyLibraryChanged({ skipReconcile: true });
      render();
      showToast('Трек удалён из медиатеки.');
    } catch (error) {
      showToast('Не удалось удалить трек.');
      await loadLibrary();
    }
  }

  async function playTrack(id, orderIds, playlistId) {
    const track = trackById(id);
    if (!track) return;
    if (arguments.length >= 3) setPlaybackPlaylist(playlistId);
    if (Array.isArray(orderIds)) {
      state.playbackOrder = uniqueTrackIds(orderIds);
      if (!state.playbackOrder.includes(id)) state.playbackOrder.unshift(id);
    } else if (!state.playbackOrder.includes(id)) {
      state.playbackOrder = libraryOrderIds();
      if (!state.playbackOrder.includes(id)) state.playbackOrder.unshift(id);
    }
    const native = isNativePlaybackNotificationAvailable();
    if (state.currentId === id) {
      if (native) {
        if (Array.isArray(orderIds)) {
          state.nativeQueueOrder = null;
          state.nativeQueueLastKey = '';
          await syncNativePlayback(true);
        }
        return togglePlayback();
      }
      if (audio.paused) return togglePlayback();
      state.intentionalPausePending = true;
      audio.pause();
      state.isPlaying = false;
      renderPlayer();
      updatePlayingRows();
      return;
    }
    state.currentId = id;
    state.currentRemoteTrack = null;
    state.seekDragging = false;
    state.pendingSeekTime = null;
    state.nativeQueueOrder = null;
    state.nativeQueueLastKey = '';
    if (native) {
      state.nativePosition = 0;
      state.nativeDuration = Number(track.duration) || 0;
      state.nativePositionUpdatedAt = Date.now();
      state.isPlaying = true;
      state.resumeOnVisible = false;
      // The HTMLAudio element is not the Android transport any more. Stop any old
      // WebView stream before handing the queue to the service-owned ExoPlayer.
      try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch (_) {}
      try {
        await syncNativePlayback(true);
        render();
        updateMediaHandlers();
      } catch (error) {
        state.isPlaying = false;
        render();
        showToast('Не удалось запустить нативный плеер.');
        console.warn('Native playback failed', error);
      }
      updatePlayingRows();
      return;
    }
    audio.src = track.url;
    audio.load();
    render();
    try {
      await audio.play();
      state.isPlaying = true;
      renderPlayer();
      updatePlayingRows();
      updateMediaHandlers();
    } catch (error) {
      state.isPlaying = false;
      renderPlayer();
      updatePlayingRows();
      if (document.hidden) state.resumeOnVisible = true;
      showToast('Не удалось воспроизвести этот файл на устройстве.');
      console.warn('Audio playback failed', error);
    }
  }

  async function togglePlayback() {
    if (!state.currentId && !state.currentRemoteTrack) {
      if (state.queue.length) {
        const firstId = state.queue.shift();
        const order = uniqueTrackIds([firstId, ...state.queue, ...state.playbackOrder]);
        saveQueue();
        await playTrack(firstId, order, null);
      } else {
        const available = playbackIdsForView();
        const firstId = available[0] || (state.tracks[0] && state.tracks[0].id);
        if (firstId) await playTrack(firstId, available.length ? available : libraryOrderIds(), null);
        else {
          filePicker.click();
          showToast('Сначала добавь музыку в медиатеку.');
        }
      }
      return;
    }
    if (isNativePlaybackNotificationAvailable()) {
      const plugin = window.CrimsonPlayback;
      state.nativePosition = currentPlaybackPosition();
      state.nativePositionUpdatedAt = Date.now();
      try {
        if (state.isPlaying) {
          await plugin.pause();
          state.isPlaying = false;
          stopNativeProgressTimer();
        } else {
          await plugin.play();
          state.isPlaying = true;
          startNativeProgressTimer();
        }
        renderPlayer();
        updatePlayingRows();
        void syncNativePlayback(false);
        await refreshNativePlaybackState();
      } catch (error) {
        showToast('Не удалось изменить состояние воспроизведения.');
      }
      return;
    }
    if (audio.paused) {
      try {
        await audio.play();
        state.isPlaying = true;
      } catch (_) {
        showToast('Не удалось продолжить воспроизведение.');
      }
    } else {
      state.intentionalPausePending = true;
      audio.pause();
      state.isPlaying = false;
    }
    renderPlayer();
    updatePlayingRows();
  }

  function orderedIds() {
    const order = uniqueTrackIds(state.playbackOrder);
    return order.length ? order : libraryOrderIds();
  }

  async function nextTrack(fromEnded) {
    if (isNativePlaybackNotificationAvailable()) {
      try {
        await window.CrimsonPlayback.next();
        await refreshNativePlaybackState();
      } catch (_) { showToast('Не удалось переключить следующий трек.'); }
      return;
    }
    if (fromEnded && state.repeat && (state.currentId || state.currentRemoteTrack)) {
      audio.currentTime = 0;
      try { await audio.play(); state.isPlaying = true; } catch (_) { state.isPlaying = false; }
      renderPlayer();
      updatePlayingRows();
      return;
    }
    let nextId = null;
    while (state.queue.length && !nextId) {
      const candidate = state.queue.shift();
      if (trackById(candidate) && candidate !== state.currentId) nextId = candidate;
    }
    saveQueue();
    if (!nextId) {
      const ids = orderedIds();
      if (!ids.length) return;
      if (state.shuffle && ids.length > 1) {
        const candidates = ids.filter((id) => id !== state.currentId);
        nextId = candidates[Math.floor(Math.random() * candidates.length)] || ids[0];
      } else {
        const index = ids.indexOf(state.currentId);
        nextId = ids[(index + 1 + ids.length) % ids.length];
      }
    }
    await playTrack(nextId);
  }

  async function previousTrack() {
    if (isNativePlaybackNotificationAvailable()) {
      try {
        await window.CrimsonPlayback.previous();
        await refreshNativePlaybackState();
      } catch (_) { showToast('Не удалось переключить предыдущий трек.'); }
      return;
    }
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      renderPlayer();
      return;
    }
    const ids = orderedIds();
    if (!ids.length) return;
    const index = ids.indexOf(state.currentId);
    await playTrack(ids[(index - 1 + ids.length) % ids.length]);
  }

  function updateMediaHandlers() {
    if (!('mediaSession' in navigator)) return;
    if (isNativePlaybackNotificationAvailable()) {
      try {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.playbackState = 'none';
        ['play', 'pause', 'previoustrack', 'nexttrack'].forEach((action) => navigator.mediaSession.setActionHandler(action, null));
        state.lastMediaMetadataKey = '';
        state.lastMediaPlaybackState = '';
      } catch (_) {}
      return;
    }
    try {
      navigator.mediaSession.setActionHandler('play', () => togglePlayback());
      navigator.mediaSession.setActionHandler('pause', () => togglePlayback());
      navigator.mediaSession.setActionHandler('previoustrack', () => previousTrack());
      navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack(false));
    } catch (_) {}
  }

  function isNativePlaybackNotificationAvailable() {
    return Boolean(window.CrimsonPlayback && window.Capacitor &&
      typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
  }

  function nativeUriForTrack(track) {
    if (!track) return '';
    const path = String(track.nativePath || '');
    if (path) {
      if (/^(?:file|content|https?):\/\//i.test(path)) return path;
      if (path.startsWith('/')) return fileUriForNativePath(path);
      return path;
    }
    const url = String(track.url || '');
    if (track.isRemote && /^(?:https?|file|content):\/\//i.test(url)) return url;
    return /^https?:\/\//i.test(url) ? url : '';
  }

  function nativeArtworkUriForTrack(track) {
    if (!track) return '';
    if (validCoverUrl(track.coverUrl) && /^https:\/\//i.test(String(track.coverUrl))) return String(track.coverUrl);
    const path = String(track.coverPath || '');
    if (/^(?:file|content):\/\//i.test(path)) return path;
    if (path.startsWith('/')) return fileUriForNativePath(path);
    return '';
  }

  function nativeOrderedTrackIds(current) {
    const currentId = current && String(current.id || '');
    if (!currentId) return [];
    const naturalOrder = orderedIds();
    const naturalSet = new Set(naturalOrder);
    const baseOrder = Array.isArray(state.nativeQueueOrder) && state.nativeQueueOrder.length
      ? state.nativeQueueOrder.filter((id) => id === currentId || Boolean(trackById(id)))
      : naturalOrder;
    const manual = state.queue.filter((id) => trackById(id) && id !== currentId);
    const manualSet = new Set(manual);
    const index = baseOrder.indexOf(currentId);
    const before = index >= 0 ? baseOrder.slice(0, index).filter((id) => !manualSet.has(id)) : [];
    const after = index >= 0
      ? baseOrder.slice(index + 1).filter((id) => !manualSet.has(id) && naturalSet.has(id))
      : baseOrder.filter((id) => id !== currentId && !manualSet.has(id) && naturalSet.has(id));
    const sequence = current.isRemote && index < 0
      ? [currentId, ...manual, ...after]
      : [...before, currentId, ...manual, ...after];
    const seen = new Set();
    return sequence.filter((id) => {
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  function nativeQueuePreviewKey(current) {
    const ids = nativeOrderedTrackIds(current);
    return JSON.stringify({
      currentId: current ? current.id : '',
      tracks: ids.map((id) => {
        const item = current && current.id === id ? current : trackById(id);
        return [id, nativeUriForTrack(item) || (item && item.blob instanceof Blob ? 'blob:' + item.id : ''), nativeArtworkUriForTrack(item)];
      }),
      shuffle: state.shuffle,
      repeat: state.repeat
    });
  }

  function currentPlaybackPosition() {
    if (isNativePlaybackNotificationAvailable()) {
      const since = state.isPlaying && state.nativePositionUpdatedAt && !document.hidden
        ? Math.max(0, (Date.now() - state.nativePositionUpdatedAt) / 1000) : 0;
      return Math.max(0, state.nativePosition + since);
    }
    return Math.max(0, Number(audio.currentTime) || 0);
  }

  function updateSeekVisual(position, duration) {
    const percent = seekProgressPercent(position, duration);
    const seek = $('#seek');
    seek.style.setProperty('--seek-progress', percent.toFixed(2) + '%');
    const current = Number(position) > 0 ? Number(position) : 0;
    seek.setAttribute('aria-valuetext', formatTime(current) + ' из ' + (Number(duration) > 0 ? formatTime(duration) : 'неизвестной длительности'));
  }

  function startNativeProgressTimer() {
    if (state.nativeProgressTimer || !isNativePlaybackNotificationAvailable() || document.hidden || !state.isPlaying) return;
    state.nativeProgressTimer = setInterval(() => {
      if (document.hidden || !state.isPlaying) {
        stopNativeProgressTimer();
        return;
      }
      const duration = state.nativeDuration || Number(currentTrack() && currentTrack().duration) || 0;
      const position = currentPlaybackPosition();
      const displayed = duration > 0 ? Math.min(duration, position) : position;
      $('#elapsed').textContent = formatTime(displayed);
      updateSeekVisual(displayed, duration);
      if (duration > 0 && !state.seekDragging) $('#seek').value = String(Math.round(Math.min(1, displayed / duration) * 1000));
    }, 250);
  }

  function stopNativeProgressTimer() {
    if (state.nativeProgressTimer) clearInterval(state.nativeProgressTimer);
    state.nativeProgressTimer = null;
  }

  async function buildNativeQueue(current) {
    const ids = nativeOrderedTrackIds(current);
    const items = [];
    for (const id of ids) {
      let item = current && current.id === id ? current : trackById(id);
      if (!item) continue;
      if (!item.nativePath && item.blob instanceof Blob) {
        try { item = await ensureNativeTrack(item); }
        catch (error) { console.warn('Could not prepare local audio for native playback', error); }
      }
      item = current && current.id === id ? (currentTrack() || item) : trackById(id);
      if (item && !item.coverPath && !validCoverUrl(item.coverUrl) && item.coverBlob instanceof Blob) {
        try { item = await ensureNativeArtwork(item); }
        catch (error) { console.warn('Could not prepare embedded artwork for native playback', error); }
      }
      item = current && current.id === id ? (currentTrack() || item) : trackById(id);
      const uri = nativeUriForTrack(item);
      if (!uri) continue;
      items.push({
        id: String(item.id),
        uri,
        title: String(item.name || 'Crimson'),
        artist: String(item.artist || 'Неизвестный исполнитель'),
        artworkUri: nativeArtworkUriForTrack(item)
      });
    }
    return items;
  }

  async function syncNativePlayback(force = false) {
    const plugin = window.CrimsonPlayback;
    if (!plugin || !window.Capacitor || typeof window.Capacitor.isNativePlatform !== 'function' ||
        !window.Capacitor.isNativePlatform()) return;
    const track = currentTrack();
    if (!track) {
      stopNativeProgressTimer();
      if (state.nativePlaybackLastKey === 'inactive' && !state.pendingNativeSnapshot) return;
      // Startup may briefly run before a sticky Android media service has restored its
      // queue. Never clear native playback just because the WebView has no current track yet.
      if (typeof plugin.getPlaybackState === 'function') {
        try {
          const snapshot = await plugin.getPlaybackState();
          if (snapshot && snapshot.active && snapshot.currentId) {
            applyNativePlaybackState(snapshot);
            return;
          }
        } catch (_) {}
      }
      state.nativePlaybackLastKey = 'inactive';
      state.nativeQueueLastKey = '';
      state.nativeQueueOrder = null;
      return;
    }

    const coverUrl = validCoverUrl(track.coverUrl) ? track.coverUrl : '';
    const coverPath = String(track.coverPath || '');
    const metadataKey = [track.id, track.name || '', track.artist || '', state.isPlaying ? 'playing' : 'paused', coverUrl, coverPath].join('|');
    if (force || metadataKey !== state.nativePlaybackLastKey) {
      state.nativePlaybackLastKey = metadataKey;
      const duration = state.nativeDuration || Number(track.duration) || 0;
      try {
        await plugin.update({
          active: true,
          title: track.name || 'Crimson',
          artist: track.artist || 'Неизвестный исполнитель',
          playing: state.isPlaying,
          duration,
          coverUrl,
          coverPath
        });
      } catch (_) {}
    }

    if (state.applyingNativeSnapshot) {
      if (state.isPlaying) startNativeProgressTimer();
      else stopNativeProgressTimer();
      return;
    }

    const quickKey = nativeQueuePreviewKey(track);
    if (!force && quickKey === state.nativeQueueLastKey) {
      if (state.isPlaying) startNativeProgressTimer();
      else stopNativeProgressTimer();
      return;
    }
    if (state.nativeQueueSyncPromise) {
      state.nativeQueueSyncRequested = true;
      return state.nativeQueueSyncPromise;
    }

    const task = (async () => {
      const originalCurrentId = String((currentTrack() && currentTrack().id) || '');
      const queueItems = await buildNativeQueue(currentTrack());
      const current = currentTrack();
      if (!current || String(current.id) !== originalCurrentId) {
        state.nativeQueueSyncRequested = true;
        return;
      }
      if (!queueItems.some((item) => item.id === String(current.id))) {
        throw new Error('Не удалось подготовить текущий трек для фонового воспроизведения.');
      }
      const finalPreviewKey = nativeQueuePreviewKey(current);
      if (force || finalPreviewKey !== state.nativeQueueLastKey) {
        await plugin.setQueue({
          itemsJson: JSON.stringify(queueItems),
          currentId: String(current.id),
          positionMs: Math.round(currentPlaybackPosition() * 1000),
          playing: state.isPlaying,
          shuffle: state.shuffle,
          repeat: state.repeat
        });
        state.nativeQueueLastKey = finalPreviewKey;
        state.nativeQueueOrder = queueItems.map((item) => item.id);
      }
    })();
    state.nativeQueueSyncPromise = task;
    try {
      await task;
    } catch (error) {
      console.warn('Native playback queue could not be synchronized', error);
      showToast(error && error.message ? error.message : 'Не удалось подготовить фоновое воспроизведение.');
    } finally {
      state.nativeQueueSyncPromise = null;
      const rerun = state.nativeQueueSyncRequested;
      state.nativeQueueSyncRequested = false;
      if (rerun) void syncNativePlayback(false);
    }
    if (state.isPlaying) startNativeProgressTimer();
    else stopNativeProgressTimer();
  }

  function applyNativePlaybackState(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    const previousTrack = currentTrack();
    const previousTrackId = previousTrack ? String(previousTrack.id || '') : '';
    const previousTitle = previousTrack ? String(previousTrack.name || '') : '';
    const previousArtist = previousTrack ? String(previousTrack.artist || '') : '';
    const previousCover = coverForTrack(previousTrack);
    const previousPlaying = state.isPlaying;
    const previousShuffle = state.shuffle;
    const previousRepeat = state.repeat;
    const previousDuration = state.nativeDuration;
    const previousQueueOrderKey = Array.isArray(state.nativeQueueOrder) ? state.nativeQueueOrder.join('\u001f') : '';
    let currentRemovedFromQueue = false;
    let queueIds = [];
    if (Array.isArray(snapshot.queue)) {
      queueIds = snapshot.queue.map((item) => item && String(item.id || '')).filter(Boolean);
      if (queueIds.length) {
        state.nativeQueueOrder = queueIds;
        if (state.libraryLoaded) state.playbackOrder = uniqueTrackIds(queueIds);
      }
    }
    state.shuffle = Boolean(snapshot.shuffle);
    state.repeat = Boolean(snapshot.repeat);
    const id = String(snapshot.currentId || '');
    if (id) {
      const stored = trackById(id);
      if (!stored && !id.startsWith('youtube:') && !state.libraryLoaded) {
        state.pendingNativeSnapshot = snapshot;
        return;
      }
      if (stored) {
        state.currentId = id;
        state.currentRemoteTrack = null;
        const priorQueueLength = state.queue.length;
        state.queue = state.queue.filter((queuedId) => queuedId !== id);
        currentRemovedFromQueue = state.queue.length !== priorQueueLength;
        if (currentRemovedFromQueue) saveQueue();
      } else if (id.startsWith('youtube:')) {
        const uri = String(snapshot.uri || '');
        const artworkUri = String(snapshot.artworkUri || '');
        state.currentRemoteTrack = {
          id,
          name: String(snapshot.title || 'YouTube'),
          artist: String(snapshot.artist || 'YouTube'),
          duration: Math.max(0, Number(snapshot.durationMs) / 1000 || 0),
          size: 0,
          url: uri,
          isRemote: true,
          coverUrl: /^https:\/\//i.test(artworkUri) ? artworkUri : ''
        };
        state.currentId = null;
      } else if (!state.libraryLoaded) {
        state.pendingNativeSnapshot = snapshot;
        return;
      } else {
        // The native service can survive a WebView, but don't keep playing a stale
        // file if its library record was deleted on disk in a prior app session.
        const plugin = window.CrimsonPlayback;
        state.currentId = null;
        state.currentRemoteTrack = null;
        state.isPlaying = false;
        state.nativeQueueOrder = null;
        state.nativeQueueLastKey = '';
        if (plugin && typeof plugin.clear === 'function') void plugin.clear();
        state.applyingNativeSnapshot = true;
        render();
        updatePlayingRows();
        state.applyingNativeSnapshot = false;
        return;
      }
    } else if (snapshot.active === false) {
      state.currentId = null;
      state.currentRemoteTrack = null;
      state.pendingNativeSnapshot = null;
    }
    state.isPlaying = Boolean(snapshot.playing);
    state.nativePosition = Math.max(0, Number(snapshot.positionMs) / 1000 || 0);
    state.nativeDuration = Math.max(0, Number(snapshot.durationMs) / 1000 || Number(currentTrack() && currentTrack().duration) || 0);
    state.nativePositionUpdatedAt = Date.now();
    state.resumeOnVisible = false;
    if (state.isPlaying) startNativeProgressTimer();
    else stopNativeProgressTimer();
    const activeTrack = currentTrack();
    const activeTrackId = activeTrack ? String(activeTrack.id || '') : '';
    if (activeTrack) state.nativeQueueLastKey = nativeQueuePreviewKey(activeTrack);
    const queueOrderKey = Array.isArray(state.nativeQueueOrder) ? state.nativeQueueOrder.join('\u001f') : '';
    const visibleStateChanged = previousTrackId !== activeTrackId ||
      previousTitle !== String(activeTrack && activeTrack.name || '') ||
      previousArtist !== String(activeTrack && activeTrack.artist || '') ||
      previousCover !== coverForTrack(activeTrack) ||
      previousPlaying !== state.isPlaying ||
      previousShuffle !== state.shuffle ||
      previousRepeat !== state.repeat ||
      previousDuration !== state.nativeDuration ||
      previousQueueOrderKey !== queueOrderKey ||
      currentRemovedFromQueue;
    state.applyingNativeSnapshot = true;
    if (visibleStateChanged) {
      render();
      updatePlayingRows();
    } else {
      const position = currentPlaybackPosition();
      const displayed = state.nativeDuration > 0 ? Math.min(state.nativeDuration, position) : position;
      $('#elapsed').textContent = formatTime(displayed);
      updateSeekVisual(displayed, state.nativeDuration);
      if (!state.seekDragging && state.nativeDuration > 0) {
        $('#seek').value = String(Math.round(Math.min(1, displayed / state.nativeDuration) * 1000));
      }
    }
    state.applyingNativeSnapshot = false;
  }

  async function refreshNativePlaybackState() {
    const plugin = window.CrimsonPlayback;
    if (!isNativePlaybackNotificationAvailable() || !plugin || typeof plugin.getPlaybackState !== 'function') return;
    try {
      applyNativePlaybackState(await plugin.getPlaybackState());
    } catch (_) {}
  }

  function attachNativePlaybackListener() {
    const plugin = window.CrimsonPlayback;
    if (!plugin || state.nativePlaybackListenerAttached || typeof plugin.addListener !== 'function') return;
    state.nativePlaybackListenerAttached = true;
    plugin.addListener('mediaAction', (event) => {
      const action = event && event.action;
      if (isNativePlaybackNotificationAvailable()) {
        void refreshNativePlaybackState();
      } else if (action === 'play' && !state.isPlaying) void togglePlayback();
      else if (action === 'pause' && state.isPlaying) void togglePlayback();
      else if (action === 'previous') void previousTrack();
      else if (action === 'next') void nextTrack(false);
    }).catch(() => { state.nativePlaybackListenerAttached = false; });
    plugin.addListener('nativePlaybackState', (snapshot) => applyNativePlaybackState(snapshot))
      .catch(() => {});
    plugin.addListener('nativePlaybackError', (event) => showToast(String(event && event.message || 'Ошибка воспроизведения.')))
      .catch(() => {});
    updateMediaHandlers();
    void syncNativePlayback(true);
    if (!document.hidden) void refreshNativePlaybackState();
  }

  window.addEventListener('crimson-playback-ready', attachNativePlaybackListener);
  attachNativePlaybackListener();

  function importDialog(playlistId = null) {
    state.pendingImportPlaylistId = playlistId && playlistById(playlistId) ? playlistId : null;
    filePicker.click();
  }

  document.querySelectorAll('.nav-item[data-view]').forEach((button) => {
    button.addEventListener('click', () => {
      state.view = button.dataset.view || 'library';
      render();
      if (state.view === 'youtube') void refreshYtDlpStatus();
      if (state.view === 'settings') { void refreshFolderSettings(); void refreshExternalLibrary({ silent: true }); }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });

  $('#chooseLibraryFolder').addEventListener('click', chooseLibraryFolder);
  // Упрощённые анимации: сохраняются в настройках; включаются автоматически при системной настройке «уменьшить движение».
  function applyLiteMotion(enabled) { document.documentElement.classList.toggle('lite-motion', Boolean(enabled)); }
  (function initLiteMotion() {
    let stored = null;
    try { stored = localStorage.getItem(LITE_MOTION_KEY); } catch (_) {}
    const enabled = stored === null ? Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) : stored === '1';
    applyLiteMotion(enabled);
    const toggle = $('#liteMotion');
    toggle.checked = enabled;
    toggle.addEventListener('change', () => { try { localStorage.setItem(LITE_MOTION_KEY, toggle.checked ? '1' : '0'); } catch (_) {} applyLiteMotion(toggle.checked); scheduleBackup(); });
  })();

  const concurrencySelect = $('#downloadConcurrency');
  concurrencySelect.value = String(downloadQueue.concurrency);
  concurrencySelect.addEventListener('change', () => {
    const value = clampConcurrency(concurrencySelect.value);
    try { localStorage.setItem(STORAGE_KEYS.downloadConcurrency, String(value)); } catch (_) {}
    downloadQueue.setConcurrency(value);
    scheduleBackup();
  });
  document.querySelectorAll('.scan-cancel').forEach((button) => button.addEventListener('click', () => { void cancelLibraryScan(); }));
  $('#exportPlaylists').addEventListener('click', () => { void exportPlaylistsFile(); });
  $('#importPlaylists').addEventListener('click', () => { void importPlaylistsFile(); });
  $('#backupNow').addEventListener('click', async () => { const r = await saveBackupNow(); showToast(r ? 'Резервная копия создана.' : 'Резервная копия недоступна в этой среде.'); });
  $('#restoreBackup').addEventListener('click', () => { void restoreFromBackup(); });
  $('#restoreBackupFile').addEventListener('click', () => { void restoreFromChosenFile(); });
  $('#checkIntegrity').addEventListener('click', () => { void runIntegrityCheck(); });
  $('#repairMetadata').addEventListener('click', () => { void repairLibraryMetadata(); });
  $('#undoMetadataRepair').addEventListener('click', () => { void undoMetadataRepair(); });
  $('#wipeData').addEventListener('click', () => { void wipeAllUserData(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void saveBackupNow(); });
  $('#refreshLibraryFolder').addEventListener('click', () => refreshExternalLibrary({ force: true }));
  $('#chooseDownloadFolder').addEventListener('click', chooseDownloadFolder);
  $('#resetDownloadFolder').addEventListener('click', resetDownloadFolder);

  $('#copyDiagnosticLog').addEventListener('click', async () => {
    const plugin = window.CrimsonPlayback;
    const status = $('#diagnosticStatus');
    const field = $('#diagnosticLogText');
    if (!plugin || typeof plugin.getDiagnosticLog !== 'function') {
      status.textContent = 'Журнал доступен только в установленном Android APK.';
      showToast('Диагностика доступна только в APK.');
      return;
    }
    try {
      const result = await plugin.getDiagnosticLog();
      const report = String(result && result.text || '');
      field.value = report;
      field.classList.toggle('hidden', !report);
      if (!report.trim()) {
        status.textContent = 'Журнал пуст. Если приложение снова закроется, открой этот экран и скопируй журнал.';
        showToast('Записей об ошибках пока нет.');
        return;
      }
      status.textContent = 'Последний журнал содержит ' + report.length + ' символов. Данные остаются на устройстве.';
      let copied = false;
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(report);
          copied = true;
        }
      } catch (_) {}
      if (!copied) {
        field.classList.remove('hidden');
        field.focus();
        field.select();
        try { copied = document.execCommand('copy'); } catch (_) {}
      }
      showToast(copied ? 'Журнал скопирован. Пришли его сюда.' : 'Журнал открыт ниже — выдели и скопируй его.');
    } catch (error) {
      status.textContent = 'Не удалось получить журнал: ' + (error && error.message || error);
      showToast('Не удалось прочитать журнал диагностики.');
    }
  });

  $('#clearDiagnosticLog').addEventListener('click', async () => {
    const plugin = window.CrimsonPlayback;
    if (!plugin || typeof plugin.clearDiagnosticLog !== 'function') {
      showToast('Очистка доступна только в установленном Android APK.');
      return;
    }
    try {
      await plugin.clearDiagnosticLog();
      $('#diagnosticLogText').value = '';
      $('#diagnosticLogText').classList.add('hidden');
      $('#diagnosticStatus').textContent = 'Журнал очищен.';
      showToast('Журнал диагностики очищен.');
    } catch (_) {
      showToast('Не удалось очистить журнал диагностики.');
    }
  });

  $('#importTop').addEventListener('click', importDialog);
  filePicker.addEventListener('change', () => importFiles(filePicker.files));
  function setSortMode(mode) {
    state.sortMode = SORT_MODES.includes(mode) ? mode : 'recent';
    state.renderLimit = 150;
    try { localStorage.setItem(STORAGE_KEYS.sort, state.sortMode); } catch (_) {}
    scheduleBackup();
    renderList();
  }
  $('#filterBar').addEventListener('click', (event) => {
    const button = event.target.closest('[data-sort]');
    if (button) setSortMode(button.dataset.sort);
  });
  $('#filterBar').addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const index = SORT_MODES.indexOf(state.sortMode);
    const next = SORT_MODES[(index + (event.key === 'ArrowRight' ? 1 : SORT_MODES.length - 1)) % SORT_MODES.length];
    setSortMode(next);
    $('#filterBar [data-sort="' + next + '"]').focus();
  });
  $('#activeFilters').addEventListener('click', (event) => {
    const target = event.target.closest('[data-clear]');
    if (!target) return;
    const what = target.dataset.clear;
    if (what === 'query' || what === 'all') { state.query = ''; $('#searchInput').value = ''; }
    if (what === 'sort' || what === 'all') setSortMode('recent'); else { state.renderLimit = 150; renderList(); }
  });
  $('#searchInput').addEventListener('input', (event) => {
    state.query = event.currentTarget.value || '';
    state.renderLimit = 150;
    clearTimeout(state.searchRenderTimer);
    state.searchRenderTimer = setTimeout(renderList, 70);
  });

  let suppressTrackClickUntil = 0;
  let suppressTrackClickId = '';
  let trackSwipeGesture = null;
  function stopSwipeFrame(gesture) {
    if (!gesture) return;
    gesture.finished = true;
    if (gesture.frame) { cancelAnimationFrame(gesture.frame); gesture.frame = 0; }
  }

  function resetTrackSwipeRow(row) {
    if (!row || (!row.classList.contains('track-swipe-active') && !row.style.getPropertyValue('--swipe-offset'))) return;
    row.classList.remove('track-swipe-active', 'track-swipe-ready');
    row.classList.add('track-swipe-settling');
    row.style.setProperty('--swipe-offset', '0px');
    row.style.setProperty('--swipe-progress', '0');
    setTimeout(() => {
      row.classList.remove('track-swipe-settling');
      row.style.removeProperty('--swipe-offset');
      row.style.removeProperty('--swipe-progress');
    }, 230);
  }

  function completeTrackSwipe(gesture) {
    const sourcePlaylistId = gesture.sourcePlaylistId;
    const target = resolveSwipePlaylist(state.playlists, state.quickAddPlaylistId, sourcePlaylistId);
    if (target && !target.trackIds.includes(gesture.trackId)) {
      addTrackToPlaylist(target.id, gesture.trackId, { undoable: true });
      return true;
    }
    if (target && target.trackIds.includes(gesture.trackId)) {
      const anotherAvailable = state.playlists.some((playlist) => playlist.id !== sourcePlaylistId && !playlist.trackIds.includes(gesture.trackId));
      if (!anotherAvailable) {
        showToast('Этот трек уже есть в выбранном плейлисте.');
        return;
      }
    }
    openAddToPlaylistDialog(gesture.trackId, sourcePlaylistId);
  }

  function enableTrackPlaylistSwipe(container) {
    container.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
      if (event.target.closest('button, summary, details, input, select, textarea, a, [data-reorder-handle]')) return;
      const row = event.target.closest('.track-row[data-track], .track-row[data-playlist-track]');
      if (!row) return;
      const trackId = row.dataset.track || row.dataset.playlistTrack || '';
      if (!trackId) return;
      trackSwipeGesture = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        trackId,
        sourcePlaylistId: row.dataset.playlistTrack ? state.currentPlaylistId : null,
        row,
        active: false
      };
    });
  }

  enableTrackPlaylistSwipe($('#trackList'));
  enableTrackPlaylistSwipe($('#playlistContent'));

  document.addEventListener('pointermove', (event) => {
    const gesture = trackSwipeGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    const direction = classifyTrackSwipe(dx, dy);
    if (direction === 'vertical' || direction === 'left') {
      trackSwipeGesture = null; stopSwipeFrame(gesture);
      resetTrackSwipeRow(gesture.row);
      return;
    }
    if (direction === 'right' || direction === 'commit') {
      gesture.active = true;
      event.preventDefault();
      const visual = swipeVisual(dx);
      const wasArmed = gesture.armed;
      gesture.armed = visual.armed;
      if (visual.armed && !wasArmed && navigator.vibrate) { try { navigator.vibrate(10); } catch (_) {} }
      // Стили записываются не чаще одного раза за кадр, а не при каждом pointermove (их приходит больше, чем кадров).
      gesture.pendingVisual = visual;
      if (!gesture.frame) {
        gesture.frame = requestAnimationFrame(() => {
          gesture.frame = 0;
          const v = gesture.pendingVisual;
          if (!v || gesture.finished) return;
          gesture.row.classList.add('track-swipe-active');
          gesture.row.classList.toggle('track-swipe-ready', v.armed);
          gesture.row.style.setProperty('--swipe-offset', v.offset + 'px');
          gesture.row.style.setProperty('--swipe-progress', String(v.progress));
        });
      }
    }
  }, { passive: false });

  document.addEventListener('pointerup', (event) => {
    const gesture = trackSwipeGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    trackSwipeGesture = null; stopSwipeFrame(gesture);
    const dx = event.clientX - gesture.startX;
    const dy = event.clientY - gesture.startY;
    const committed = classifyTrackSwipe(dx, dy) === 'commit';
    if (committed) {
      event.preventDefault();
      suppressTrackClickId = gesture.trackId;
      suppressTrackClickUntil = Date.now() + 650;
      gesture.row.classList.add('track-swipe-settling');
      gesture.row.style.setProperty('--swipe-offset', '0px');
      setTimeout(() => {
        gesture.row.classList.remove('track-swipe-active', 'track-swipe-settling', 'track-swipe-ready');
        gesture.row.style.removeProperty('--swipe-offset');
        gesture.row.style.removeProperty('--swipe-progress');
      }, 230);
      const added = completeTrackSwipe(gesture);
      if (added) {
        // Короткое подтверждение: галочка и подсветка строки, затем строка уже вернулась на место.
        gesture.row.classList.add('track-swipe-added');
        setTimeout(() => gesture.row.classList.remove('track-swipe-added'), 900);
      }
    } else {
      resetTrackSwipeRow(gesture.row);
    }
  });

  document.addEventListener('pointercancel', (event) => {
    const gesture = trackSwipeGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    trackSwipeGesture = null; stopSwipeFrame(gesture);
    resetTrackSwipeRow(gesture.row);
  });

  function suppressSwipeClick(event) {
    if (Date.now() > suppressTrackClickUntil || !suppressTrackClickId) return false;
    const row = event.target.closest('.track-row[data-track], .track-row[data-playlist-track]');
    const id = row && (row.dataset.track || row.dataset.playlistTrack || '');
    if (id !== suppressTrackClickId) return false;
    event.preventDefault();
    suppressTrackClickUntil = 0;
    suppressTrackClickId = '';
    return true;
  }

  // Меню «⋮»: не выходит за экран и не заходит под мини-плеер. Позиция считается один раз при открытии.
  function placeTrackMenu(menu) {
    const popover = menu.querySelector('.track-context-popover, .playlist-track-menu-popover');
    if (!popover) return;
    menu.classList.remove('menu-up');
    popover.style.removeProperty('--menu-shift');
    const dock = document.querySelector('#player');
    const bottomLimit = Math.min(window.innerHeight, dock ? dock.getBoundingClientRect().top : window.innerHeight) - 8;
    let rect = popover.getBoundingClientRect();
    const summary = menu.querySelector('summary').getBoundingClientRect();
    if (rect.bottom > bottomLimit && summary.top - rect.height - 5 > 8) menu.classList.add('menu-up');
    rect = popover.getBoundingClientRect();
    let shift = 0;
    if (rect.left < 8) shift = 8 - rect.left;
    else if (rect.right > window.innerWidth - 8) shift = window.innerWidth - 8 - rect.right;
    if (shift) popover.style.setProperty('--menu-shift', shift + 'px');
  }
  document.addEventListener('toggle', (event) => {
    const menu = event.target;
    if (menu && menu.matches && menu.matches('.track-context-menu[open], .playlist-track-menu[open]')) placeTrackMenu(menu);
  }, true);

  // Keep only one kebab menu open and close it when the user taps elsewhere.
  document.addEventListener('click', (event) => {
    const activeMenu = event.target.closest('.track-context-menu, .playlist-track-menu');
    document.querySelectorAll('.track-context-menu[open], .playlist-track-menu[open]').forEach((menu) => {
      if (menu !== activeMenu) menu.open = false;
    });
  }, true);

  $('#trackList').addEventListener('click', (event) => {
    if (suppressSwipeClick(event)) return;
    const goLibrary = event.target.closest('[data-go-library]');
    if (goLibrary) {
      state.view = 'library';
      state.query = '';
      $('#searchInput').value = '';
      render();
      return;
    }
    const importButton = event.target.closest('[data-import]');
    if (importButton) {
      importDialog();
      return;
    }
    const action = event.target.closest('[data-action]');
    if (!action) return;
    const id = action.dataset.id;
    const contextMenu = action.closest('.track-context-menu');
    if (contextMenu) contextMenu.open = false;
    switch (action.dataset.action) {
      case 'play':
        if (state.view === 'queue' && currentTrack() && currentTrack().id === id) {
          void togglePlayback();
          break;
        }
        if (state.view === 'queue') {
          const queueIndex = state.queue.indexOf(id);
          if (queueIndex >= 0) {
            const remaining = state.queue.slice(queueIndex + 1);
            const playback = uniqueTrackIds([id, ...remaining, ...state.playbackOrder]);
            state.queue = remaining;
            saveQueue();
            playTrack(id, playback, null);
          } else playTrack(id, playbackIdsForView(), null);
        } else playTrack(id, playbackIdsForView(), null);
        break;
      case 'enqueue': enqueue(id); break;
      case 'add-to-playlist': openAddToPlaylistDialog(id); break;
      case 'remove-queue':
        state.queue = state.queue.filter((item) => item !== id);
        saveQueue();
        render();
        break;
    }
  });

  $('#playlistSearchInput').addEventListener('input', (event) => {
    state.playlistQuery = event.currentTarget.value;
    renderPlaylists();
  });

  $('#playlistContent').addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-action="play"]')) {
      event.preventDefault();
      const playlist = playlistById(state.currentPlaylistId);
      playTrack(event.target.dataset.id, playlist ? playlist.trackIds : libraryOrderIds(), playlist ? playlist.id : null);
    }
  });

  $('#trackList').addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-action="play"]')) {
      event.preventDefault();
      event.target.click();
    }
  });

  $('#closeFullPlayer').addEventListener('click', () => setPlayerFullscreen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && $('#player').classList.contains('player-fullscreen')) {
      event.preventDefault();
      setPlayerFullscreen(false);
    }
  });

  const cover = $('#playerCover');
  let miniPlayerPointerStart = null;
  let suppressCoverTapUntil = 0;
  let suppressPlayClickUntil = 0;
  const player = $('#player');
  player.addEventListener('pointerdown', (event) => {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    const fullscreen = player.classList.contains('player-fullscreen');
    const interactive = event.target.closest('button, input, select, textarea, a');
    const isMiniPlayButton = !fullscreen && interactive && interactive.id === 'playPause';
    if (interactive && !isMiniPlayButton) return;
    // In the mini-player, horizontal swipes work across the whole dock. In the
    // expanded player, keep the original cover-only swipe interaction.
    if (fullscreen && !event.target.closest('#playerCover')) return;
    miniPlayerPointerStart = {
      x: event.clientX,
      y: event.clientY,
      fullscreen,
      startedOnCover: Boolean(event.target.closest('#playerCover')),
      startedOnPlayButton: Boolean(isMiniPlayButton)
    };
  });
  player.addEventListener('pointerup', (event) => {
    if (!miniPlayerPointerStart) return;
    const start = miniPlayerPointerStart;
    miniPlayerPointerStart = null;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
    event.preventDefault();
    if (start.startedOnCover) suppressCoverTapUntil = Date.now() + 450;
    if (start.startedOnPlayButton) suppressPlayClickUntil = Date.now() + 450;
    if (dx < 0) void nextTrack(false);
    else void previousTrack();
  });
  player.addEventListener('pointercancel', () => { miniPlayerPointerStart = null; });
  cover.addEventListener('click', (event) => {
    if (Date.now() < suppressCoverTapUntil) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (!player.classList.contains('player-fullscreen')) setPlayerFullscreen(true);
  });
  cover.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && !player.classList.contains('player-fullscreen')) {
      event.preventDefault();
      setPlayerFullscreen(true);
    }
  });

  $('#queueFromCurrent').addEventListener('click', () => enqueueTracksFromCurrent(
    libraryOrderIds(), 'медиатека', null));

  $('#createPlaylist').addEventListener('click', () => openPlaylistNameDialog(null));
  $('#cancelPlaylistName').addEventListener('click', () => {
    state.pendingPlaylistTrackId = null;
    state.editingPlaylistId = null;
    $('#playlistNameDialog').close();
  });
  $('#playlistNameForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const wasEditing = Boolean(state.editingPlaylistId);
    const name = $('#playlistNameInput').value.trim();
    if (!name) { $('#playlistNameInput').focus(); return; }
    if (state.editingPlaylistId) {
      const playlist = playlistById(state.editingPlaylistId);
      if (playlist) playlist.name = name.slice(0, 60);
    } else {
      const playlist = { id: makeId(), name: name.slice(0, 60), trackIds: [], createdAt: Date.now() };
      state.playlists.unshift(playlist);
      state.currentPlaylistId = playlist.id;
      if (state.pendingPlaylistTrackId) {
        playlist.trackIds.push(state.pendingPlaylistTrackId);
        saveQuickAddPlaylist(playlist.id);
        state.pendingPlaylistTrackId = null;
        $('#addToPlaylistDialog').close();
      }
    }
    savePlaylists();
    $('#playlistNameDialog').close();
    state.view = 'playlists';
    render();
    showToast(wasEditing ? 'Название плейлиста обновлено.' : 'Плейлист создан.');
    state.editingPlaylistId = null;
  });

  $('#cancelAddToPlaylist').addEventListener('click', () => { state.pendingPlaylistTrackId = null; $('#addToPlaylistDialog').close(); });
  $('#addToPlaylistDialog').addEventListener('cancel', () => { state.pendingPlaylistTrackId = null; });
  $('#createFromAddPlaylist').addEventListener('click', () => {
    $('#addToPlaylistDialog').close();
    openPlaylistNameDialog(null);
  });
  $('#playlistNameDialog').addEventListener('cancel', () => {
    if (!state.editingPlaylistId) state.pendingPlaylistTrackId = null;
  });
  $('#addToPlaylistForm').addEventListener('submit', (event) => {
    event.preventDefault();
    const playlistId = $('#playlistTargetSelect').value;
    const trackId = state.pendingPlaylistTrackId;
    if (playlistId && trackId) {
      saveQuickAddPlaylist(playlistId);
      addTrackToPlaylist(playlistId, trackId);
    }
    state.pendingPlaylistTrackId = null;
    $('#addToPlaylistDialog').close();
  });

  // Pointer-based sorting works with a mouse, stylus and Android touch input.
  // The dedicated grip keeps ordinary vertical scrolling and track taps unaffected.
  let playlistPointerDrag = null;

  function clearPlaylistDropTargets() {
    document.querySelectorAll('#playlistContent .playlist-drop-before, #playlistContent .playlist-drop-after')
      .forEach((row) => row.classList.remove('playlist-drop-before', 'playlist-drop-after'));
  }

  function clearPlaylistDropIndicators() {
    clearPlaylistDropTargets();
    document.querySelectorAll('#playlistContent .playlist-reorder-source')
      .forEach((row) => row.classList.remove('playlist-reorder-source'));
  }

  function updatePlaylistPointerTarget(clientX, clientY) {
    if (!playlistPointerDrag) return;
    clearPlaylistDropTargets();
    const list = $('#playlistContent [data-playlist-track-list]');
    if (!list) { playlistPointerDrag.targetId = ''; return; }
    const element = document.elementFromPoint(clientX, clientY);
    const target = element && element.closest('.track-row[data-playlist-track]');
    const sourceId = playlistPointerDrag.trackId;
    if (target && target.dataset.playlistTrack !== sourceId && list.contains(target)) {
      const rect = target.getBoundingClientRect();
      const placement = clientY < rect.top + rect.height / 2 ? 'before' : 'after';
      target.classList.add(placement === 'before' ? 'playlist-drop-before' : 'playlist-drop-after');
      playlistPointerDrag.targetId = target.dataset.playlistTrack;
      playlistPointerDrag.placement = placement;
      return;
    }
    const rows = Array.from(list.querySelectorAll('.track-row[data-playlist-track]'));
    const sourceRow = rows.find((row) => row.dataset.playlistTrack === sourceId);
    if (!rows.length || !sourceRow) { playlistPointerDrag.targetId = ''; return; }
    const first = rows[0];
    const last = rows[rows.length - 1];
    if (clientY < first.getBoundingClientRect().top) {
      if (first.dataset.playlistTrack !== sourceId) {
        first.classList.add('playlist-drop-before');
        playlistPointerDrag.targetId = first.dataset.playlistTrack;
        playlistPointerDrag.placement = 'before';
      } else playlistPointerDrag.targetId = '';
    } else if (clientY > last.getBoundingClientRect().bottom) {
      if (last.dataset.playlistTrack !== sourceId) {
        last.classList.add('playlist-drop-after');
        playlistPointerDrag.targetId = last.dataset.playlistTrack;
        playlistPointerDrag.placement = 'after';
      } else playlistPointerDrag.targetId = '';
    } else {
      playlistPointerDrag.targetId = '';
    }
  }

  $('#playlistContent').addEventListener('pointerdown', (event) => {
    const handle = event.target.closest('[data-reorder-handle]');
    const row = handle && handle.closest('.track-row[data-playlist-track]');
    const playlist = playlistById(state.currentPlaylistId);
    if (!handle || !row || !playlist || !event.isPrimary ||
        (event.pointerType === 'mouse' && event.button !== 0)) return;
    playlistPointerDrag = {
      pointerId: event.pointerId,
      playlistId: playlist.id,
      trackId: row.dataset.playlistTrack,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      targetId: '',
      placement: 'before',
      sourceRow: row,
      handle
    };
    try { handle.setPointerCapture(event.pointerId); } catch (_) {}
  });

  document.addEventListener('pointermove', (event) => {
    const drag = playlistPointerDrag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.active && distance < 7) return;
    if (!drag.active) {
      drag.active = true;
      drag.sourceRow.classList.add('playlist-reorder-source');
      document.body.classList.add('playlist-reordering');
    }
    event.preventDefault();
    const edge = 64;
    if (event.clientY < edge) window.scrollBy(0, -14);
    else if (event.clientY > window.innerHeight - edge) window.scrollBy(0, 14);
    updatePlaylistPointerTarget(event.clientX, event.clientY);
  }, { passive: false });

  function finishPlaylistPointerDrag(event, cancelled = false) {
    const drag = playlistPointerDrag;
    if (!drag || (event && drag.pointerId !== event.pointerId)) return;
    playlistPointerDrag = null;
    clearPlaylistDropIndicators();
    document.body.classList.remove('playlist-reordering');
    if (!drag.active) return;
    if (!cancelled && drag.targetId) {
      const playlist = playlistById(drag.playlistId);
      const next = playlist && movePlaylistTrack(
        uniqueTrackIds(playlist.trackIds), drag.trackId, drag.targetId, drag.placement
      );
      if (next) persistPlaylistOrder(playlist, next, 'Порядок плейлиста сохранён.');
    }
    suppressTrackClickUntil = Date.now() + 450;
    suppressTrackClickId = drag.trackId;
  }

  document.addEventListener('pointerup', (event) => finishPlaylistPointerDrag(event, false));
  document.addEventListener('pointercancel', (event) => finishPlaylistPointerDrag(event, true));

  $('#playlistContent').addEventListener('dragover', (event) => {
    if (event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files')) {
      event.preventDefault();
      const target = event.target.closest('[data-playlist-drop], [data-playlist-card]');
      if (target) target.classList.add('playlist-drop-active');
    }
  });
  $('#playlistContent').addEventListener('dragleave', (event) => {
    const target = event.target.closest('[data-playlist-drop], [data-playlist-card]');
    if (target && !target.contains(event.relatedTarget)) target.classList.remove('playlist-drop-active');
  });
  $('#playlistContent').addEventListener('drop', (event) => {
    const target = event.target.closest('[data-playlist-drop], [data-playlist-card]');
    if (!target || !event.dataTransfer || !event.dataTransfer.files || !event.dataTransfer.files.length) return;
    event.preventDefault();
    target.classList.remove('playlist-drop-active');
    const playlistId = target.dataset.playlistDrop || target.dataset.playlistCard;
    if (!playlistById(playlistId)) return;
    state.pendingImportPlaylistId = playlistId;
    void importFiles(event.dataTransfer.files);
  });

  $('#playlistContent').addEventListener('click', (event) => {
    if (suppressSwipeClick(event)) return;
    const action = event.target.closest('[data-playlist-action]');
    if (!action) {
      const trackAction = event.target.closest('[data-action]');
      if (!trackAction) return;
      const id = trackAction.dataset.id;
      if (trackAction.dataset.action === 'play') {
        const playlist = playlistById(state.currentPlaylistId);
        playTrack(id, playlist ? playlist.trackIds : libraryOrderIds(), playlist ? playlist.id : null);
      } else if (trackAction.dataset.action === 'enqueue') enqueue(id);
      return;
    }
    const id = action.dataset.id;
    const actionType = action.dataset.playlistAction;
    const isTrackOrderAction = ['remove-track', 'move-up', 'move-down', 'set-position', 'enqueue-track'].includes(actionType);
    const playlist = isTrackOrderAction
      ? playlistById(state.currentPlaylistId)
      : (id ? playlistById(id) : playlistById(state.currentPlaylistId));
    switch (actionType) {
      case 'create': openPlaylistNameDialog(null); break;
      case 'add-music':
        if (playlist) importDialog(playlist.id);
        break;
      case 'open': state.currentPlaylistId = id; renderPlaylists(); break;
      case 'back': state.currentPlaylistId = null; renderPlaylists(); break;
      case 'rename': openPlaylistNameDialog(id); break;
      case 'delete':
        if (playlist && window.confirm('Удалить плейлист «' + playlist.name + '»? Сами аудиофайлы останутся в медиатеке.')) {
          state.playlists = state.playlists.filter((item) => item.id !== playlist.id);
          if (state.quickAddPlaylistId === playlist.id) saveQuickAddPlaylist(null);
          if (state.playbackPlaylistId === playlist.id) setPlaybackPlaylist(null);
          state.currentPlaylistId = null;
          savePlaylists();
          render();
          showToast('Плейлист удалён.');
        }
        break;
      case 'add-to-playlist':
        action.closest('details') && (action.closest('details').open = false);
        openAddToPlaylistDialog(action.dataset.id, state.currentPlaylistId);
        break;
      case 'enqueue-track':
        enqueue(action.dataset.id);
        break;
      case 'move-up':
        movePlaylistTrackBy(playlist, action.dataset.id, -1);
        break;
      case 'move-down':
        movePlaylistTrackBy(playlist, action.dataset.id, 1);
        break;
      case 'set-position':
        movePlaylistTrackToUserPosition(playlist, action.dataset.id);
        break;
      case 'remove-track':
        if (playlist) {
          playlist.trackIds = playlist.trackIds.filter((trackId) => trackId !== action.dataset.id);
          savePlaylists();
          refreshActivePlaylistPlayback(playlist);
          renderPlaylists();
          showToast('Трек убран из плейлиста.');
        }
        break;
      case 'play-all':
        if (playlist) {
          const ids = uniqueTrackIds(playlist.trackIds);
          if (!ids.length) { showToast('Сначала добавь треки в плейлист.'); break; }
          state.currentPlaylistId = playlist.id;
          setPlaybackPlaylist(playlist.id);
          const startId = ids.includes(state.currentId) ? state.currentId : ids[0];
          const currentlyPlaying = isNativePlaybackNotificationAvailable() ? state.isPlaying : !audio.paused;
          if (state.currentId === startId && currentlyPlaying) {
            state.playbackOrder = ids;
            state.nativeQueueOrder = null;
            state.nativeQueueLastKey = '';
            void syncNativePlayback(true);
            showToast('Порядок плейлиста активен.');
          } else void playTrack(startId, ids, playlist.id);
        }
        break;
      case 'enqueue-from-current':
        if (playlist) enqueueTracksFromCurrent(playlist.trackIds, playlist.name, playlist.id);
        break;
    }
  });

  $('#playPause').addEventListener('click', (event) => {
    if (Date.now() < suppressPlayClickUntil) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    togglePlayback();
  });
  $('#previous').addEventListener('click', previousTrack);
  $('#next').addEventListener('click', () => nextTrack(false));
  $('#shuffle').addEventListener('click', () => {
    state.shuffle = !state.shuffle;
    renderPlayer();
    showToast(state.shuffle ? 'Случайный порядок включён.' : 'Обычный порядок включён.');
  });
  $('#repeat').addEventListener('click', () => {
    state.repeat = !state.repeat;
    renderPlayer();
    showToast(state.repeat ? 'Повтор текущего трека включён.' : 'Повтор выключен.');
  });

  $('#seek').addEventListener('pointerdown', () => { state.seekDragging = true; });
  $('#seek').addEventListener('pointerup', () => { state.seekDragging = false; });
  $('#seek').addEventListener('pointercancel', () => { state.seekDragging = false; renderPlayer(); });
  $('#seek').addEventListener('input', (event) => {
    state.seekDragging = true;
    const track = currentTrack();
    const audioDuration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    const duration = isNativePlaybackNotificationAvailable()
      ? (state.nativeDuration || Number(track && track.duration) || 0)
      : (audioDuration || Number(track && track.duration) || 0);
    if (duration > 0) {
      const target = (Number(event.currentTarget.value) / 1000) * duration;
      $('#elapsed').textContent = formatTime(target);
      updateSeekVisual(target, duration);
    }
  });
  $('#seek').addEventListener('change', async (event) => {
    const track = currentTrack();
    const audioDuration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
    const duration = isNativePlaybackNotificationAvailable()
      ? (state.nativeDuration || Number(track && track.duration) || 0)
      : (audioDuration || Number(track && track.duration) || 0);
    if (duration > 0) {
      const target = (Number(event.currentTarget.value) / 1000) * duration;
      if (isNativePlaybackNotificationAvailable()) {
        state.nativePosition = target;
        state.nativePositionUpdatedAt = Date.now();
        try { await window.CrimsonPlayback.seekTo({ positionMs: Math.round(target * 1000) }); }
        catch (_) { showToast('Не удалось перемотать трек.'); }
      } else {
        try {
          audio.currentTime = target;
          state.pendingSeekTime = null;
        } catch (_) {
          state.pendingSeekTime = target;
        }
      }
      updateSeekVisual(target, duration);
    }
    state.seekDragging = false;
    renderPlayer();
  });

  audio.addEventListener('play', () => {
    if (isNativePlaybackNotificationAvailable()) return;
    state.isPlaying = true;
    state.resumeOnVisible = false;
    renderPlayer();
    updatePlayingRows();
  });
  audio.addEventListener('pause', () => {
    if (isNativePlaybackNotificationAvailable()) return;
    // A natural end also transitions the element to paused. Avoid publishing a
    // temporary pause before the ended handler starts the next track.
    if (audio.ended) return;
    if (state.intentionalPausePending) {
      state.intentionalPausePending = false;
      state.isPlaying = false;
      return;
    }
    // If Android/WebView suspends a playing element, retry when the app returns.
    if (document.hidden && currentTrack()) state.resumeOnVisible = true;
    state.isPlaying = false;
    renderPlayer();
    updatePlayingRows();
  });
  audio.addEventListener('timeupdate', () => {
    if (isNativePlaybackNotificationAvailable()) return;
    if (state.seekDragging) return;
    const currentTime = audio.currentTime || 0;
    const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Number(currentTrack() && currentTrack().duration) || 0;
    const displayed = duration > 0 ? Math.min(duration, currentTime) : currentTime;
    $('#elapsed').textContent = formatTime(displayed);
    updateSeekVisual(displayed, duration);
    if (duration > 0) $('#seek').value = String(Math.round((displayed / duration) * 1000));
  });
  audio.addEventListener('loadedmetadata', async () => {
    if (isNativePlaybackNotificationAvailable()) return;
    if (state.pendingSeekTime !== null && Number.isFinite(audio.duration) && audio.duration > 0) {
      try { audio.currentTime = Math.min(audio.duration, Math.max(0, state.pendingSeekTime)); } catch (_) {}
      state.pendingSeekTime = null;
    }
    const track = currentTrack();
    if (track && !track.isRemote && state.currentId && Number.isFinite(audio.duration) && audio.duration > 0) {
      track.duration = audio.duration;
      track.durationChecked = true;
      try { await putRecord(storedShape(track)); } catch (_) {}
    }
    renderList();
    renderPlayer();
  });
  audio.addEventListener('ended', () => { if (!isNativePlaybackNotificationAvailable()) void nextTrack(true); });
  audio.addEventListener('error', () => {
    if (!isNativePlaybackNotificationAvailable() && state.currentId) showToast('Этот аудиоформат не удалось открыть.');
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopNativeProgressTimer();
      return;
    }
    if (isNativePlaybackNotificationAvailable()) {
      void refreshNativePlaybackState();
      renderPlayer();
      startNativeProgressTimer();
      return;
    }
    if (state.resumeOnVisible && currentTrack()) {
      state.resumeOnVisible = false;
      audio.play().then(() => {
        state.isPlaying = true;
        renderPlayer();
        updatePlayingRows();
      }).catch(() => { state.resumeOnVisible = true; });
    }
    renderPlayer();
  });
  window.addEventListener('beforeunload', () => {
    state.tracks.forEach(releaseTrackUrls);
  });


  function nativeYtDlp() {
    return Boolean(window.CrimsonYtDlp && window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
  }

  async function refreshFolderSettings() {
    const library = $('#libraryFolderSummary'), downloads = $('#downloadFolderSummary');
    if (!library || !downloads) return;
    if (!nativeYtDlp()) {
      library.textContent = 'Системный выбор папки доступен в установленном Android APK.';
      downloads.textContent = 'По умолчанию: приватная папка приложения. Выбор другой папки доступен в APK.';
      ['chooseLibraryFolder','refreshLibraryFolder','chooseDownloadFolder','resetDownloadFolder'].forEach((id) => { const b=$('#'+id); if(b)b.disabled=true; });
      return;
    }
    try {
      const info = await window.CrimsonYtDlp.folderStatus();
      library.textContent = info.libraryFolderName ? 'Источник: ' + info.libraryFolderName + '. Разрешение сохранено.' : 'Папка не выбрана. Выбери каталог с музыкой на устройстве.';
      downloads.textContent = info.downloadFolderName ? 'Загрузки сохраняются в: ' + info.downloadFolderName + '.' : 'По умолчанию: Music/Crimson Downloads.';
      ['chooseLibraryFolder','refreshLibraryFolder','chooseDownloadFolder','resetDownloadFolder'].forEach((id) => { const b=$('#'+id); if(b)b.disabled=false; });
    } catch (error) { library.textContent = 'Не удалось получить настройки папок: ' + (error?.message || error); }
  }

  // ===== Исправление ранее повреждённых названий и исполнителей =====
  const REPAIR_UNDO_KEY = 'crimson.mobile.metadata-undo';

  async function persistChangedTracks(before, after) {
    const old = new Map(before.map((track) => [track.id, track]));
    const changed = after.filter((track) => old.get(track.id) !== track);
    if (changed.length) await putRecords(changed.map(storedShape));
    return changed.length;
  }

  async function repairLibraryMetadata() {
    const plan = planRepairs(state.tracks);
    if (!plan.length) { showToast('Исправлять нечего: названия и исполнители в порядке.'); return; }
    const message = 'Найдено треков для исправления: ' + plan.length + '\n\n' + describeRepairs(plan) +
      '\n\nПеред изменением будет создана резервная копия. Аудиофайлы, плейлисты и идентификаторы треков не меняются. Исправить?';
    if (!window.confirm(message)) return;
    await saveBackupNow();
    try {
      const { tracks, undo } = applyRepairs(state.tracks, plan);
      try { localStorage.setItem(REPAIR_UNDO_KEY, JSON.stringify({ at: Date.now(), undo })); } catch (_) {}
      const before = state.tracks;
      const count = await persistChangedTracks(before, tracks);
      state.tracks = tracks;
      savePlaylists();       // обновляет ссылки refs плейлистов новыми названиями
      notifyLibraryChanged({ skipReconcile: true });
      render();
      showToast('Исправлено треков: ' + count + '. Можно отменить в настройках.');
    } catch (error) { showToast('Не удалось исправить названия: ' + (error && error.message || error)); }
  }

  async function undoMetadataRepair() {
    let journal = null;
    try { journal = JSON.parse(localStorage.getItem(REPAIR_UNDO_KEY) || 'null'); } catch (_) {}
    if (!journal || !Array.isArray(journal.undo) || !journal.undo.length) { showToast('Нет исправлений для отмены.'); return; }
    if (!window.confirm('Вернуть прежние названия у ' + journal.undo.length + ' треков?')) return;
    const before = state.tracks;
    state.tracks = undoRepairs(before, journal.undo);
    await persistChangedTracks(before, state.tracks);
    localStorage.removeItem(REPAIR_UNDO_KEY);
    savePlaylists(); notifyLibraryChanged({ skipReconcile: true }); render();
    showToast('Прежние названия возвращены.');
  }

  // ===== Автоматическая синхронизация плейлистов с физическими папками =====
  let folderSyncTimer = null;
  let folderSyncRunning = false;
  let folderSyncAgain = false;
  let folderSyncWarned = false;
  function readFolderSynced() { try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.playlistFolders) || '{}') || {}; } catch (_) { return {}; } }
  function writeFolderSynced(map) { try { localStorage.setItem(STORAGE_KEYS.playlistFolders, JSON.stringify(map)); } catch (_) {} }

  function scheduleFolderSync() {
    clearTimeout(folderSyncTimer);
    folderSyncTimer = setTimeout(() => { void syncPlaylistFolders(); }, 2500);
  }

  async function syncPlaylistFolders({ force = false } = {}) {
    const plugin = window.CrimsonYtDlp;
    if (!plugin || typeof plugin.syncPlaylistFolder !== 'function' || !state.libraryLoaded) return;
    if (folderSyncRunning) { folderSyncAgain = true; return; }
    folderSyncRunning = true;
    try {
      let synced = force ? {} : readFolderSynced();
      const plan = planFolderSync(synced, state.playlists, trackById);
      for (const item of plan.remove) {
        await plugin.deletePlaylistFolder({ folderName: item.folderName });
        delete synced[item.id]; writeFolderSynced(synced);
      }
      for (const item of plan.upsert) {
        await plugin.syncPlaylistFolder({
          folderName: item.state.folderName, previousName: item.previousName,
          manifest: JSON.stringify(item.state.manifest), files: item.state.files
        });
        synced[item.id] = { folderName: item.state.folderName, sig: item.sig };
        writeFolderSynced(synced);
      }
      if (force) showToast('Папки плейлистов обновлены.');
    } catch (error) {
      // Чаще всего папка не выбрана: сообщаем один раз за сеанс, а не при каждом изменении.
      if (!folderSyncWarned || force) { folderSyncWarned = true; showToast(String(error && error.message || error)); }
    } finally {
      folderSyncRunning = false;
      if (folderSyncAgain) { folderSyncAgain = false; scheduleFolderSync(); }
    }
  }

  /** Находит в выбранной папке плейлисты, которых нет в приложении (например, после переустановки), и восстанавливает их. */
  async function restorePlaylistsFromFolders({ silent = false } = {}) {
    const plugin = await waitForNativePlugin();
    if (!plugin || typeof plugin.readPlaylistFolders !== 'function') return 0;
    let folders = [];
    try { folders = ((await plugin.readPlaylistFolders()) || {}).folders || []; } catch (_) { return 0; }
    if (!folders.length) return 0;
    let found = playlistsFromFolders(folders, state.tracks, state.playlists);
    // Файлы, вручную добавленные в папку плейлиста, импортируем один раз в общую библиотеку.
    // Сами плейлистные папки больше не получают копии треков: состав хранится в манифесте.
    const need = Array.from(new Set(found.unresolved.map((item) => item.file && item.file.sourceId).filter(Boolean)));
    const fileTracks = new Map();
    if (need.length && typeof plugin.ingestPlaylistFiles === 'function') {
      try {
        const rows = ((await plugin.ingestPlaylistFiles({ sourceIds: need })) || {}).rows || [];
        const bySource = new Map(found.unresolved.map((item) => [String(item.file.sourceId), item.file.name]));
        const records = rows.map((row) => folderRecordFromRow(row, null));
        if (records.length) {
          await putRecords(records);
          state.tracks = state.tracks.concat(records.map(attachUrl));
          notifyLibraryChanged({ skipReconcile: true });
        }
        records.forEach((record) => {
          const name = bySource.get(String(record.sourceId));
          fileTracks.set(String(record.sourceId), record.id);
          if (name) fileTracks.set(String(name).toLocaleLowerCase(), record.id);
        });
      } catch (error) { console.warn('Playlist files ingest failed', error); }
    }
    found = playlistsFromFolders(folders, state.tracks, state.playlists, fileTracks);

    let addedToExisting = 0;
    for (const addition of found.additions || []) {
      const playlist = playlistById(addition.playlistId);
      if (!playlist) continue;
      const before = playlist.trackIds.length;
      playlist.trackIds = uniqueTrackIds(playlist.trackIds.concat(addition.trackIds || []));
      addedToExisting += playlist.trackIds.length - before;
    }
    const restored = found.playlists.map((item) => ({ ...item, trackIds: uniqueTrackIds(item.trackIds) }));
    state.playlists = state.playlists.concat(restored);

    const synced = readFolderSynced();
    Object.assign(synced, found.synced);
    writeFolderSynced(synced);
    const changed = restored.length > 0 || addedToExisting > 0;
    if (changed) { savePlaylists(); render(); }
    else scheduleFolderSync(); // also runs the one-time reference-only migration for old folders
    if (!silent || changed) showToast('Восстановлено плейлистов: ' + restored.length + '; добавлено треков: ' + addedToExisting + '.');
    return restored.length;
  }

  // ===== Автоматическое сканирование папки: фоновый поток в Java, пачки событий, отмена =====
  async function attachScanListener() {
    const plugin = await waitForNativePlugin();
    if (!plugin || typeof plugin.addListener !== 'function') throw new Error('Нативный модуль сканирования не загружен. Перезапусти приложение или обнови APK.');
    if (state.scanListenerPromise) return state.scanListenerPromise;
    state.scanListenerPromise = Promise.resolve(plugin.addListener('libraryScanEvent', (event) => { void handleScanEvent(event || {}); }))
      .then(() => { state.scanListenerAttached = true; return true; })
      .catch((error) => { state.scanListenerPromise = null; state.scanListenerAttached = false; throw error; });
    return state.scanListenerPromise;
  }

  function renderScanProgress() {
    const scan = state.scan;
    const visible = scan.phase !== 'idle';
    document.querySelectorAll('.scan-panel').forEach((panel) => {
      panel.classList.toggle('hidden', !visible);
      if (!visible) return;
      const active = isScanActive(scan);
      panel.dataset.phase = scan.phase;
      const bar = panel.querySelector('.scan-bar > span');
      if (bar) bar.style.transform = 'scaleX(' + ((active && !scan.total ? 8 : scan.percent) / 100) + ')';
      panel.querySelector('.scan-bar').classList.toggle('indeterminate', active && !scan.total);
      panel.querySelector('.scan-message').textContent = scan.phase === 'done' ? 'Готово: ' + scanSummary(scan) : scan.message;
      panel.querySelector('.scan-counters').textContent = scan.total
        ? 'Обработано ' + scan.processed + ' из ' + scan.total + ' · добавлено ' + scan.added + ' · пропущено ' + scan.skipped
        : (active ? 'Подсчёт файлов…' : '');
      panel.querySelector('.scan-file').textContent = active ? scan.currentName : '';
      panel.querySelector('.scan-cancel').classList.toggle('hidden', !active);
    });
  }

  function scheduleScanRender() {
    if (state.scanRenderTimer) return;
    state.scanRenderTimer = setTimeout(() => {
      state.scanRenderTimer = null;
      renderScanProgress();
      if (state.view === 'library') renderList();
    }, 250);
  }

  function folderRecordFromRow(row, old) {
    const sourceId = String(row.sourceId || row.path);
    const names = parseFilename(row.name);
    const youtubeId = extractYouTubeIdFromTitle(row.name) || (old && old.youtubeId) || '';
    return {
      id: old ? old.id : 'folder:' + sourceId,
      name: names.name, artist: names.artist, blob: null,
      nativePath: row.path, sourceId, youtubeId, fileName: row.name, lastModified: Number(row.lastModified) || 0,
      coverPath: row.coverPath || (old && old.coverPath) || '',
      coverUrl: (old && old.coverUrl) || (youtubeId ? 'https://i.ytimg.com/vi/' + encodeURIComponent(youtubeId) + '/hqdefault.jpg' : ''),
      coverBlob: (old && old.coverBlob) || null,
      addedAt: old ? old.addedAt : Date.now(),
      duration: Number(row.duration) > 0 ? Number(row.duration) : (old ? (Number(old.duration) || 0) : 0),
      size: Number(row.size) || 0
    };
  }

  async function handleScanEvent(event) {
    try {
      if (event.type === 'counted') {
        state.scan = reduceScanEvent(state.scan, event);
      } else if (event.type === 'batch') {
        const rows = Array.isArray(event.rows) ? event.rows : [];
        const plan = planLibrarySync(state.tracks, rows, { complete: false });
        plan.seen.forEach((id) => state.scanSeen && state.scanSeen.add(id));
        const records = [];
        for (const row of plan.add) records.push(folderRecordFromRow(row, null));
        for (const item of plan.update) { records.push(folderRecordFromRow(item.row, item.track)); }
        if (records.length) {
          await putRecords(records);
          const byId = new Map(records.map((record) => [record.id, attachUrl(record)]));
          const replaced = state.tracks.map((track) => { const next = byId.get(track.id); if (next) { releaseTrackUrls(track); byId.delete(track.id); return next; } return track; });
          state.tracks = replaced.concat(Array.from(byId.values()));
        }
        state.scan = reduceScanEvent(state.scan, { type: 'progress', processed: event.processed, corrupted: event.corrupted, currentName: event.currentName });
        state.scan = reduceScanEvent(state.scan, { type: 'plan', added: plan.add.length, updated: plan.update.length, unchanged: plan.unchanged.length, duplicates: plan.duplicates.length });
      } else if (event.type === 'done') {
        // Удаляем только записи файлов, которых в папке больше нет, и только после полного обхода.
        const stale = state.tracks.filter((track) => isFolderTrack(track) && track.sourceId && state.scanSeen && !state.scanSeen.has(String(track.sourceId)));
        if (stale.length && Number(event.total) !== 0) {
          const ids = new Set(stale.map((track) => track.id));
          await removeRecords(Array.from(ids));
          state.tracks = state.tracks.filter((track) => !ids.has(track.id));
        }
        state.tracks.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
        state.scan = reduceScanEvent(state.scan, { type: 'done' });
        state.lastFolderScanAt = Date.now();
        notifyLibraryChanged();
        scheduleBackup();
        if (!state.scanSilent) showToast('Папка просканирована: ' + scanSummary(state.scan) + '.');
        void restorePlaylistsFromFolders({ silent: true });
        await refreshFolderSettings();
        setTimeout(() => { if (!isScanActive(state.scan)) { state.scan = createScanState(); renderScanProgress(); } }, 6000);
      } else if (event.type === 'cancelled') {
        state.scan = reduceScanEvent(state.scan, event);
        notifyLibraryChanged();
        setTimeout(() => { if (!isScanActive(state.scan)) { state.scan = createScanState(); renderScanProgress(); } }, 5000);
      } else if (event.type === 'error') {
        state.scan = reduceScanEvent(state.scan, event);
        if (!state.scanSilent) showToast(state.scan.message);
      }
      if (event.type === 'batch') scheduleScanRender(); else { renderScanProgress(); render(); }
    } catch (error) {
      console.error('Scan event failed', error);
      state.scan = reduceScanEvent(state.scan, { type: 'error', message: 'Ошибка обработки результатов: ' + (error && error.message || error) });
      renderScanProgress();
    }
  }

  async function refreshExternalLibrary(options = {}) {
    const force = Boolean(options.force);
    state.scanSilent = Boolean(options.silent);
    if (!nativeYtDlp() || !state.db) return;
    if (isScanActive(state.scan)) return; // уже идёт: повторный запуск не создаёт второй поток
    if (!force && state.lastFolderScanAt && Date.now() - state.lastFolderScanAt < 30000) return;
    const plugin = window.CrimsonYtDlp;
    if (typeof plugin.startLibraryScan !== 'function') { if (!state.scanSilent) showToast('Эта версия APK не поддерживает фоновое сканирование.'); return; }
    state.scanSeen = new Set();
    state.scan = reduceScanEvent(createScanState(), { type: 'start' });
    renderScanProgress();
    try {
      // Capacitor addListener is asynchronous. Await it before native scan emits its first batch.
      await attachScanListener();
      const started = await plugin.startLibraryScan({ known: buildKnownSources(state.tracks) });
      if (started && started.selected === false) { state.scan = createScanState(); renderScanProgress(); }
    } catch (error) {
      state.scan = reduceScanEvent(state.scan, { type: 'error', message: 'Не удалось запустить сканирование: ' + (error && error.message || error) });
      renderScanProgress();
    }
  }

  async function cancelLibraryScan() {
    const plugin = window.CrimsonYtDlp;
    if (plugin && typeof plugin.cancelLibraryScan === 'function') { try { await plugin.cancelLibraryScan(); } catch (_) {} }
  }

  async function restoreNativeBackupIfEmpty() {
    if (state.playlists.length) return false;
    const { best } = pickNewestValidBackup(await readNativeBackups());
    if (!best) return false;
    const data = best.snapshot.data;
    const restored = reconcilePlaylists(Array.isArray(data.playlists) ? data.playlists : [], state.tracks);
    state.playlists = restored.playlists.map((item) => ({ ...item, trackIds: uniqueTrackIds(item.trackIds) }));
    restoreBackupPreferences(data);
    restoreBackupQueue();
    savePlaylists();
    render();
    showToast('Найдена резервная копия: восстановлены данные Crimson (' + state.playlists.length + ' плейлистов).');
    return true;
  }

  async function chooseLibraryFolder() {
    const plugin = await waitForNativePlugin();
    if (!plugin || !nativeYtDlp()) { showToast('Выбор папки доступен только в установленном APK.'); return; }
    try {
      const wasSelected = Boolean((await plugin.folderStatus()).hasLibraryFolder);
      await plugin.chooseLibraryFolder(); // путь сохраняется нативным слоем
      // После переустановки в выбранной папке может лежать резервная копия.
      await restoreNativeBackupIfEmpty();
      // Автоматический запуск: уже добавленная папка обновляется без дубликатов (инкрементально).
      await refreshExternalLibrary({ silent: true, force: true });
      if (wasSelected) showToast('Папка уже была добавлена: библиотека обновляется без дубликатов.');
    } catch (error) { if (!String(error?.message || error).toLowerCase().includes('отмен')) showToast('Не удалось выбрать папку: ' + (error?.message || error)); }
  }

  async function chooseDownloadFolder() {
    const plugin = await waitForNativePlugin();
    if (!plugin || !nativeYtDlp()) { showToast('Выбор папки доступен только в установленном APK.'); return; }
    try {
      await plugin.chooseDownloadFolder();
      await restoreNativeBackupIfEmpty();
      await refreshFolderSettings();
      showToast('Папка загрузок сохранена.');
    } catch (error) { if (!String(error?.message || error).toLowerCase().includes('отмен')) showToast('Не удалось выбрать папку загрузок: ' + (error?.message || error)); }
  }

  async function resetDownloadFolder() {
    if (!nativeYtDlp()) return;
    try {
      await window.CrimsonYtDlp.resetDownloadFolder();
      await refreshFolderSettings();
      showToast('Загрузки снова сохраняются в Music/Crimson Downloads.');
    } catch (error) { showToast('Не удалось сбросить папку: ' + (error?.message || error)); }
  }

  function ytStatus(message, isError = false) {
    state.ytStatus = message; state.ytStatusError = isError;
    const node = $('#youtubeStatus');
    if (node) { node.textContent = message; node.classList.toggle('error', isError); }
  }
  async function refreshYtDlpStatus() {
    if (!nativeYtDlp()) {
      ytStatus('Для поиска и скачивания через yt-dlp установи APK на Android.', true);
      $('#youtubeSearchButton').disabled = true; $('#importCookies').disabled = true; $('#clearCookies').disabled = true; $('#updateYtDlp').disabled = true;
      return;
    }
    $('#youtubeSearchButton').disabled = false; $('#importCookies').disabled = false; $('#clearCookies').disabled = false; $('#updateYtDlp').disabled = false;
    try {
      const info = await window.CrimsonYtDlp.status();
      const runtimeVersion = info.runtimeVersion || info.ytDlpVersion || 'версия уточняется при запуске';
      ytStatus('yt-dlp ' + runtimeVersion + ' · runtime youtubedl-android ' + (info.version || 'готов'));
      $('#cookiesStatus').textContent = info.hasCookies ? 'Файл используется для поиска, прослушивания и скачивания в Crimson.' : 'Если YouTube блокирует запросы, импортируй cookies.txt в формате Netscape.';
    } catch (error) { ytStatus('Не удалось проверить встроенный загрузчик: ' + ytErrorMessage(error), true); }
  }

  async function updateYtDlp() {
    if (!nativeYtDlp() || typeof window.CrimsonYtDlp.updateYtDlp !== 'function') {
      ytStatus('Обновление встроенного yt-dlp недоступно в этой сборке.', true);
      return;
    }
    const button = $('#updateYtDlp');
    if (button) button.disabled = true;
    ytStatus('Проверяю стабильное обновление yt-dlp…');
    try {
      const result = await window.CrimsonYtDlp.updateYtDlp();
      const version = result.runtimeVersion || 'версия уточняется';
      if (result.status === 'ERROR' || result.status === 'UNKNOWN') {
        ytStatus('Обновление yt-dlp не удалось. Используется текущая версия · ' + version, true);
        return;
      }
      const status = result.status === 'DONE' ? 'yt-dlp обновлён' : 'yt-dlp уже актуален';
      ytStatus(status + ' · ' + version);
      showToast(status + '.');
    } catch (error) {
      ytStatus('Не удалось обновить yt-dlp: ' + ytErrorMessage(error), true);
    } finally {
      if (button) button.disabled = false;
    }
  }

  $('#updateYtDlp').addEventListener('click', () => { void updateYtDlp(); });

  function formatVideoDuration(seconds) {
    const n = Math.max(0, Math.floor(Number(seconds) || 0));
    if (!n) return 'длительность неизвестна';
    return Math.floor(n / 60) + ':' + String(n % 60).padStart(2, '0');
  }
  function renderOnlineResults() {
    const root = $('#youtubeResults'); if (!root) return;
    const rows = state.ytResults || [];
    if (!rows.length) {
      root.innerHTML = state.ytLoading ? '<div class="empty-state"><div class="empty-glyph">♫</div><h3>Ищу музыку…</h3><p>yt-dlp получает результаты с YouTube.</p></div>' : '';
      return;
    }
    if (state.libraryDirty) { libraryMatcher.update(state.tracks); state.libraryDirty = false; }
    root.innerHTML = rows.map((video) => {
      const id = esc(video.id), progress = state.ytDownloads[video.id];
      const found = libraryMatcher.match({ title: video.title, artist: video.artist, channel: video.channel || video.uploader, duration: video.duration });
      const badge = matchBadge(found);
      const local = found.track;
      const localLine = local && found.level !== MATCH_LEVEL.NONE
        ? '<div class="library-match-file" title="' + esc(local.nativePath || local.name) + '">' + esc((local.artist ? local.artist + ' — ' : '') + local.name) + '</div>' : '';
      const badgeMarkup = '<div class="library-match"><span class="match-badge match-' + badge.tone + '" title="' + esc(badge.hint) + '">' + esc(badge.label) + '</span>' +
        (found.level === MATCH_LEVEL.NONE ? '' : '<button type="button" class="match-play" data-youtube-action="play-local" data-id="' + id + '" data-track-id="' + esc(local.id) + '">Воспроизвести</button>') + '</div>' + localLine;
      const downloading = progress && progress.status === 'downloading';
      const completed = progress && progress.status === 'done';
      const downloadLabel = downloading ? 'Скачивание…' : (completed ? ('Скачано · ' + (progress.format || 'готово')) : (progress && progress.status === 'error' ? 'Повторить' : (progress && progress.status === 'cancelled' ? 'Скачать снова' : 'Скачать')));
      const downloadDisabled = downloading || completed;
      const thumb = video.thumbnail ? '<img class="youtube-thumb" loading="lazy" src="' + esc(video.thumbnail) + '" alt="">' : '<div class="youtube-thumb-fallback">♫</div>';
      return '<article class="youtube-result">' + thumb + '<div class="youtube-result-copy"><div class="youtube-title">' + esc(video.title || 'Без названия') + '</div>' +
        '<div class="youtube-meta">' + esc(video.channel || video.uploader || 'YouTube') + ' · ' + formatVideoDuration(video.duration) + '</div>' + badgeMarkup + '<div class="youtube-actions">' +
        '<button class="primary-action" data-youtube-action="play" data-id="' + id + '"' + (downloading ? ' disabled' : '') + '><svg viewBox="0 0 24 24"><path d="m8 5 12 7-12 7z"/></svg>Слушать</button>' +
        '<button data-youtube-action="download" data-id="' + id + '"' + (downloadDisabled ? ' disabled' : '') + '><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v3h16v-3"/></svg>' + downloadLabel + '</button>' +
        (downloading ? '<button type="button" class="cancel-download" data-youtube-action="cancel-download" data-id="' + id + '">Отмена</button>' : '') +
        '</div>' + (downloading ? '<div class="dl-progress" data-dl="' + id + '">' + downloadProgressMarkup(progress) + '</div>' : '') + '</div></article>';
    }).join('');
  }
  const ytErrorMessage = friendlyYoutubeError;

  async function searchYoutube(query) {
    const q = String(query || '').replace(/[\r\n]+/g, ' ').trim();
    if (!q) { ytStatus('Введи название трека или исполнителя.'); return; }
    if (!nativeYtDlp()) { ytStatus('yt-dlp доступен в установленном Android APK.', true); return; }

    const cacheKey = q.toLocaleLowerCase();
    const cached = state.ytSearchCache.get(cacheKey);
    const cacheTtl = cached && cached.results.length ? 5 * 60 * 1000 : 45 * 1000;
    if (cached && Date.now() - cached.at < cacheTtl) {
      state.ytSearchRequestId += 1;
      state.ytQuery = q;
      state.ytResults = cached.results;
      state.ytLoading = false;
      $('#youtubeSearchButton').disabled = false;
      renderOnlineResults();
      ytStatus(state.ytResults.length ? 'Найдено: ' + state.ytResults.length + ' • результаты из кэша' : 'Ничего не найдено. Попробуй изменить запрос.');
      return;
    }

    const requestId = ++state.ytSearchRequestId;
    state.ytQuery = q; state.ytLoading = true; state.ytResults = []; renderOnlineResults();
    $('#youtubeSearchButton').disabled = true; ytStatus('Ищу на YouTube через yt-dlp…');
    try {
      const result = await window.CrimsonYtDlp.search({ query: q });
      if (requestId !== state.ytSearchRequestId) return;
      state.ytResults = normalizeYoutubeResults(result.results);
      state.ytSearchCache.set(cacheKey, { at: Date.now(), results: state.ytResults });
      while (state.ytSearchCache.size > 12) state.ytSearchCache.delete(state.ytSearchCache.keys().next().value);
      ytStatus(state.ytResults.length ? 'Найдено: ' + state.ytResults.length + ' • можно слушать или скачать аудио' : 'Ничего не найдено. Попробуй изменить запрос.');
    } catch (error) {
      if (requestId === state.ytSearchRequestId) ytStatus('Поиск не удался: ' + ytErrorMessage(error), true);
    } finally {
      if (requestId === state.ytSearchRequestId) {
        state.ytLoading = false;
        $('#youtubeSearchButton').disabled = false;
        renderOnlineResults();
      }
    }
  }
  async function playYoutubeVideo(video) {
    if (!nativeYtDlp()) { showToast('yt-dlp доступен только в установленном APK.'); return; }
    ytStatus('Получаю аудиопоток: ' + (video.title || 'YouTube') + '…');
    try {
      const info = await window.CrimsonYtDlp.streamInfo({ url: video.url });
      if (!info.url) throw new Error('yt-dlp не вернул аудиопоток.');
      state.currentId = null;
      state.nativeQueueOrder = null;
      state.nativeQueueLastKey = '';
      // Тот же механизм, что при скачивании: канал не подменяет исполнителя.
      const identity = buildTrackMetadata({ title: video.title || info.title, videoId: video.id, info: info.info || {} });
      state.currentRemoteTrack = {
        id:'youtube:'+video.id, name: identity.title,
        artist: identity.artist,
        duration:Number(info.duration || video.duration)||0, addedAt:Date.now(), size:0, url:info.url, isRemote:true,
        coverUrl: info.thumbnail || video.thumbnail || ('https://i.ytimg.com/vi/' + encodeURIComponent(video.id) + '/hqdefault.jpg')
      };
      if (isNativePlaybackNotificationAvailable()) {
        state.nativePosition = 0;
        state.nativeDuration = Number(state.currentRemoteTrack.duration) || 0;
        state.nativePositionUpdatedAt = Date.now();
        state.isPlaying = true;
        state.resumeOnVisible = false;
        try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch (_) {}
        await syncNativePlayback(true);
        render();
      } else {
        audio.src = info.url; audio.load(); await audio.play(); state.isPlaying = true; render();
      }
      ytStatus('Слушаешь: ' + state.currentRemoteTrack.name);
    } catch (error) { ytStatus('Не удалось запустить поток: ' + ytErrorMessage(error), true); }
  }
  // ===== Скачивание: очередь, прогресс без полной перерисовки списка =====
  function downloadProgressMarkup(progress) {
    const view = progressView(progress);
    return '<div class="dl-lines">' + view.lines.map((line, index) => '<span' + (index === 0 ? ' class="dl-phase"' : '') + '>' + esc(line) + '</span>').join('') + '</div>' +
      '<div class="dl-bar' + (view.indeterminate ? ' indeterminate' : '') + '"><span style="transform:scaleX(' + ((view.indeterminate ? 35 : view.percent) / 100) + ')"></span></div>';
  }
  function updateDownloadDom(id) {
    const node = document.querySelector('.dl-progress[data-dl="' + (window.CSS && CSS.escape ? CSS.escape(String(id)) : String(id)) + '"]');
    const progress = state.ytDownloads[id];
    if (!node || !progress) return;
    const view = progressView(progress);
    const lines = node.querySelectorAll('.dl-lines > span');
    if (lines.length !== view.lines.length) { node.innerHTML = downloadProgressMarkup(progress); return; }
    view.lines.forEach((line, index) => { if (lines[index].textContent !== line) lines[index].textContent = line; });
    const bar = node.querySelector('.dl-bar');
    bar.classList.toggle('indeterminate', view.indeterminate);
    bar.firstElementChild.style.transform = 'scaleX(' + ((view.indeterminate ? 35 : view.percent) / 100) + ')';
  }
  // Не чаще 4 раз в секунду на каждое скачивание; список результатов при этом не пересобирается.
  const progressThrottles = new Map();
  function scheduleProgressUpdate(id) {
    if (!progressThrottles.has(id)) progressThrottles.set(id, createThrottle(() => updateDownloadDom(id), 250));
    progressThrottles.get(id)();
  }

  function readDownloadConcurrency() {
    try { return clampConcurrency(localStorage.getItem(STORAGE_KEYS.downloadConcurrency) ?? DEFAULT_CONCURRENCY); } catch (_) { return DEFAULT_CONCURRENCY; }
  }
  const downloadQueue = createDownloadQueue({
    concurrency: readDownloadConcurrency(),
    run: (job) => runYoutubeDownload(job.video),
    onChange: (id, snapshot) => {
      if (!snapshot) return;
      const current = state.ytDownloads[id] || { progress: 0 };
      if (snapshot.state === 'queued') state.ytDownloads[id] = { ...current, phase: 'queued', status: 'queued' };
      else if (snapshot.state === 'running' && !ACTIVE_PHASES.has(current.phase)) state.ytDownloads[id] = { ...current, phase: 'extracting', status: 'downloading' };
      else if (snapshot.state === 'cancelling') state.ytDownloads[id] = { ...current, phase: 'cancelling', status: 'cancelling' };
      else if (snapshot.state === 'cancelled') state.ytDownloads[id] = { ...current, phase: 'cancelled', status: 'cancelled' };
      if (state.view === 'youtube') renderOnlineResults();
    },
    cancelNative: async (id) => { const plugin = window.CrimsonYtDlp; if (plugin && typeof plugin.cancelDownload === 'function') await plugin.cancelDownload({ id }); }
  });

  async function enqueueYoutubeDownload(video) {
    const plugin = await waitForNativePlugin();
    if (!plugin || !nativeYtDlp() || typeof plugin.downloadAudio !== 'function') { showToast('Модуль загрузок не готов. Перезапусти Crimson или обнови APK.'); return; }
    await attachDownloadProgressListener();
    if (downloadQueue.isActive(video.id)) return;   // то же задание не запускается дважды
    state.ytDownloads[video.id] = mergeProgress(null, { phase: 'queued', progress: 0 });
    renderOnlineResults();
    void downloadQueue.add({ id: String(video.id), video }).then((outcome) => {
      if (outcome.state === 'cancelled') { state.ytDownloads[video.id] = { status: 'cancelled', progress: 0 }; ytStatus('Загрузка отменена.'); }
      else if (outcome.state === 'error') { state.ytDownloads[video.id] = { status: 'error', progress: 0 }; ytStatus('Не удалось скачать аудио: ' + ytErrorMessage(outcome.error), true); }
      progressThrottles.delete(String(video.id));
      renderOnlineResults();
    });
  }

  async function runYoutubeDownload(video) {
    state.ytDownloads[video.id] = mergeProgress(state.ytDownloads[video.id], { phase: 'extracting', progress: 0 });
    renderOnlineResults();
    ytStatus('Скачиваю аудио в Crimson: ' + (video.title || 'YouTube') + '…');
    {
      // Единый механизм: исполнитель/название определяются один раз и дальше используются
      // для тегов, имени файла, записи в библиотеке и отображения.
      let rawInfo = {};
      let infoFile = '';
      try {
        if (typeof window.CrimsonYtDlp.fetchTrackMetadata === 'function') {
          const fetched = await window.CrimsonYtDlp.fetchTrackMetadata({ url: video.url });
          rawInfo = (fetched && fetched.info) || {};
          infoFile = (fetched && fetched.infoFile) || '';   // скачивание использует этот ответ и не извлекает информацию заново
        }
      } catch (_) { /* метаданные необязательны: используем данные поиска */ }
      const meta = buildTrackMetadata({
        title: video.title, artist: video.artist, videoId: video.id,
        info: { ...rawInfo, channel: rawInfo.channel || video.channel, uploader: rawInfo.uploader || video.uploader }
      });
      const saved = await window.CrimsonYtDlp.downloadAudio({
        id: video.id,
        url: video.url,
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        year: meta.year,
        genre: meta.genre,
        resolved: true,
        infoFile,
        format: 'original'
      });
      state.ytDownloads[video.id] = mergeProgress(state.ytDownloads[video.id], { phase: 'saving', progress: 100 });
      updateDownloadDom(video.id);
      const sourceId = String(video.id);
      const existing = state.tracks.find((track) =>
        String(track.sourceId || '') === sourceId ||
        String(track.youtubeId || '') === sourceId ||
        extractYouTubeIdFromTitle(track.name) === sourceId);
      const storedSourceId = existing && String(existing.id || '').startsWith('folder:')
        ? String(existing.sourceId || sourceId) : sourceId;
      const record = {
        id: existing ? existing.id : 'youtube:' + sourceId,
        name: cleanYouTubeTitle(saved.title || meta.title || 'YouTube', sourceId),
        artist: cleanArtistName(saved.artist || meta.artist || ''),
        blob: null,
        nativePath: saved.path,
        sourceId: storedSourceId,
        youtubeId: sourceId,
        coverUrl: video.thumbnail || ('https://i.ytimg.com/vi/' + encodeURIComponent(sourceId) + '/hqdefault.jpg'),
        album: saved.album || '', year: saved.year || '', genre: saved.genre || '',
        coverPath: existing ? (existing.coverPath || '') : '',
        coverBlob: existing ? (existing.coverBlob || null) : null,
        addedAt: existing ? existing.addedAt : Date.now(),
        duration: Number(video.duration) || 0,
        size: Number(saved.size) || 0
      };
      await putRecord(record);
      const attached = attachUrl(record);
      if (existing) state.tracks = state.tracks.map((track) => track.id === existing.id ? attached : track);
      else state.tracks.unshift(attached);
      state.ytDownloads[video.id] = {status:'done',progress:100,format:String(saved.format || '')};
      notifyLibraryChanged();
      render();
      ytStatus('Скачано в медиатеку Crimson: ' + record.name + ' · формат: ' + (saved.format || 'не указан'));
      showToast('Трек скачан (' + (saved.format || 'формат не указан') + ') и добавлен в медиатеку');
    }
  }
  $('#youtubeSearchForm').addEventListener('submit', (event) => { event.preventDefault(); state.view = 'youtube'; void searchYoutube($('#youtubeQuery').value); });
  $('#youtubeResults').addEventListener('click', (event) => {
    const button = event.target.closest('[data-youtube-action]'); if (!button) return;
    const video = state.ytResults.find((item) => String(item.id) === String(button.dataset.id)); if (!video) return;
    if (button.dataset.youtubeAction === 'play-local') { const id = button.dataset.trackId; if (trackById(id)) void playTrack(id, libraryOrderIds()); return; }
    if (button.dataset.youtubeAction === 'play') void playYoutubeVideo(video);
    if (button.dataset.youtubeAction === 'download') enqueueYoutubeDownload(video);
    if (button.dataset.youtubeAction === 'cancel-download') void downloadQueue.cancel(String(video.id));
  });
  $('#importCookies').addEventListener('click', () => $('#cookiesPicker').click());
  $('#cookiesPicker').addEventListener('change', async (event) => {
    const file = event.currentTarget.files && event.currentTarget.files[0]; if (!file) return;
    if (!nativeYtDlp()) { ytStatus('Импорт cookies доступен только в установленном APK.', true); return; }
    try {
      const contents = await file.text();
      const validation = validateNetscapeCookies(contents);
      if (!validation.valid) throw new Error(validation.message);
      const result = await window.CrimsonYtDlp.saveCookies({content:contents});
      $('#cookiesStatus').textContent = 'cookies.txt импортирован (' + (result.count || 'готово') + ' строк) для поиска, прослушивания и скачивания в Crimson.';
      ytStatus('Cookies сохранены в приватном каталоге приложения.');
    } catch (error) { ytStatus('Не удалось импортировать cookies.txt: ' + (error?.message || error), true); }
    finally { event.currentTarget.value = ''; }
  });
  $('#clearCookies').addEventListener('click', async () => {
    if (!nativeYtDlp()) return;
    try { await window.CrimsonYtDlp.clearCookies(); $('#cookiesStatus').textContent = 'Cookies Crimson удалены.'; ytStatus('cookies.txt удалён.'); }
    catch (error) { ytStatus('Не удалось удалить cookies.txt: ' + (error?.message || error), true); }
  });
  async function attachDownloadProgressListener() {
    const plugin = await waitForNativePlugin();
    if (!plugin || typeof plugin.addListener !== 'function' || state.downloadListenerAttached) return;
    if (state.downloadListenerPromise) return state.downloadListenerPromise;
    state.downloadListenerPromise = (async () => {
      await plugin.addListener('downloadProgress', (event) => {
        if (!event || !event.id) return;
        const previous = state.ytDownloads[event.id];
        if (previous && !ACTIVE_PHASES.has(previous.phase) && previous.status !== 'downloading') return;
        const next = mergeProgress(previous, event);
        const phaseChanged = !previous || previous.phase !== next.phase;
        state.ytDownloads[event.id] = next;
        if (event.message) ytStatus(String(event.message));
        if (state.view !== 'youtube') return;
        if (phaseChanged && !document.querySelector('.dl-progress[data-dl]')) renderOnlineResults();
        else scheduleProgressUpdate(String(event.id));
      });
      await plugin.addListener('downloadPublished', (event) => {
        if (event && event.ok === false && event.message) showToast(String(event.message));
      });
      state.downloadListenerAttached = true;
      return true;
    })().catch((error) => {
      state.downloadListenerPromise = null;
      state.downloadListenerAttached = false;
      console.warn('Download listener registration failed', error);
      return false;
    });
    return state.downloadListenerPromise;
  }

  window.addEventListener('crimson-yt-dlp-ready', () => {
    void attachDownloadProgressListener();
    if (typeof window.CrimsonYtDlp?.addListener === 'function') {
      window.CrimsonYtDlp.addListener('ytDlpUpdate', (event) => {
        const version = event && event.runtimeVersion ? ' · ' + event.runtimeVersion : '';
        if (event && event.status === 'CHECKING') ytStatus('Проверяется стабильное обновление yt-dlp…');
        if (event && event.status === 'DONE') ytStatus('yt-dlp обновлён' + version);
        else if (event && event.status === 'ALREADY_UP_TO_DATE') ytStatus('yt-dlp уже актуален' + version);
        else if (event && event.status === 'ERROR') ytStatus('Обновление yt-dlp недоступно; используется установленная версия' + version, true);
      });
    }

    if (state.db) void refreshFolderSettings();
  });
  void attachDownloadProgressListener();

  // Avoid a full Android SAF folder scan on every app resume; loading, choosing
  // a source folder, or tapping "Пересканировать" is enough.

  loadLibrary();
})();
