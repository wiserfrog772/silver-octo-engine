const test = require('node:test');
const assert = require('node:assert/strict');

let m;
test.before(async () => { m = await import('../www/modules/track-identity.mjs'); });

const run = (input, ext = 'mp3') => m.buildTrackMetadata(input, ext);

test('1. исполнитель и название разделены дефисом; технические приписки убираются', () => {
  const r = run({ title: 'The Weeknd - Blinding Lights (Official Music Video)' });
  assert.equal(r.artist, 'The Weeknd');
  assert.equal(r.title, 'Blinding Lights');
  assert.equal(r.filename, 'The Weeknd - Blinding Lights.mp3');
  assert.equal(run({ title: 'Imagine Dragons - Believer Official Audio HD' }).title, 'Believer');
  const e = run({ title: 'Eminem - Mockingbird [Official Video] 1080p' });
  assert.deepEqual([e.artist, e.title, e.filename], ['Eminem', 'Mockingbird', 'Eminem - Mockingbird.mp3']);
});

test('2. исполнитель уже присутствует в Title', () => {
  const r = run({ title: 'Linkin Park - Numb', info: { artist: 'Linkin Park', track: 'Linkin Park - Numb' } });
  assert.equal(r.artist, 'Linkin Park');
  assert.equal(r.title, 'Numb');
  assert.equal(r.filename, 'Linkin Park - Numb.mp3');
});

test('3. исполнитель указан дважды', () => {
  assert.equal(run({ title: 'Linkin Park - Linkin Park - Numb', info: { artist: 'Linkin Park' } }).title, 'Numb');
  assert.equal(m.joinArtists(['Linkin Park', 'linkin park', 'Linkin Park']), 'Linkin Park');
  assert.equal(run({ title: 'x', info: { artists: ['Eminem', 'Eminem'], track: 'Lose Yourself' } }).artist, 'Eminem');
});

test('4. название не содержит исполнителя: исполнитель не выдумывается', () => {
  const r = run({ title: 'Numb' });
  assert.equal(r.artist, '');
  assert.equal(r.title, 'Numb');
  assert.equal(r.filename, 'Numb.mp3');
  // исполнитель из структурированных данных, название нетронуто
  const s = run({ title: 'Numb', info: { artist: 'Linkin Park' } });
  assert.deepEqual([s.artist, s.title], ['Linkin Park', 'Numb']);
});

test('5. несколько исполнителей', () => {
  const r = run({ title: 'Calvin Harris & Dua Lipa - One Kiss' });
  assert.equal(r.artist, 'Calvin Harris & Dua Lipa');
  assert.equal(r.title, 'One Kiss');
  const s = run({ title: 'Calvin Harris & Dua Lipa - One Kiss', info: { artists: ['Calvin Harris', 'Dua Lipa'] } });
  assert.equal(s.title, 'One Kiss');
  assert.equal(s.artist, 'Calvin Harris, Dua Lipa');
  // имя другого исполнителя в названии не удаляется
  const other = run({ title: 'Rihanna - Take Care', info: { artist: 'Drake' } });
  assert.deepEqual([other.artist, other.title], ['Drake', 'Rihanna - Take Care']);
});

test('6. Featuring сохраняется', () => {
  const a = run({ title: 'Drake ft. Rihanna - Take Care' });
  assert.equal(a.artist, 'Drake feat. Rihanna');
  assert.equal(a.title, 'Take Care');
  const b = run({ title: 'Drake - Take Care (feat. Rihanna)' });
  assert.equal(b.artist, 'Drake');
  assert.equal(b.title, 'Take Care (feat. Rihanna)');
  const c = run({ title: 'Drake - Take Care', info: { artist: 'Drake feat. Rihanna', track: 'Drake - Take Care' } });
  assert.equal(c.title, 'Take Care');
  assert.equal(c.artist, 'Drake feat. Rihanna');
});

test('7. разные виды тире', () => {
  for (const dash of ['-', '–', '—', '‒', '−']) {
    const r = run({ title: `Eminem ${dash} Mockingbird` });
    assert.deepEqual([r.artist, r.title], ['Eminem', 'Mockingbird'], dash);
  }
});

