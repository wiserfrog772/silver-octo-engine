const test = require('node:test');
const assert = require('node:assert/strict');

let t; let c;
test.before(async () => {
  t = await import('../www/modules/track-identity.mjs');
  c = await import('../www/modules/music-metadata.mjs');
});
const run = (input, ext = 'mp3') => t.buildTrackMetadata(input, ext);
const pair = (r) => [r.artist, r.title];

test('РЕГРЕССИЯ: имя файла без расширения не обрезается по точке (первопричина)', () => {
  // Раньше «расширением» считалось всё после последней точки.
  assert.deepEqual(Object.values(t.parseLibraryFilename('Wiz Khalifa - See You Again (ft. Charlie Puth)')), ['Wiz Khalifa feat. Charlie Puth', 'See You Again']);
  assert.deepEqual(Object.values(t.parseLibraryFilename('Big Poe feat. Another Artist - Track Name')), ['Big Poe feat. Another Artist', 'Track Name']);
  // Номер позиции убран. Порядок «Исполнитель - Название» принят по умолчанию.
  assert.deepEqual(Object.values(t.parseLibraryFilename('123. GONE - Artist Name')), ['GONE', 'Artist Name']);
  assert.deepEqual(Object.values(t.parseLibraryFilename('Artist - Mr. Brightside')), ['Artist', 'Mr. Brightside']);
  // с настоящим расширением тоже работает, и расширение снимается ровно один раз
  assert.deepEqual(Object.values(t.parseLibraryFilename('Artist - Mr. Brightside.mp3')), ['Artist', 'Mr. Brightside']);
  assert.equal(t.stripAudioExtension('A - B (ft. C)'), 'A - B (ft. C)');
  assert.equal(t.stripAudioExtension('A - B.FLAC'), 'A - B');
});

test('1. обычное «Artist - Track»', () => {
  assert.deepEqual(pair(run({ title: 'Eminem - Mockingbird' })), ['Eminem', 'Mockingbird']);
});

test('2. название без исполнителя', () => {
  const r = run({ title: 'Mockingbird' });
  assert.deepEqual(pair(r), ['', 'Mockingbird']);
  assert.equal(r.filename, 'Mockingbird.mp3');
});

test('3. несколько исполнителей', () => {
  assert.deepEqual(pair(run({ title: 'Calvin Harris & Dua Lipa - One Kiss' })), ['Calvin Harris & Dua Lipa', 'One Kiss']);
  assert.deepEqual(pair(run({ title: 'x', info: { artists: ['Calvin Harris', 'Dua Lipa'], track: 'One Kiss' } })), ['Calvin Harris, Dua Lipa', 'One Kiss']);
});

test('4-6. feat. / ft. / featuring: ничего не теряется и не обрезается', () => {
  for (const word of ['feat.', 'ft.', 'featuring', 'Feat.', 'FT.', 'feat']) {
    const inArtist = run({ title: `Big Poe ${word} Another Artist - Track Name` });
    assert.deepEqual(pair(inArtist), [`Big Poe ${word === 'featuring' ? 'feat.' : /^feat$/i.test(word) ? 'feat.' : 'feat.'} Another Artist`, 'Track Name'], word);
    const inTitle = run({ title: `Wiz Khalifa - See You Again (${word} Charlie Puth)` });
    assert.deepEqual(pair(inTitle), ['Wiz Khalifa feat. Charlie Puth', 'See You Again'], word);
  }
  // квадратные скобки, без скобок, несколько гостей, гость уже в списке исполнителей
  assert.deepEqual(pair(run({ title: 'Artist - Song [feat. A & B]' })), ['Artist feat. A & B', 'Song']);
  assert.deepEqual(pair(run({ title: 'Artist - Song feat. Guest' })), ['Artist feat. Guest', 'Song']);
  assert.deepEqual(pair(run({ title: 'Artist - Song feat. Guest (Remix)' })), ['Artist feat. Guest', 'Song (Remix)']);
  assert.deepEqual(pair(run({ title: 'x', info: { artists: ['Wiz Khalifa', 'Charlie Puth'], track: 'See You Again (feat. Charlie Puth)' } })), ['Wiz Khalifa, Charlie Puth', 'See You Again']);
  // слово feat без имени после него — не маркер
  assert.deepEqual(pair(run({ title: 'Artist - Feat' })), ['Artist', 'Feat']);
  // структурированный исполнитель + название со «feat» слева
  assert.deepEqual(pair(run({ title: 'Big Poe feat. Guest - Track', info: { artist: 'Big Poe' } })), ['Big Poe feat. Guest', 'Track']);
  // без исполнителя гостя некуда переносить: название сохраняется целиком
  assert.deepEqual(pair(run({ title: 'Song (feat. Guest)' })), ['', 'Song (feat. Guest)']);
});

