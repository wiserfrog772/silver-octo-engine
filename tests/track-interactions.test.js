const test = require('node:test');
const assert = require('node:assert/strict');

let classifyTrackSwipe;
let resolveSwipePlaylist;
let seekProgressPercent;
test('load track interaction helpers', async () => {
  ({ classifyTrackSwipe, resolveSwipePlaylist, seekProgressPercent } = await import('../www/modules/track-interactions.mjs'));
});

test('swipe recognizer accepts a decisive right gesture only after the threshold', () => {
  assert.equal(classifyTrackSwipe(24, 2), 'right');
  assert.equal(classifyTrackSwipe(70, 3), 'commit');
  assert.equal(classifyTrackSwipe(60, 8), 'right');
});

test('vertical scrolling is not interpreted as a playlist swipe', () => {
  assert.equal(classifyTrackSwipe(8, 24), 'vertical');
  assert.equal(classifyTrackSwipe(18, 40), 'vertical');
});

test('leftward and ambiguous gestures do not add tracks', () => {
  assert.equal(classifyTrackSwipe(-90, 0), 'left');
  assert.equal(classifyTrackSwipe(20, 18), 'pending');
  assert.equal(classifyTrackSwipe(3, 2), 'pending');
});

test('swipe target uses the remembered playlist but never the source playlist', () => {
  const playlists = [{ id: 'one', trackIds: [] }, { id: 'two', trackIds: [] }];
  assert.equal(resolveSwipePlaylist(playlists, 'one', null).id, 'one');
  assert.equal(resolveSwipePlaylist(playlists, 'one', 'one'), null);
  assert.equal(resolveSwipePlaylist(playlists, 'missing', null), null);
});

test('seek progress clamps unknown, invalid and out-of-range positions', () => {
  assert.equal(seekProgressPercent(42, 240), 17.5);
  assert.equal(seekProgressPercent(300, 240), 100);
  assert.equal(seekProgressPercent(-1, 240), 0);
  assert.equal(seekProgressPercent(42, 0), 0);
  assert.equal(seekProgressPercent(Number.NaN, 240), 0);
});