test('8. название само содержит дефис', () => {
  assert.equal(run({ title: 'Jay-Z - 99 Problems' }).artist, 'Jay-Z');
  assert.equal(run({ title: 'Jay-Z - 99 Problems' }).title, '99 Problems');
  const spider = run({ title: 'Post Malone - Sunflower - Spider-Man: Into the Spider-Verse' });
  assert.equal(spider.artist, 'Post Malone');
  assert.equal(spider.title, 'Sunflower - Spider-Man: Into the Spider-Verse');
  // без пробелов вокруг дефиса — это не разделитель
  assert.equal(run({ title: 'Self-Control' }).artist, '');
  assert.equal(run({ title: 'Self-Control' }).title, 'Self-Control');
  // «Название - Live» не считается «исполнитель - название»
  assert.equal(run({ title: 'Numb - Live' }).artist, '');
});

test('9. Remix, Live и Acoustic сохраняются', () => {
  assert.equal(run({ title: 'Avicii - Levels (Skrillex Remix)' }).title, 'Levels (Skrillex Remix)');
  assert.equal(run({ title: 'Coldplay - Yellow (Live Version) [Official Video]' }).title, 'Yellow (Live Version)');
  assert.equal(run({ title: 'Adele - Hello (Acoustic Version)' }).title, 'Hello (Acoustic Version)');
  assert.equal(run({ title: 'Artist - Song (Remix)', info: { artist: 'Artist' } }).filename, 'Artist - Song (Remix).mp3');
  assert.equal(m.stripArtistFromTitle('Linkin Park', 'Linkin Park - Live'), 'Linkin Park - Live');
});

test('10. метаданные исполнителя отсутствуют', () => {
  const r = run({ title: 'Some Instrumental Beat' });
  assert.equal(r.artist, '');
  assert.equal(r.source, 'unknown');
  assert.equal(r.tags.artist, '');
  // канал — слабый источник и только когда ничего другого нет
  const c = run({ title: 'Numb', info: { channel: 'Linkin Park - Topic' } });
  assert.equal(c.artist, 'Linkin Park');
  assert.equal(c.source, 'channel');
  // название никогда не копируется в Artist
  assert.notEqual(r.artist, r.title);
});

test('11. данные YouTube противоречат названию: приоритет у структурированных данных', () => {
  const r = run({ title: 'Eminem - Mockingbird', info: { artist: 'Linkin Park', track: 'Numb' } });
  assert.deepEqual([r.artist, r.title], ['Linkin Park', 'Numb']);
  assert.equal(r.source, 'structured');
  // Без поля track название не режем, если левая часть не совпадает с известным исполнителем
  const q = run({ title: 'Eminem - Mockingbird', info: { artist: 'Linkin Park' } });
  assert.equal(q.artist, 'Linkin Park');
  assert.equal(q.title, 'Eminem - Mockingbird');
});

test('12. значения для ID3-тегов, имени файла и библиотеки совпадают', () => {
  const r = run({ title: 'Linkin Park - Numb [Official Music Video]', info: { album: 'Meteora', release_date: '20030325', genre: 'Rock' } });
  assert.deepEqual(r.tags, { artist: 'Linkin Park', title: 'Numb', album: 'Meteora', date: '2003', genre: 'Rock' });
  assert.equal(r.filename, `${r.tags.artist} - ${r.tags.title}.mp3`);
  const lib = m.parseLibraryFilename(r.filename);
  assert.deepEqual([lib.artist, lib.name], [r.tags.artist, r.tags.title]);
  // запрещённые символы файловой системы заменяются, значения тегов остаются прежними
  const odd = run({ title: 'AC/DC - Who Made Who?' });
  assert.equal(odd.filename, 'AC_DC - Who Made Who_.mp3');
  assert.equal(odd.tags.artist, 'AC/DC');
});

test('имя файла из библиотеки с дублем исполнителя очищается', () => {
  const lib = m.parseLibraryFilename('Linkin Park - Linkin Park - Numb.mp3');
  assert.deepEqual([lib.artist, lib.name], ['Linkin Park', 'Numb']);
  assert.deepEqual(Object.values(m.parseLibraryFilename('Просто название.mp3')), ['', 'Просто название']);
});
