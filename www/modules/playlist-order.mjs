/**
 * Pure playlist ordering helpers. Playlist IDs, rather than track metadata,
 * are the identity boundary so the same song can be ordered independently
 * in any number of playlists.
 */
export function movePlaylistTrack(ids, sourceId, targetId, placement = 'before') {
  if (!Array.isArray(ids) || !sourceId || !targetId || sourceId === targetId) return null;
  if (placement !== 'before' && placement !== 'after') return null;

  const sourceIndex = ids.indexOf(sourceId);
  const targetIndex = ids.indexOf(targetId);
  if (sourceIndex < 0 || targetIndex < 0) return null;

  const next = ids.slice();
  const [moving] = next.splice(sourceIndex, 1);
  const adjustedTargetIndex = next.indexOf(targetId);
  if (adjustedTargetIndex < 0) return null;
  next.splice(adjustedTargetIndex + (placement === 'after' ? 1 : 0), 0, moving);
  return next;
}

/** Move a track to a 1-based position. Invalid positions are rejected. */
export function movePlaylistTrackToPosition(ids, trackId, position) {
  if (!Array.isArray(ids) || !trackId) return null;
  const targetPosition = Number(position);
  const sourceIndex = ids.indexOf(trackId);
  if (sourceIndex < 0 || !Number.isInteger(targetPosition) ||
      targetPosition < 1 || targetPosition > ids.length) return null;
  if (sourceIndex === targetPosition - 1) return ids.slice();

  const next = ids.slice();
  const [moving] = next.splice(sourceIndex, 1);
  next.splice(targetPosition - 1, 0, moving);
  return next;
}
