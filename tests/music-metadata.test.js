'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

(async () => {
  const metadata = await import('../www/modules/music-metadata.mjs');
  const youtube = await import('../www/modules/youtube.mjs');
  const player = await import('../www/modules/player.mjs');
  const ui = await import('../www/modules/ui.mjs');

  const { cleanTrackTitle, cleanArtistName, resolveMusicMetadata, createAudioFilename } = metadata;

  test('удаляет типичные служебные приписки YouTube', () => {
    assert.equal(cleanTrackTitle('Artist - Song Name (Official Music Video) [4K] HD'), 'Artist - Song Name');
    assert.equal(cleanTrackTitle('Song Name | Official Audio | Lyrics | 1080p'), 'Song Name');
    assert.equal(cleanTrackTitle('Song Name • Visualizer [Full HD]'), 'Song Name');
    assert.equal(cleanTrackTitle('Song Name (Lyric Video) 720p'), 'Song Name');
    assert.equal(cleanTrackTitle('Song Name - Official Audio'), 'Song Name');
  });

  test('сохраняет значимые версии композиции и названия частей', () => {
    assert.equal(cleanTrackTitle('Song (Live Version) [Official Video]'), 'Song (Live Version)');
    assert.equal(cleanTrackTitle('Song (Acoustic Version) HD'), 'Song (Acoustic Version)');
    assert.equal(cleanTrackTitle('Song - Extended Mix Official Audio'), 'Song - Extended Mix');
    assert.equal(cleanTrackTitle('Song (Remastered 2024) [4K]'), 'Song (Remastered 2024)');
    assert.equal(cleanTrackTitle('Song (Radio Edit) Lyrics'), 'Song (Radio Edit)');
    assert.equal(cleanTrackTitle('Song, Pt. 2 (Instrumental)'), 'Song, Pt. 2 (Instrumental)');
    assert.equal(cleanTrackTitle('Song (Live at Wembley)'), 'Song (Live at Wembley)');
  });

  test('не удаляет слова, похожие на служебные, внутри названия', () => {
    assert.equal(cleanTrackTitle('Officially Yours'), 'Officially Yours');
    assert.equal(cleanTrackTitle('HD Dreams'), 'HD Dreams');
    assert.equal(cleanTrackTitle('Visualizer'), 'Visualizer');
    assert.equal(cleanTrackTitle('Song | My Official Remix'), 'Song | My Official Remix');
  });

  test('убирает повторный YouTube ID и нормализует разделители', () => {
    assert.equal(cleanTrackTitle('Song Name [abcdefghijk]  ' , 'abcdefghijk'), 'Song Name');
    assert.equal(cleanTrackTitle('  Song   Name   |   Official Audio  '), 'Song Name');
    assert.equal(cleanTrackTitle('Song Name ||| HD'), 'Song Name');
  });

  test('очищает имена каналов и удаляет только точные повторы', () => {
    assert.equal(cleanArtistName('Artist Name Official'), 'Artist Name');
    assert.equal(cleanArtistName('Artist Name - Topic'), 'Artist Name');
    assert.equal(cleanArtistName('Artist VEVO'), 'Artist');
    assert.equal(cleanArtistName('Artist Name (Official Artist Channel)'), 'Artist Name');
    assert.equal(cleanArtistName('Artist, Artist, Guest'), 'Artist, Guest');
    assert.equal(cleanArtistName('The Official Band'), 'The Official Band');
    assert.equal(cleanArtistName('A; B; a'), 'A, B');
    assert.equal(cleanArtistName(''), '');
  });

  test('выбирает структурированные данные и не выдумывает исполнителя', () => {
    const result = resolveMusicMetadata({
      track: 'Track Name (Official Audio)', title: 'Raw title [4K]',
      artists: ['Real Artist', 'Guest'], uploader: 'Channel Name - Topic',
      album: 'Album', release_date: '20240229', genre: ['Pop', 'Rock'], duration: 187.6
    });
    assert.deepEqual(result, {
      title: 'Track Name', artist: 'Real Artist, Guest', album: 'Album',
      year: '2024', genre: 'Pop, Rock', thumbnail: '', duration: 187.6
    });
    const unknownArtist = resolveMusicMetadata({ title: 'Track' });
    assert.equal(unknownArtist.artist, '');
    assert.equal(unknownArtist.title, 'Track');
  });

  test('имя файла безопасно и не содержит пустого исполнителя', () => {
    assert.equal(createAudioFilename(' Artist Official ', ' Song / Name [1080p] ', '.MP3'), 'Artist - Song _ Name.mp3');
    assert.equal(createAudioFilename('', 'Track Name', 'm4a'), 'Track Name.m4a');
    assert.equal(createAudioFilename('', '', 'mp3', 'a/b'), 'a_b.mp3');
  });

  test('нормализует результаты YouTube без дубликатов', () => {
    const results = youtube.normalizeYoutubeResults([
      { id: 'one', title: 'Song (Official Audio)', uploader: 'Artist - Topic' },
      { id: 'one', title: 'Duplicate' },
      { id: 'two', title: 'Live Song (Live Version)' },
      null
    ]);
    assert.equal(results.length, 2);
    assert.equal(results[0].title, 'Song');
    assert.equal(results[0].channel, 'Artist');
    assert.equal(results[1].title, 'Live Song (Live Version)');
    assert.match(results[0].thumbnail, /i\.ytimg\.com/);
  });

  test('валидация cookies принимает Netscape и отклоняет пустые/неполные/устаревшие файлы', () => {
    const active = [
      '# Netscape HTTP Cookie File',
      '.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsecret',
      '#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tLOGIN_INFO\tsecret2'
    ].join('\n');
    assert.equal(youtube.validateNetscapeCookies(active).valid, true);
    assert.equal(youtube.validateNetscapeCookies('').valid, false);
    assert.equal(youtube.validateNetscapeCookies('SID=secret').valid, false);
    const stale = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t1\tSID\tsecret';
    assert.equal(youtube.validateNetscapeCookies(stale).valid, false);
  });

  test('ошибка 403 объясняет ограничение PO Token, а FFmpeg выделяется отдельно', () => {
    assert.match(youtube.friendlyYoutubeError(new Error('HTTP Error 403: Forbidden')), /PO Token/);
    assert.match(youtube.friendlyYoutubeError(new Error('ffmpeg postprocessing failed')), /FFmpeg/);
  });

  test('поиск фильтрует плейлисты и треки без изменения исходных массивов', () => {
    const playlists = [{ name: 'Избранное' }, { name: 'Rock' }];
    assert.deepEqual(player.filterPlaylistCards(playlists, 'rock'), [{ name: 'Rock' }]);
    const tracks = [{ name: 'One', artist: 'Alpha' }, { name: 'Two', artist: 'Beta' }];
    assert.deepEqual(player.filterPlaylistTracks(tracks, 'beta'), [{ name: 'Two', artist: 'Beta' }]);
    assert.equal(playlists.length, 2);
    assert.equal(tracks.length, 2);
  });

  test('UI helpers корректно экранируют HTML и форматируют длительность', () => {
    assert.equal(ui.escapeHtml('<a "x">'), '&lt;a &quot;x&quot;&gt;');
    assert.equal(ui.formatTimeLabel(125.9), '2:05');
    assert.equal(ui.pluralTrackCount(21), '21 трек');
    assert.equal(ui.pluralTrackCount(24), '24 трека');
    assert.equal(ui.pluralTrackCount(12), '12 треков');
  });
})();