test('7-8. цифры: номер позиции убирается, настоящие названия сохраняются', () => {
  // Номер позиции убран; без данных об исполнителе действует соглашение «Исполнитель - Название»
  assert.deepEqual(pair(run({ title: '123. GONE - Artist Name' })), ['GONE', 'Artist Name']);
  // Если известный исполнитель совпадает с правой частью, это «Название - Исполнитель»
  assert.deepEqual(pair(run({ title: '123. GONE - Artist Name', info: { artist: 'Artist Name' } })), ['Artist Name', 'GONE']);
  assert.deepEqual(pair(run({ title: 'GONE - Artist Name', info: { artist: 'Artist Name' } })), ['Artist Name', 'GONE']);
  assert.deepEqual(pair(run({ title: '01 - Artist Name - GONE' })), ['Artist Name', 'GONE']);
  assert.deepEqual(pair(run({ title: '7) Artist - Song' })), ['Artist', 'Song']);
  for (const title of ['7 rings', '21 Guns', '123', '1999', '2 Become 1', '99 Problems', '3005', '22']) {
    const r = run({ title });
    assert.deepEqual(pair(r), ['', title], title);
  }
  assert.deepEqual(pair(run({ title: 'Ariana Grande - 7 rings' })), ['Ariana Grande', '7 rings']);
  assert.deepEqual(pair(run({ title: 'Green Day - 21 Guns (Official Video)' })), ['Green Day', '21 Guns']);
  assert.deepEqual(pair(run({ title: 'Prince - 1999' })), ['Prince', '1999']);
  assert.deepEqual(pair(run({ title: 'Artist - 123' })), ['Artist', '123']);
  assert.deepEqual(pair(run({ title: 'Blink-182 - All The Small Things' })), ['Blink-182', 'All The Small Things']);
  // без точки/скобки и без разделителя цифры не считаются номером
  assert.deepEqual(pair(run({ title: '123. GONE' })), ['', '123. GONE']);
  // структурированное название не портится
  assert.deepEqual(pair(run({ title: 'x', info: { artist: 'Artist', track: '123. GONE' } })), ['Artist', '123. GONE']);
});

test('9. скобки: настоящие части названия не удаляются', () => {
  assert.equal(run({ title: 'Artist - Song (Why Do Lyrics Hurt)' }).title, 'Song (Why Do Lyrics Hurt)');
  assert.equal(run({ title: 'Artist - Song [Black Parade 4K Edition]' }).title, 'Song [Black Parade 4K Edition]');
  assert.equal(run({ title: 'Artist - Song (Part 2)' }).title, 'Song (Part 2)');
  assert.equal(run({ title: 'Artist - (Everything I Do) I Do It For You' }).title, '(Everything I Do) I Do It For You');
  assert.equal(run({ title: 'Artist - Song (Official Video)' }).title, 'Song');
  assert.equal(run({ title: 'Lyrics' }).title, 'Lyrics');
});

test('10. дефисы', () => {
  assert.deepEqual(pair(run({ title: 'Jay-Z - Run This Town' })), ['Jay-Z', 'Run This Town']);
  assert.deepEqual(pair(run({ title: 'Artist - Spider-Man - Theme' })), ['Artist', 'Spider-Man - Theme']);
  assert.deepEqual(pair(run({ title: 'Self-Control' })), ['', 'Self-Control']);
});

test('11. Remix и Live сохраняются', () => {
  assert.equal(run({ title: 'Avicii - Levels (Skrillex Remix)' }).title, 'Levels (Skrillex Remix)');
  assert.equal(run({ title: 'Coldplay - Yellow (Live at Wembley)' }).title, 'Yellow (Live at Wembley)');
  assert.equal(run({ title: 'Artist - Song (Remastered 2011) [Official Audio]' }).title, 'Song (Remastered 2011)');
  assert.equal(run({ title: 'Artist - Song (Radio Edit)' }).title, 'Song (Radio Edit)');
  assert.equal(run({ title: 'Artist - Song (Extended Mix)' }).title, 'Song (Extended Mix)');
});

