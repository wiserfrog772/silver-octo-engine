export function uniqueExistingTrackIds(ids, hasTrack) {
  const seen = new Set();
  return (Array.isArray(ids) ? ids : []).filter((id) => {
    if (!hasTrack(id) || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function sortLibraryTracks(tracks, mode, collator) {
  const list = tracks.slice();
  if (mode === 'title') list.sort((a, b) => collator.compare(a.name || '', b.name || ''));
  else if (mode === 'artist') list.sort((a, b) => collator.compare(a.artist || '', b.artist || '') || collator.compare(a.name || '', b.name || ''));
  else list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  return list;
}

export function playbackIdsForView({ view, playlist, playbackOrder, libraryOrder, uniqueIds }) {
  if (view === 'playlists' && playlist) return uniqueIds(playlist.trackIds);
  if (view === 'queue' && playbackOrder.length) return uniqueIds(playbackOrder);
  return libraryOrder;
}

export function filterPlaylistCards(playlists, query) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  if (!needle) return playlists.slice();
  return playlists.filter((playlist) => String(playlist.name || '').toLocaleLowerCase().includes(needle));
}

export function filterPlaylistTracks(tracks, query) {
  const needle = String(query || '').trim().toLocaleLowerCase();
  if (!needle) return tracks.slice();
  return tracks.filter((track) => (`${track.name || ''} ${track.artist || ''}`).toLocaleLowerCase().includes(needle));
}
