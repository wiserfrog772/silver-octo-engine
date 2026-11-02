// Run with npm test; the ordering functions are intentionally pure and dependency-free.
const test = require('node:test');
const assert = require('node:assert/strict');

let movePlaylistTrack;
let movePlaylistTrackToPosition;
test('load playlist ordering helpers', async () => {
  ({ movePlaylistTrack, movePlaylistTrackToPosition } = await import('../www/modules/playlist-order.mjs'));
});

test('drag reorder can move a track to the beginning', () => {
  assert.deepEqual(movePlaylistTrack(['a', 'b', 'c', 'd'], 'd', 'a', 'before'), ['d', 'a', 'b', 'c']);
});

test('drag reorder can move a track to the end', () => {
  assert.deepEqual(movePlaylistTrack(['a', 'b', 'c', 'd'], 'a', 'd', 'after'), ['b', 'c', 'd', 'a']);
});

test('drag reorder inserts between two tracks without disturbing their relative order', () => {
  assert.deepEqual(movePlaylistTrack(['a', 'b', 'c', 'd', 'e'], 'e', 'c', 'before'), ['a', 'b', 'e', 'c', 'd']);
});

test('moving successive tracks is stable and does not create duplicates', () => {
  const first = movePlaylistTrack(['a', 'b', 'c', 'd'], 'd', 'a', 'before');
  const second = movePlaylistTrack(first, 'c', 'a', 'after');
  assert.deepEqual(second, ['d', 'a', 'c', 'b']);
  assert.equal(new Set(second).size, second.length);
});

test('move up and down match single-position movement', () => {
  assert.deepEqual(movePlaylistTrack(['a', 'b', 'c'], 'b', 'a', 'before'), ['b', 'a', 'c']);
  assert.deepEqual(movePlaylistTrack(['a', 'b', 'c'], 'b', 'c', 'after'), ['a', 'c', 'b']);
});

test('one-based position supports beginning, end and middle', () => {
  assert.deepEqual(movePlaylistTrackToPosition(['a', 'b', 'c', 'd'], 'c', 1), ['c', 'a', 'b', 'd']);
  assert.deepEqual(movePlaylistTrackToPosition(['a', 'b', 'c', 'd'], 'a', 4), ['b', 'c', 'd', 'a']);
  assert.deepEqual(movePlaylistTrackToPosition(['a', 'b', 'c', 'd'], 'd', 2), ['a', 'd', 'b', 'c']);
});

test('unchanged position is an immutable no-op', () => {
  const original = ['a', 'b', 'c'];
  const next = movePlaylistTrackToPosition(original, 'b', 2);
  assert.deepEqual(next, original);
  assert.notEqual(next, original);
  assert.deepEqual(original, ['a', 'b', 'c']);
});

test('invalid moves are rejected without mutating the source list', () => {
  const original = ['a', 'b', 'c'];
  assert.equal(movePlaylistTrack(original, 'x', 'a', 'before'), null);
  assert.equal(movePlaylistTrack(original, 'a', 'x', 'before'), null);
  assert.equal(movePlaylistTrack(original, 'a', 'a', 'after'), null);
  assert.equal(movePlaylistTrack(original, 'a', 'b', 'sideways'), null);
  assert.equal(movePlaylistTrackToPosition(original, 'a', 0), null);
  assert.equal(movePlaylistTrackToPosition(original, 'a', 4), null);
  assert.equal(movePlaylistTrackToPosition(original, 'a', 1.5), null);
  assert.deepEqual(original, ['a', 'b', 'c']);
});

test('the same track IDs can be reordered independently in different playlists', () => {
  const playlistOne = ['shared-song', 'x', 'y'];
  const playlistTwo = ['y', 'shared-song', 'z'];
  const updatedOne = movePlaylistTrack(playlistOne, 'y', 'shared-song', 'before');
  assert.deepEqual(updatedOne, ['y', 'shared-song', 'x']);
  assert.deepEqual(playlistTwo, ['y', 'shared-song', 'z']);
});