test('12. Official Audio / Lyrics и другой мусор убираются только как мусор', () => {
  assert.equal(run({ title: 'Imagine Dragons - Believer Official Audio HD' }).title, 'Believer');
  assert.equal(run({ title: 'Artist - Song (Lyrics)' }).title, 'Song');
  assert.equal(run({ title: 'Artist - Song [Lyric Video] 4K' }).title, 'Song');
  assert.equal(run({ title: 'Artist - Song | Official Music Video' }).title, 'Song');
  assert.equal(run({ title: 'Artist - Song (1080p)' }).title, 'Song');
});

test('13. нет структурированных метаданных', () => {
  assert.deepEqual(pair(run({ title: 'The Weeknd - Blinding Lights (Official Music Video)', info: {} })), ['The Weeknd', 'Blinding Lights']);
  assert.deepEqual(pair(run({ title: 'The Weeknd - Blinding Lights' })), ['The Weeknd', 'Blinding Lights']);
});

test('14. канал не подменяет исполнителя', () => {
  // обычный канал — не исполнитель
  assert.deepEqual(pair(run({ title: 'Mockingbird', info: { channel: 'Best Music 2024', uploader: 'Best Music 2024' } })), ['', 'Mockingbird']);
  // реальный исполнитель важнее канала
  const r = run({ title: 'Artist - Song', info: { channel: 'Some Label Records' } });
  assert.deepEqual(pair(r), ['Artist', 'Song']);
  const s = run({ title: 'Song', info: { artists: ['Real Artist'], track: 'Song', channel: 'Fan Channel' } });
  assert.deepEqual(pair(s), ['Real Artist', 'Song']);
  // автоматические каналы «- Topic» и VEVO — надёжный источник
  assert.equal(run({ title: 'Song', info: { channel: 'Real Artist - Topic' } }).artist, 'Real Artist');
  assert.equal(run({ title: 'Song', info: { uploader: 'ArtistVEVO' } }).source, 'channel');
  // слабый «artist» из результатов поиска (канал) не используется при скачивании
  assert.equal(run({ title: 'Song', artist: 'Some Channel' }).artist, '');
});

test('приоритет структурированных полей: artists > artist > album_artist > creator', () => {
  const base = { title: 'x', track: 'Song' };
  assert.equal(run({ title: 'x', info: { ...base, artists: ['A1', 'A2'], artist: 'B', album_artist: 'C', creator: 'D' } }).artist, 'A1, A2');
  assert.equal(run({ title: 'x', info: { ...base, artist: 'B', album_artist: 'C', creator: 'D' } }).artist, 'B');
  assert.equal(run({ title: 'x', info: { ...base, album_artist: 'C', creator: 'D' } }).artist, 'C');
  assert.equal(run({ title: 'x', info: { ...base, creator: 'D' } }).artist, 'D');
  assert.equal(run({ title: 'x', info: { ...base, artist: 'B', uploader: 'U', channel: 'Ch' } }).artist, 'B');
});

test('15. дублирование исполнителя в Title', () => {
  assert.deepEqual(pair(run({ title: 'x', info: { artist: 'Linkin Park', track: 'Linkin Park - Numb' } })), ['Linkin Park', 'Numb']);
  assert.deepEqual(pair(run({ title: 'Linkin Park - Linkin Park - Numb', info: { artist: 'Linkin Park' } })), ['Linkin Park', 'Numb']);
  // исполнитель, который является частью настоящего названия, не удаляется
  assert.deepEqual(pair(run({ title: 'x', info: { artist: 'Queen', track: 'Queen of Hearts' } })), ['Queen', 'Queen of Hearts']);
});

