/** Pure helpers for row gestures and seek-bar progress. */
export function classifyTrackSwipe(deltaX, deltaY, threshold = 68) {
  const x = Number(deltaX) || 0;
  const y = Number(deltaY) || 0;
  const absX = Math.abs(x);
  const absY = Math.abs(y);
  if (absX < 8 && absY < 8) return 'pending';
  if (absY > absX * 1.12) return 'vertical';
  if (absX > absY * 1.12 && x < 0) return 'left';
  if (absX > absY * 1.12 && x > 0) return x >= threshold ? 'commit' : 'right';
  return 'pending';
}

export function resolveSwipePlaylist(playlists, selectedPlaylistId, sourcePlaylistId = null) {
  const items = Array.isArray(playlists) ? playlists : [];
  const selected = items.find((item) => item && item.id === selectedPlaylistId && item.id !== sourcePlaylistId);
  return selected || null;
}

export function seekProgressPercent(position, duration) {
  const total = Number(duration);
  const current = Number(position);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(current) || current <= 0) return 0;
  return Math.max(0, Math.min(100, (current / total) * 100));
}
