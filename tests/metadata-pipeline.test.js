const test = require('node:test');
const assert = require('node:assert/strict');

let t; let m; let b;
test.before(async () => {
  t = await import('../www/modules/track-identity.mjs');
  m = await import('../www/modules/library-match.mjs');
  b = await import('../www/modules/scan-plan.mjs');
});

// Реалистичные ответы yt-dlp (поля как в реальных JSON).
const SAMPLES = [
  { info: { id: 'JGwWNGJdvx8', title: 'Ed Sheeran - Shape of You [Official Video]', channel: 'Ed Sheeran', uploader: 'Ed Sheeran', artist: 'Ed Sheeran', track: 'Shape of You', album: '÷ (Deluxe)', release_date: '20170106' }, want: ['Ed Sheeran', 'Shape of You'] },
  { info: { id: 'hT_nvWreIhg', title: 'Wiz Khalifa - See You Again ft. Charlie Puth [Official Video] Furious 7', channel: 'Wiz Khalifa', artists: ['Wiz Khalifa', 'Charlie Puth'], track: 'See You Again (feat. Charlie Puth)' }, want: ['Wiz Khalifa, Charlie Puth', 'See You Again'] },
  { info: { id: 'CevxZvSJLk8', title: 'Katy Perry - Roar (Official)', channel: 'Katy Perry', uploader: 'Katy Perry' }, want: ['Katy Perry', 'Roar'] },
  { info: { id: 'aaaaaaaaaaa', title: 'Big Poe feat. Another Artist - Track Name (Lyrics)', channel: 'Random Uploads', uploader: 'Random Uploads' }, want: ['Big Poe feat. Another Artist', 'Track Name'] },
  { info: { id: 'bbbbbbbbbbb', title: '7 rings', channel: 'Ariana Grande', uploader: 'Ariana Grande' }, want: ['', '7 rings'] },
  { info: { id: 'ccccccccccc', title: 'Mockingbird', channel: 'Eminem - Topic', uploader: 'Eminem - Topic' }, want: ['Eminem', 'Mockingbird'] },
  { info: { id: 'ddddddddddd', title: 'Ленинград - Экспонат [Official Video]', channel: 'Ленинград', uploader: 'Ленинград' }, want: ['Ленинград', 'Экспонат'] },
  { info: { id: 'eeeeeeeeeee', title: '21 Guns (Official Music Video)', channel: 'Green Day', artist: 'Green Day', track: '21 Guns' }, want: ['Green Day', '21 Guns'] }
];

test('все этапы дают одни и те же значения: yt-dlp → теги → имя файла → библиотека → отображение → сопоставление', () => {
  for (const { info, want } of SAMPLES) {
    // 1-4. получение, определение, нормализация
    const meta = t.buildTrackMetadata({ title: info.title, videoId: info.id, info }, 'mp3');
    assert.deepEqual([meta.artist, meta.title], want, info.title);
    // 5-6. что получит yt-dlp в теги и как называется файл
    assert.equal(meta.tags.artist, meta.artist);
    assert.equal(meta.tags.title, meta.title);
    assert.equal(meta.filename, (meta.artist ? meta.artist + ' - ' : '') + meta.title + '.mp3');
    // 7-8. файл попал в выбранную папку и был прочитан сканированием
    const record = t.libraryNameFromFilename(meta.filename);
    assert.equal(record.artist, meta.artist, 'библиотека: исполнитель — ' + info.title);
    assert.equal(record.name, meta.title, 'библиотека: название — ' + info.title);
    // 9. интерфейс показывает значения записи; неизвестный исполнитель — нейтральная подпись
    const shown = { artist: record.artist || 'Неизвестный исполнитель', name: record.name };
    assert.ok(shown.name.length > 0);
    // сопоставление YouTube ↔ библиотека находит этот же трек как точное совпадение
    const matcher = m.createLibraryMatcher();
    matcher.update([{ id: 'folder:x', name: shown.name, artist: shown.artist, duration: 200 }]);
    const found = matcher.match({ title: info.title, channel: info.channel, duration: 200 });
    assert.equal(found.trackId, 'folder:x', info.title);
    assert.ok(['exact', 'high'].includes(found.level), info.title + ' → ' + found.level);
  }
});

test('планировщик сканирования не искажает имена: дубликаты по отпечатку находятся и с точками в названии', () => {
  const rows = [
    { sourceId: 'a', name: 'Artist - Song (ft. X).mp3', size: 1234 },
    { sourceId: 'b', name: 'Artist - Song (ft. X).mp3', size: 1234 }
  ];
  const plan = b.planLibrarySync([], rows);
  assert.equal(plan.add.length, 1);
  assert.equal(plan.duplicates.length, 1);
  assert.equal(b.fileFingerprint(rows[0]), b.fileFingerprint(rows[1]));
});