test('16. разные языки и символы', () => {
  assert.deepEqual(pair(run({ title: 'Ленинград — Экспонат (Official Video)' })), ['Ленинград', 'Экспонат']);
  assert.deepEqual(pair(run({ title: 'YOASOBI - アイドル (Official Music Video)' })), ['YOASOBI', 'アイドル']);
  assert.deepEqual(pair(run({ title: 'BTS (방탄소년단) - Dynamite' })), ['BTS (방탄소년단)', 'Dynamite']);
  assert.deepEqual(pair(run({ title: 'Björk - Jóga' })), ['Björk', 'Jóga']);
  assert.deepEqual(pair(run({ title: 'Артист feat. Гость - Песня (ft. Ещё Один)' })), ['Артист feat. Гость & Ещё Один', 'Песня']);
});

test('17. цифры, буквы и спецсимволы', () => {
  assert.deepEqual(pair(run({ title: 'P!nk - Just Give Me a Reason' })), ['P!nk', 'Just Give Me a Reason']);
  assert.deepEqual(pair(run({ title: 'AC/DC - T.N.T.' })), ['AC/DC', 'T.N.T.']);
  assert.deepEqual(pair(run({ title: '$uicideboy$ - Paris' })), ['$uicideboy$', 'Paris']);
  assert.deepEqual(pair(run({ title: 'Mr. Oizo - Flat Beat' })), ['Mr. Oizo', 'Flat Beat']);
  assert.deepEqual(pair(run({ title: 'Artist - Song #1 (2020 Mix)' })), ['Artist', 'Song #1 (2020 Mix)']);
  assert.deepEqual(pair(run({ title: '2Pac - 2 of Amerikaz Most Wanted' })), ['2Pac', '2 of Amerikaz Most Wanted']);
  assert.deepEqual(pair(run({ title: 'Artist - Song: The Sequel' })), ['Artist', 'Song: The Sequel']);
});

test('если разделить нельзя — название сохраняется целиком и не пустеет', () => {
  for (const title of ['Official Video', 'HD', '(feat.)', '!!!', 'a - b - c - d']) {
    const r = run({ title });
    assert.equal(r.title, title === 'a - b - c - d' ? 'b - c - d' : title, title);
    assert.notEqual(r.title, 'Без названия', title);
  }
  assert.equal(run({ title: '' }).title, 'Без названия');
});

test('сквозная проверка: тег == имя файла == разбор имени из библиотеки (для всего корпуса)', () => {
  const corpus = [
    'Wiz Khalifa - See You Again (feat. Charlie Puth)', 'Big Poe feat. Another Artist - Track Name', '123. GONE - Artist Name',
    'Ariana Grande - 7 rings', 'Green Day - 21 Guns (Official Video)', 'Eminem - Mockingbird [Official Video] 1080p', 'Artist - Mr. Brightside',
    'Avicii - Levels (Skrillex Remix)', 'Imagine Dragons - Believer Official Audio HD', 'Ленинград — Экспонат', 'AC/DC - T.N.T.',
    'Artist - Song (ft. A & B) [Lyrics]', 'Mockingbird', '7 rings', 'Jay-Z - Run This Town', 'Artist - Song (Part 2)'
  ];
  for (const title of corpus) {
    const meta = run({ title });
    const lib = t.parseLibraryFilename(meta.filename);
    // символы, недопустимые в имени файла, заменяются на «_» только там; для корпуса их нет, кроме «/»
    const expectArtist = meta.artist.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
    // имя файла не может заканчиваться точкой или пробелом: это единственное допустимое отличие
    const noTrail = (v) => v.replace(/[. ]+$/g, '');
    assert.equal(noTrail(lib.artist), noTrail(expectArtist), title + ' [artist]');
    assert.equal(noTrail(lib.name), noTrail(meta.title.replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim()), title + ' [title]');
    assert.ok(meta.filename.endsWith('.mp3'));
    assert.equal(meta.tags.artist, meta.artist);
    assert.equal(meta.tags.title, meta.title);
  }
});

test('очистка: служебные пометки убираются, всё остальное остаётся', () => {
  assert.equal(c.cleanTrackTitle('Song (Why Do Lyrics Hurt)'), 'Song (Why Do Lyrics Hurt)');
  assert.equal(c.cleanTrackTitle('Lyrics'), 'Lyrics');
  assert.equal(c.cleanTrackTitle('HD'), 'HD');
  assert.equal(c.cleanTrackTitle('See You Again (ft. Charlie Puth)'), 'See You Again (ft. Charlie Puth)');
});
