(() => {
  'use strict';

  const DB_NAME = 'localify-crimson-mobile';
  const DB_VERSION = 1;
  const STORE = 'tracks';
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
    editingPlaylistId: null,
    pendingPlaylistTrackId: null,
    pendingImportPlaylistId: null,
    shuffle: false,
    repeat: false,
    isPlaying: false,
    toastTimer: null,
    seekDragging: false,
    downloadListenerAttached: false,
    libraryRefreshing: false,
    libraryRefreshRequested: false,
    libraryRefreshRequestedSilent: true,
    lastFolderScanAt: 0,
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
    searchRenderTimer: null
  };
  const audio = $('#audio');
  const filePicker = $('#filePicker');

  function recordWebDiagnostic(kind, message, stack, source) {
    const plugin = window.LocalifyPlayback;
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

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('Это устройство не поддерживает локальное хранилище медиатеки.'));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Не удалось открыть медиатеку.'));
    });
  }

  function getAllRecords() {
    return new Promise((resolve, reject) => {
      const request = state.db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  function putRecord(record) {
    return putRecords([record]);
  }

  function putRecords(records) {
    return new Promise((resolve, reject) => {
      if (!state.db || !records.length) { resolve(); return; }
      const tx = state.db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      records.forEach((record) => store.put(record));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Не удалось сохранить треки.'));
      tx.onabort = () => reject(tx.error || new Error('Сохранение отменено.'));
    });
  }

  function removeRecord(id) {
    return removeRecords([id]);
  }

  function removeRecords(ids) {
    return new Promise((resolve, reject) => {
      if (!state.db || !ids.length) { resolve(); return; }
      const tx = state.db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      ids.forEach((id) => store.delete(id));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Не удалось удалить дубликаты.'));
      tx.onabort = () => reject(tx.error || new Error('Удаление отменено.'));
    });
  }

  function storedShape(track) {
    return {
      id: track.id, name: track.name, artist: track.artist, blob: track.blob || null,
      fileName: track.fileName || '', nativePath: track.nativePath || '', sourceId: track.sourceId || '', addedAt: track.addedAt,
      duration: Number(track.duration) || 0, size: Number(track.size) || 0,
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
    const plugin = window.LocalifyPlayback;
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
    const title = String(value || '').trim().replace(/\.[^.]+$/, '');
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

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }

  function formatTime(seconds) {
    const value = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
    const minutes = Math.floor(value / 60);
    const remainder = value % 60;
    return minutes + ':' + String(remainder).padStart(2, '0');
  }

  function pluralTracks(count) {
    const n = Math.abs(count) % 100;
    const last = n % 10;
    if (n > 10 && n < 20) return count + ' треков';
    if (last > 1 && last < 5) return count + ' трека';
    if (last === 1) return count + ' трек';
    return count + ' треков';
  }

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.remove('visible'), 2600);
  }

  function trackById(id) {
    return state.tracks.find((track) => track.id === id) || null;
  }

  function cleanYouTubeTitle(title, videoId) {
    let cleaned = String(title || '').trim();
    const id = String(videoId || '').trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(id)) {
      for (const suffix of ['[' + id + ']', '(' + id + ')']) {
        if (cleaned.toLocaleLowerCase().endsWith(suffix.toLocaleLowerCase())) {
          cleaned = cleaned.slice(0, -suffix.length).trim();
          break;
        }
      }
    }
    // The folder scanner sees the source ID in the filename, not as separate metadata.
    cleaned = cleaned
      .replace(/\s+\[[A-Za-z0-9_-]{11}\]\s*$/, '')
      .replace(/\s+\([A-Za-z0-9_-]{11}\)\s*$/, '')
      .trim();
    return cleaned || 'YouTube';
  }

  function currentTrack() {
    return trackById(state.currentId) || state.currentRemoteTrack || null;
  }

  function playlistById(id) {
    return state.playlists.find((playlist) => playlist.id === id) || null;
  }

  function uniqueTrackIds(ids) {
    const seen = new Set();
    return (Array.isArray(ids) ? ids : []).filter((id) => {
      if (!trackById(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  function savePlaylists() {
    try {
      localStorage.setItem('localify.mobile.playlists', JSON.stringify(state.playlists.map((playlist) => ({
        id: playlist.id, name: playlist.name, trackIds: playlist.trackIds, createdAt: playlist.createdAt || Date.now()
      }))));
    } catch (_) { showToast('Не удалось сохранить плейлисты на устройстве.'); }
  }

  function playbackIdsForView() {
    if (state.view === 'playlists') {
      const playlist = playlistById(state.currentPlaylistId);
      if (playlist) return uniqueTrackIds(playlist.trackIds);
    }
    if (state.view === 'queue' && state.playbackOrder.length) return uniqueTrackIds(state.playbackOrder);
    return state.tracks.map((track) => track.id);
  }

  function viewTracks() {
    let tracks = state.tracks;
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
      button.classList.toggle('active', button.dataset.view === state.view);
    });
    if (isYoutube || isSettings || isPlaylists) return;
    if (!tracks.length) { list.innerHTML = emptyMarkup(); return; }
    list.innerHTML = tracks.map((track) => {
      const active = currentTrack();
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
        '<button class="track-action playlist-add-action" data-action="add-to-playlist" data-id="' + esc(track.id) + '" aria-label="Добавить в плейлист" title="Добавить в плейлист"><svg viewBox="0 0 24 24"><path d="M4 3h10l4 4v6M14 3v5h4M7 11h7M7 15h5M18 16v6m-3.5-3h7"/></svg></button>';
      return '<article class="track-row' + (playing ? ' playing' : '') + '" data-track="' + esc(track.id) + '">' +
        coverMarkup(track) +
        '<div class="track-main" data-action="play" data-id="' + esc(track.id) + '" role="button" tabindex="0" aria-label="Воспроизвести ' + esc(track.name) + '">' +
          '<div class="track-name">' + esc(track.name) + '</div><div class="track-artist">' + esc(track.artist || 'Неизвестный исполнитель') + '</div>' +
        '</div>' +
        '<div class="track-meta">' + meta + '</div>' +
        '<div class="track-actions">' + mainAction + playlistAction + '</div></article>';
    }).join('');
  }

  function renderPlaylistTrack(track) {
    return '<article class="track-row" data-playlist-track="' + esc(track.id) + '">' +
      coverMarkup(track) +
      '<div class="track-main" data-action="play" data-id="' + esc(track.id) + '" role="button" tabindex="0" aria-label="Воспроизвести ' + esc(track.name) + '">' +
        '<div class="track-name">' + esc(track.name) + '</div><div class="track-artist">' + esc(track.artist || 'Неизвестный исполнитель') + '</div>' +
      '</div><div class="track-meta">' + (Number(track.duration) > 0 ? formatTime(track.duration) : '—:—') + '</div>' +
      '<div class="track-actions">' +
        '<button class="track-action" data-action="enqueue" data-id="' + esc(track.id) + '" aria-label="Добавить в очередь" title="В очередь"><svg viewBox="0 0 24 24"><path d="M4 6h12M4 12h12M4 18h7M19 14v7m-3.5-3.5h7"/></svg></button>' +
        '<button class="track-action" data-playlist-action="remove-track" data-id="' + esc(track.id) + '" aria-label="Убрать из плейлиста" title="Убрать из плейлиста"><svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg></button>' +
      '</div></article>';
  }

  function renderPlaylists() {
    const root = $('#playlistContent');
    if (!root) return;
    const playlist = playlistById(state.currentPlaylistId);
    if (playlist) {
      const tracks = uniqueTrackIds(playlist.trackIds).map(trackById).filter(Boolean);
      const content = tracks.length
        ? '<div class="track-list playlist-track-list">' + tracks.map(renderPlaylistTrack).join('') + '</div>'
        : '<div class="empty-state playlist-drop-target" data-playlist-drop="' + esc(playlist.id) + '"><div class="empty-glyph">♫</div><h3>Плейлист пуст</h3><p>Добавь файлы музыки сюда или нажми кнопку добавления. Добавленные треки останутся и в общей медиатеке.</p><button class="primary-button" data-playlist-action="add-music" data-id="' + esc(playlist.id) + '" type="button">＋ Добавить музыку</button><button class="secondary-button" data-playlist-action="back" type="button">Моя музыка</button></div>';
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
    root.innerHTML = '<div class="playlist-grid">' + state.playlists.map((item) => {
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

  function enqueueTracksFromCurrent(ids, label) {
    const order = uniqueTrackIds(ids);
    if (!order.length) { showToast('В этом списке пока нет треков.'); return; }
    const currentIndex = order.indexOf(state.currentId);
    const upcoming = currentIndex >= 0 ? order.slice(currentIndex + 1) : order;
    const queued = new Set(state.queue);
    if (state.currentId) queued.add(state.currentId);
    const additions = upcoming.filter((id) => !queued.has(id));
    state.queue.push(...additions);
    state.playbackOrder = order;
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

  function openAddToPlaylistDialog(trackId) {
    const track = trackById(trackId);
    if (!track) return;
    state.pendingPlaylistTrackId = trackId;
    $('#addToPlaylistTrackName').textContent = '«' + track.name + '»';
    $('#playlistTargetSelect').innerHTML = state.playlists.map((playlist) =>
      '<option value="' + esc(playlist.id) + '">' + esc(playlist.name) + '</option>').join('');
    if (!state.playlists.length) {
      $('#playlistTargetSelect').disabled = true;
      $('#addToPlaylistForm button[type="submit"]').disabled = true;
    } else {
      $('#playlistTargetSelect').disabled = false;
      $('#addToPlaylistForm button[type="submit"]').disabled = false;
    }
    $('#addToPlaylistDialog').showModal();
  }

  function addTrackToPlaylist(playlistId, trackId) {
    const playlist = playlistById(playlistId);
    if (!playlist || !trackById(trackId)) return;
    if (playlist.trackIds.includes(trackId)) {
      showToast('Этот трек уже есть в плейлисте.');
      return;
    }
    playlist.trackIds.push(trackId);
    savePlaylists();
    render();
    showToast('Добавлено в плейлист «' + playlist.name + '».');
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
    const knownDuration = native ? (state.nativeDuration || Number(track && track.duration) || 0) : (audioDuration || Number(track && track.duration) || 0);
    const elapsed = currentPlaybackPosition();
    $('#seek').disabled = !track || knownDuration <= 0;
    $('#duration').textContent = knownDuration > 0 ? formatTime(knownDuration) : (track ? '—:—' : '0:00');
    $('#elapsed').textContent = formatTime(elapsed);
    if (!state.seekDragging) $('#seek').value = knownDuration > 0 ? String(Math.round(Math.min(1, elapsed / knownDuration) * 1000)) : '0';
    $('#shuffle').classList.toggle('selected', state.shuffle);
    $('#repeat').classList.toggle('selected', state.repeat);
    $('#repeatDot').classList.toggle('hidden', !state.repeat);
    $('#repeat').title = state.repeat ? 'Повтор текущего трека включён' : 'Повтор выключен';
    if (track && !isNativePlaybackNotificationAvailable() && 'mediaSession' in navigator && typeof window.MediaMetadata === 'function') {
      const metadataKey = String(track.id) + '|' + coverUrl;
      try {
        if (state.lastMediaMetadataKey !== metadataKey) {
          const metadata = { title: track.name, artist: track.artist || 'Localify Crimson', album: 'Моя музыка' };
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
        state.queue = JSON.parse(localStorage.getItem('localify.mobile.queue') || '[]').filter((id) => ids.has(id));
      } catch (_) {
        state.queue = [];
      }
      try {
        const stored = JSON.parse(localStorage.getItem('localify.mobile.playlists') || '[]');
        state.playlists = Array.isArray(stored) ? stored.filter((item) => item && item.id && String(item.name || '').trim()).map((item) => ({
          id: String(item.id), name: String(item.name).trim().slice(0, 60),
          trackIds: uniqueTrackIds(Array.isArray(item.trackIds) ? item.trackIds : []),
          createdAt: Number(item.createdAt) || Date.now()
        })) : [];
      } catch (_) { state.playlists = []; }
      savePlaylists();
      state.playbackOrder = state.tracks.map((track) => track.id);
      render();
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
    const raw = String(filename || '').replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim();
    const sourceVideoId = extractYouTubeIdFromTitle(raw);
    const clean = cleanYouTubeTitle(raw, sourceVideoId);
    const parts = clean.split(/\s+-\s+/);
    if (parts.length >= 2) return { artist: parts.shift().trim(), name: parts.join(' - ').trim() || clean };
    return { artist: 'Неизвестный исполнитель', name: clean || 'Без названия' };
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
      }
      scheduleMissingDurations(attached);
      added = records.length;
    } catch (error) {
      console.error(error);
    }
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
    try { localStorage.setItem('localify.mobile.queue', JSON.stringify(state.queue)); } catch (_) {}
  }

  function enqueue(id) {
    if (!trackById(id)) return;
    if (state.queue.includes(id)) {
      showToast('Этот трек уже в очереди.');
      return;
    }
    state.queue.push(id);
    if (!state.playbackOrder.length) state.playbackOrder = state.tracks.map((track) => track.id);
    saveQueue();
    render();
    showToast('Добавлено в очередь.');
  }

  async function deleteTrack(id) {
    const track = trackById(id);
    if (!track) return;
    const wasCurrent = state.currentId === id || (state.currentRemoteTrack && state.currentRemoteTrack.id === id);
    if (wasCurrent && isNativePlaybackNotificationAvailable()) {
      try { await window.LocalifyPlayback.clear(); } catch (_) {}
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
    state.playlists.forEach((playlist) => { playlist.trackIds = playlist.trackIds.filter((item) => item !== id); });
    saveQueue();
    savePlaylists();
    try {
      await removeRecord(id);
      if (isNativePlaybackNotificationAvailable() &&
          window.LocalifyPlayback && typeof window.LocalifyPlayback.deleteTrackFile === 'function') {
        const nativeFiles = [track.nativePath, track.coverPath].filter(Boolean);
        for (const path of new Set(nativeFiles)) {
          try { await window.LocalifyPlayback.deleteTrackFile({ path }); } catch (_) {}
        }
      }
      releaseTrackUrls(track);
      render();
      showToast('Трек удалён из медиатеки.');
    } catch (error) {
      showToast('Не удалось удалить трек.');
      await loadLibrary();
    }
  }

  async function playTrack(id, orderIds) {
    const track = trackById(id);
    if (!track) return;
    if (Array.isArray(orderIds)) {
      state.playbackOrder = uniqueTrackIds(orderIds);
      if (!state.playbackOrder.includes(id)) state.playbackOrder.unshift(id);
    } else if (!state.playbackOrder.includes(id)) {
      state.playbackOrder = state.tracks.map((item) => item.id);
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
        await playTrack(firstId, order);
      } else {
        const available = playbackIdsForView();
        const firstId = available[0] || (state.tracks[0] && state.tracks[0].id);
        if (firstId) await playTrack(firstId, available.length ? available : state.tracks.map((item) => item.id));
        else {
          filePicker.click();
          showToast('Сначала добавь музыку в медиатеку.');
        }
      }
      return;
    }
    if (isNativePlaybackNotificationAvailable()) {
      const plugin = window.LocalifyPlayback;
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
    return order.length ? order : state.tracks.map((track) => track.id);
  }

  async function nextTrack(fromEnded) {
    if (isNativePlaybackNotificationAvailable()) {
      try {
        await window.LocalifyPlayback.next();
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
        await window.LocalifyPlayback.previous();
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
    return Boolean(window.LocalifyPlayback && window.Capacitor &&
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

  function startNativeProgressTimer() {
    if (state.nativeProgressTimer || !isNativePlaybackNotificationAvailable() || document.hidden || !state.isPlaying) return;
    state.nativeProgressTimer = setInterval(() => {
      if (document.hidden || !state.isPlaying) {
        stopNativeProgressTimer();
        return;
      }
      const duration = state.nativeDuration || Number(currentTrack() && currentTrack().duration) || 0;
      const position = currentPlaybackPosition();
      $('#elapsed').textContent = formatTime(position);
      if (duration > 0) $('#seek').value = String(Math.round(Math.min(1, position / duration) * 1000));
    }, 1000);
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
        title: String(item.name || 'Localify'),
        artist: String(item.artist || 'Неизвестный исполнитель'),
        artworkUri: nativeArtworkUriForTrack(item)
      });
    }
    return items;
  }

  async function syncNativePlayback(force = false) {
    const plugin = window.LocalifyPlayback;
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
          title: track.name || 'Localify',
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
        const plugin = window.LocalifyPlayback;
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
      $('#elapsed').textContent = formatTime(currentPlaybackPosition());
      if (!state.seekDragging && state.nativeDuration > 0) {
        $('#seek').value = String(Math.round(Math.min(1, currentPlaybackPosition() / state.nativeDuration) * 1000));
      }
    }
    state.applyingNativeSnapshot = false;
  }

  async function refreshNativePlaybackState() {
    const plugin = window.LocalifyPlayback;
    if (!isNativePlaybackNotificationAvailable() || !plugin || typeof plugin.getPlaybackState !== 'function') return;
    try {
      applyNativePlaybackState(await plugin.getPlaybackState());
    } catch (_) {}
  }

  function attachNativePlaybackListener() {
    const plugin = window.LocalifyPlayback;
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

  window.addEventListener('localify-playback-ready', attachNativePlaybackListener);
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
  $('#refreshLibraryFolder').addEventListener('click', () => refreshExternalLibrary({ force: true }));
  $('#chooseDownloadFolder').addEventListener('click', chooseDownloadFolder);
  $('#resetDownloadFolder').addEventListener('click', resetDownloadFolder);

  $('#copyDiagnosticLog').addEventListener('click', async () => {
    const plugin = window.LocalifyPlayback;
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
    const plugin = window.LocalifyPlayback;
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
  $('#searchInput').addEventListener('input', (event) => {
    state.query = event.currentTarget.value || '';
    clearTimeout(state.searchRenderTimer);
    state.searchRenderTimer = setTimeout(renderList, 70);
  });

  let suppressTrackClickUntil = 0;
  let suppressTrackClickId = '';
  function enableTrackPlaylistSwipe(container) {
    let start = null;
    container.addEventListener('pointerdown', (event) => {
      if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
      const row = event.target.closest('.track-row[data-track], .track-row[data-playlist-track]');
      if (!row || event.target.closest('input, select, textarea, a')) return;
      start = {
        x: event.clientX,
        y: event.clientY,
        id: row.dataset.track || row.dataset.playlistTrack || ''
      };
    });
    container.addEventListener('pointerup', (event) => {
      if (!start) return;
      const gesture = start;
      start = null;
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;
      if (!gesture.id || Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.25) return;
      event.preventDefault();
      suppressTrackClickId = gesture.id;
      suppressTrackClickUntil = Date.now() + 650;
      openAddToPlaylistDialog(gesture.id);
    });
    container.addEventListener('pointercancel', () => { start = null; });
  }
  enableTrackPlaylistSwipe($('#trackList'));
  enableTrackPlaylistSwipe($('#playlistContent'));

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
            playTrack(id, playback);
          } else playTrack(id, playbackIdsForView());
        } else playTrack(id, playbackIdsForView());
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

  $('#playlistContent').addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-action="play"]')) {
      event.preventDefault();
      const playlist = playlistById(state.currentPlaylistId);
      playTrack(event.target.dataset.id, playlist ? playlist.trackIds : state.tracks.map((track) => track.id));
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
    state.tracks.map((track) => track.id), 'медиатека'));

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

  $('#cancelAddToPlaylist').addEventListener('click', () => $('#addToPlaylistDialog').close());
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
    if (playlistId && trackId) addTrackToPlaylist(playlistId, trackId);
    state.pendingPlaylistTrackId = null;
    $('#addToPlaylistDialog').close();
  });

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
        playTrack(id, playlist ? playlist.trackIds : state.tracks.map((track) => track.id));
      } else if (trackAction.dataset.action === 'enqueue') enqueue(id);
      return;
    }
    const id = action.dataset.id;
    const actionType = action.dataset.playlistAction;
    const playlist = actionType === 'remove-track'
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
          state.currentPlaylistId = null;
          savePlaylists();
          render();
          showToast('Плейлист удалён.');
        }
        break;
      case 'remove-track':
        if (playlist) {
          playlist.trackIds = playlist.trackIds.filter((trackId) => trackId !== action.dataset.id);
          savePlaylists();
          renderPlaylists();
          showToast('Трек убран из плейлиста.');
        }
        break;
      case 'play-all':
        if (playlist) {
          const ids = uniqueTrackIds(playlist.trackIds);
          if (!ids.length) { showToast('Сначала добавь треки в плейлист.'); break; }
          state.currentPlaylistId = playlist.id;
          const startId = ids.includes(state.currentId) ? state.currentId : ids[0];
          const currentlyPlaying = isNativePlaybackNotificationAvailable() ? state.isPlaying : !audio.paused;
          if (state.currentId === startId && currentlyPlaying) {
            state.playbackOrder = ids;
            state.nativeQueueOrder = null;
            state.nativeQueueLastKey = '';
            void syncNativePlayback(true);
            showToast('Порядок плейлиста активен.');
          } else void playTrack(startId, ids);
        }
        break;
      case 'enqueue-from-current':
        if (playlist) enqueueTracksFromCurrent(playlist.trackIds, playlist.name);
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
  $('#seek').addEventListener('input', (event) => {
    state.seekDragging = true;
    const track = currentTrack();
    const duration = isNativePlaybackNotificationAvailable()
      ? (state.nativeDuration || Number(track && track.duration) || 0)
      : (Number.isFinite(audio.duration) ? audio.duration : 0);
    if (duration > 0) {
      const target = (Number(event.currentTarget.value) / 1000) * duration;
      $('#elapsed').textContent = formatTime(target);
    }
  });
  $('#seek').addEventListener('change', async (event) => {
    const track = currentTrack();
    const duration = isNativePlaybackNotificationAvailable()
      ? (state.nativeDuration || Number(track && track.duration) || 0)
      : (Number.isFinite(audio.duration) ? audio.duration : 0);
    if (duration > 0) {
      const target = (Number(event.currentTarget.value) / 1000) * duration;
      if (isNativePlaybackNotificationAvailable()) {
        state.nativePosition = target;
        state.nativePositionUpdatedAt = Date.now();
        try { await window.LocalifyPlayback.seekTo({ positionMs: Math.round(target * 1000) }); } catch (_) {}
      } else {
        audio.currentTime = target;
      }
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
    $('#elapsed').textContent = formatTime(currentTime);
    const duration = audio.duration;
    if (Number.isFinite(duration) && duration > 0) {
      $('#seek').value = String(Math.round((currentTime / duration) * 1000));
    }
  });
  audio.addEventListener('loadedmetadata', async () => {
    if (isNativePlaybackNotificationAvailable()) return;
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
    return Boolean(window.LocalifyYtDlp && window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
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
      const info = await window.LocalifyYtDlp.folderStatus();
      library.textContent = info.libraryFolderName ? 'Источник: ' + info.libraryFolderName + '. Разрешение сохранено.' : 'Папка не выбрана. Выбери каталог с музыкой на устройстве.';
      downloads.textContent = info.downloadFolderName ? 'Загрузки сохраняются в: ' + info.downloadFolderName + '.' : 'По умолчанию: Music/Localify Downloads.';
      ['chooseLibraryFolder','refreshLibraryFolder','chooseDownloadFolder','resetDownloadFolder'].forEach((id) => { const b=$('#'+id); if(b)b.disabled=false; });
    } catch (error) { library.textContent = 'Не удалось получить настройки папок: ' + (error?.message || error); }
  }

  async function refreshExternalLibrary(options = {}) {
    const silent = Boolean(options.silent);
    const force = Boolean(options.force);
    if (!nativeYtDlp() || !state.db) return;
    if (state.libraryRefreshing) {
      if (force) {
        state.libraryRefreshRequested = true;
        state.libraryRefreshRequestedSilent = silent;
      }
      return;
    }
    if (!force && state.lastFolderScanAt && Date.now() - state.lastFolderScanAt < 30000) return;
    state.libraryRefreshing = true;
    try {
      const result = await window.LocalifyYtDlp.scanLibraryFolder();
      if (result.selected === false) {
        state.lastFolderScanAt = Date.now();
        await refreshFolderSettings();
        return;
      }
      const sourceRows = Array.isArray(result.files) ? result.files : [];
      const rowBySource = new Map();
      for (const row of sourceRows) {
        if (!row || !row.path || !row.name) continue;
        const sourceId = String(row.sourceId || row.path);
        if (!rowBySource.has(sourceId)) rowBySource.set(sourceId, row);
      }
      const rows = Array.from(rowBySource.values()).filter((row) => {
        const youtubeId = extractYouTubeIdFromTitle(row.name);
        if (!youtubeId) return true;
        const sourceId = String(row.sourceId || row.path);
        const matching = state.tracks.filter((track) =>
          String(track.youtubeId || '') === youtubeId ||
          (/^[A-Za-z0-9_-]{11}$/.test(String(track.sourceId || '')) && String(track.sourceId) === youtubeId));
        if (!matching.length) return true;
        if (matching.some((track) => !String(track.id || '').startsWith('folder:'))) return false;
        return matching.some((track) =>
          String(track.id || '').startsWith('folder:') && String(track.sourceId || '') === sourceId);
      });
      const found = new Set(rows.map((row) => String(row.sourceId || row.path)));
      const previous = state.tracks.filter((track) => String(track.id || '').startsWith('folder:') && track.sourceId);
      const staleIds = previous.filter((track) => !found.has(String(track.sourceId))).map((track) => track.id);
      if (staleIds.length) await removeRecords(staleIds);
      const staleSet = new Set(staleIds);
      const remainingTracks = state.tracks.filter((track) => !staleSet.has(track.id));
      const existingBySource = new Map();
      for (const track of remainingTracks) {
        if (String(track.id || '').startsWith('folder:') && track.sourceId && !existingBySource.has(String(track.sourceId))) {
          existingBySource.set(String(track.sourceId), track);
        }
      }
      const nextFolderTracks = [];
      const recordsToSave = [];
      let added = 0;
      for (const row of rows) {
        const sourceId = String(row.sourceId || row.path);
        const old = existingBySource.get(sourceId);
        const names = parseFilename(row.name);
        const youtubeId = extractYouTubeIdFromTitle(row.name) || (old && old.youtubeId) || '';
        const record = {
          id: old ? old.id : 'folder:' + sourceId,
          name: names.name, artist: names.artist, blob: null,
          nativePath: row.path, sourceId, youtubeId,
          coverPath: row.coverPath || (old && old.coverPath) || '',
          coverUrl: (old && old.coverUrl) || (youtubeId
            ? 'https://i.ytimg.com/vi/' + encodeURIComponent(youtubeId) + '/hqdefault.jpg' : ''),
          coverBlob: (old && old.coverBlob) || null,
          addedAt: old ? old.addedAt : Date.now(),
          duration: Number(row.duration) > 0 ? Number(row.duration) : (old ? (Number(old.duration) || 0) : 0),
          size: Number(row.size) || 0
        };
        recordsToSave.push(record);
        nextFolderTracks.push(attachUrl(record));
        if (!old) added += 1;
      }
      if (recordsToSave.length) await putRecords(recordsToSave);
      const oldFolderIds = new Set(previous.map((track) => track.id));
      previous.forEach(releaseTrackUrls);
      state.tracks = remainingTracks.filter((track) => !oldFolderIds.has(track.id))
        .concat(nextFolderTracks)
        .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
      state.lastFolderScanAt = Date.now();
      await refreshFolderSettings();
      render();
      if (!silent) showToast('Папка просканирована: ' + pluralTracks(rows.length) + '.');
    } catch (error) {
      console.error('Library folder scan failed', error);
      if (!silent) showToast('Не удалось прочитать папку: ' + (error?.message || error));
    } finally {
      state.libraryRefreshing = false;
      if (state.libraryRefreshRequested) {
        const silentNext = state.libraryRefreshRequestedSilent;
        state.libraryRefreshRequested = false;
        state.libraryRefreshRequestedSilent = true;
        void refreshExternalLibrary({ silent: silentNext, force: true });
      }
    }
  }

  async function chooseLibraryFolder() {
    if (!nativeYtDlp()) { showToast('Выбор папки доступен только в установленном APK.'); return; }
    try {
      await window.LocalifyYtDlp.chooseLibraryFolder();
      await refreshExternalLibrary({ silent: true, force: true });
      showToast('Источник медиатеки обновлён.');
    } catch (error) { if (!String(error?.message || error).toLowerCase().includes('отмен')) showToast('Не удалось выбрать папку: ' + (error?.message || error)); }
  }

  async function chooseDownloadFolder() {
    if (!nativeYtDlp()) { showToast('Выбор папки доступен только в установленном APK.'); return; }
    try {
      await window.LocalifyYtDlp.chooseDownloadFolder();
      await refreshFolderSettings();
      showToast('Папка загрузок сохранена.');
    } catch (error) { if (!String(error?.message || error).toLowerCase().includes('отмен')) showToast('Не удалось выбрать папку: ' + (error?.message || error)); }
  }

  async function resetDownloadFolder() {
    if (!nativeYtDlp()) return;
    try {
      await window.LocalifyYtDlp.resetDownloadFolder();
      await refreshFolderSettings();
      showToast('Загрузки снова сохраняются в Music/Localify Downloads.');
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
      $('#youtubeSearchButton').disabled = true; $('#importCookies').disabled = true; $('#clearCookies').disabled = true;
      return;
    }
    $('#youtubeSearchButton').disabled = false; $('#importCookies').disabled = false; $('#clearCookies').disabled = false;
    try {
      const info = await window.LocalifyYtDlp.status();
      ytStatus('youtubedl-android ' + (info.version || 'готов') + ' · скачивание внутри Localify');
      $('#cookiesStatus').textContent = info.hasCookies ? 'Файл используется для поиска, прослушивания и скачивания в Localify.' : 'Если YouTube блокирует запросы, импортируй cookies.txt в формате Netscape.';
    } catch (error) { ytStatus('Не удалось проверить встроенный загрузчик: ' + (error?.message || error), true); }
  }
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
    root.innerHTML = rows.map((video) => {
      const id = esc(video.id), progress = state.ytDownloads[video.id];
      const downloading = progress && progress.status === 'downloading';
      const completed = progress && progress.status === 'done';
      const progressText = downloading ? ('Скачивание' + (progress.format ? ' ' + progress.format : '') + ' ' + Math.round(progress.progress || 0) + '%') : '';
      const downloadLabel = downloading ? progressText : (completed ? ('Скачано · ' + (progress.format || 'готово')) : (progress && progress.status === 'error' ? 'Повторить' : 'Скачать'));
      const downloadDisabled = downloading || completed;
      const thumb = video.thumbnail ? '<img class="youtube-thumb" loading="lazy" src="' + esc(video.thumbnail) + '" alt="">' : '<div class="youtube-thumb-fallback">♫</div>';
      return '<article class="youtube-result">' + thumb + '<div class="youtube-result-copy"><div class="youtube-title">' + esc(video.title || 'Без названия') + '</div>' +
        '<div class="youtube-meta">' + esc(video.channel || video.uploader || 'YouTube') + ' · ' + formatVideoDuration(video.duration) + '</div><div class="youtube-actions">' +
        '<button class="primary-action" data-youtube-action="play" data-id="' + id + '"' + (downloading ? ' disabled' : '') + '><svg viewBox="0 0 24 24"><path d="m8 5 12 7-12 7z"/></svg>Слушать</button>' +
        '<button data-youtube-action="download" data-id="' + id + '"' + (downloadDisabled ? ' disabled' : '') + '><svg viewBox="0 0 24 24"><path d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v3h16v-3"/></svg>' + downloadLabel + '</button>' +
        '</div></div></article>';
    }).join('');
  }
  function ytErrorMessage(error) {
    const message = String(error && error.message ? error.message : error || 'Неизвестная ошибка').trim();
    const lower = message.toLowerCase();
    if (/java\.util\.hashmap\.get|hashmap\.get takes 1 argument/.test(lower)) {
      return 'В приложении обнаружена ошибка параметров yt-dlp. Установи последнюю сборку Localify.';
    }
    if (/http error 403|403 forbidden/.test(lower)) {
      return message + ' YouTube отклонил запрос аудио (403). Повтори после обновления Localify; если ошибка останется, импортируй свежий cookies.txt из сеанса YouTube.';
    }
    if (/sign in|login required|cookies? required|confirm you.?re not a bot|not a bot|authentication|age.restricted|members.only|private video|captcha|verify you.?re human/.test(lower)) {
      return message + ' Возможно, YouTube требует входа: импортируй cookies.txt в формате Netscape.';
    }
    return message;
  }

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
      const result = await window.LocalifyYtDlp.search({ query: q });
      if (requestId !== state.ytSearchRequestId) return;
      const uniqueVideos = new Map();
      for (const item of (Array.isArray(result.results) ? result.results : [])) {
        if (!item || item.id == null) continue;
        const id = String(item.id);
        if (uniqueVideos.has(id)) continue;
        uniqueVideos.set(id, {
          ...item,
          id,
          title: cleanYouTubeTitle(item.title, id),
          thumbnail: item.thumbnail || ('https://i.ytimg.com/vi/' + encodeURIComponent(id) + '/hqdefault.jpg')
        });
      }
      state.ytResults = Array.from(uniqueVideos.values());
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
      const info = await window.LocalifyYtDlp.streamInfo({ url: video.url });
      if (!info.url) throw new Error('yt-dlp не вернул аудиопоток.');
      state.currentId = null;
      state.nativeQueueOrder = null;
      state.nativeQueueLastKey = '';
      state.currentRemoteTrack = {
        id:'youtube:'+video.id, name:info.title || video.title || 'YouTube',
        artist:info.artist || video.channel || video.uploader || 'YouTube',
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
  async function downloadYoutubeVideo(video) {
    if (!nativeYtDlp()) { showToast('Скачивание доступно в установленном Android APK.'); return; }
    state.ytDownloads[video.id] = {status:'downloading',progress:0}; renderOnlineResults();
    ytStatus('Скачиваю аудио в Localify: ' + (video.title || 'YouTube') + '…');
    try {
      const saved = await window.LocalifyYtDlp.downloadAudio({
        id: video.id,
        url: video.url,
        title: video.title || 'YouTube',
        artist: video.channel || video.uploader || 'YouTube',
        format: 'original'
      });
      const sourceId = String(video.id);
      const existing = state.tracks.find((track) =>
        String(track.sourceId || '') === sourceId ||
        String(track.youtubeId || '') === sourceId ||
        extractYouTubeIdFromTitle(track.name) === sourceId);
      const storedSourceId = existing && String(existing.id || '').startsWith('folder:')
        ? String(existing.sourceId || sourceId) : sourceId;
      const record = {
        id: existing ? existing.id : 'youtube:' + sourceId,
        name: cleanYouTubeTitle(saved.title || video.title || 'YouTube', sourceId),
        artist: video.channel || video.uploader || 'YouTube',
        blob: null,
        nativePath: saved.path,
        sourceId: storedSourceId,
        youtubeId: sourceId,
        coverUrl: video.thumbnail || ('https://i.ytimg.com/vi/' + encodeURIComponent(sourceId) + '/hqdefault.jpg'),
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
      render();
      ytStatus('Скачано в медиатеку Localify: ' + record.name + ' · формат: ' + (saved.format || 'не указан'));
      showToast('Трек скачан (' + (saved.format || 'формат не указан') + ') и добавлен в медиатеку');
    } catch (error) {
      state.ytDownloads[video.id] = {status:'error',progress:0};
      ytStatus('Не удалось скачать аудио: ' + ytErrorMessage(error), true);
    } finally { renderOnlineResults(); }
  }
  $('#youtubeSearchForm').addEventListener('submit', (event) => { event.preventDefault(); state.view = 'youtube'; void searchYoutube($('#youtubeQuery').value); });
  $('#youtubeResults').addEventListener('click', (event) => {
    const button = event.target.closest('[data-youtube-action]'); if (!button) return;
    const video = state.ytResults.find((item) => String(item.id) === String(button.dataset.id)); if (!video) return;
    if (button.dataset.youtubeAction === 'play') void playYoutubeVideo(video);
    if (button.dataset.youtubeAction === 'download') void downloadYoutubeVideo(video);
  });
  $('#importCookies').addEventListener('click', () => $('#cookiesPicker').click());
  $('#cookiesPicker').addEventListener('change', async (event) => {
    const file = event.currentTarget.files && event.currentTarget.files[0]; if (!file) return;
    if (!nativeYtDlp()) { ytStatus('Импорт cookies доступен только в установленном APK.', true); return; }
    try {
      const contents = await file.text();
      if (!contents.includes('# Netscape HTTP Cookie File') && !contents.includes('# HTTP Cookie File')) throw new Error('Файл не похож на cookies.txt в формате Netscape.');
      const result = await window.LocalifyYtDlp.saveCookies({content:contents});
      $('#cookiesStatus').textContent = 'cookies.txt импортирован (' + (result.count || 'готово') + ' строк) для поиска, прослушивания и скачивания в Localify.';
      ytStatus('Cookies сохранены в приватном каталоге приложения.');
    } catch (error) { ytStatus('Не удалось импортировать cookies.txt: ' + (error?.message || error), true); }
    finally { event.currentTarget.value = ''; }
  });
  $('#clearCookies').addEventListener('click', async () => {
    if (!nativeYtDlp()) return;
    try { await window.LocalifyYtDlp.clearCookies(); $('#cookiesStatus').textContent = 'Cookies Localify удалены.'; ytStatus('cookies.txt удалён.'); }
    catch (error) { ytStatus('Не удалось удалить cookies.txt: ' + (error?.message || error), true); }
  });
  function attachDownloadProgressListener() {
    const plugin = window.LocalifyYtDlp;
    if (!plugin || typeof plugin.addListener !== 'function' || state.downloadListenerAttached) return;
    state.downloadListenerAttached = true;
    plugin.addListener('downloadProgress', (event) => {
      if (!event || !event.id) return;
      state.ytDownloads[event.id] = {status:'downloading',progress:Number(event.progress)||0,eta:Number(event.eta)||0,format:String(event.format||''),message:String(event.message||'')};
      if (event.message) ytStatus(String(event.message));
      if (state.view === 'youtube') renderOnlineResults();
    });
  }

  window.addEventListener('localify-yt-dlp-ready', () => {
    attachDownloadProgressListener();
    if (state.db) void refreshFolderSettings();
  });
  attachDownloadProgressListener();

  // Avoid a full Android SAF folder scan on every app resume; loading, choosing
  // a source folder, or tapping "Пересканировать" is enough.

  loadLibrary();
})();
