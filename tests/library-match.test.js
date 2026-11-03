const test = require('node:test');
const assert = require('node:assert/strict');

let m;
test.before(async () => { m = await import('../www/modules/library-match.mjs'); });

const lib = [
  { id: 'a', name: 'Numb', artist: 'Linkin Park', duration: 185 },
  { id: 'b', name: 'Blinding Lights', artist: 'The Weeknd', duration: 200 },
  { id: 'c', name: 'Levels', artist: 'Avicii', duration: 203 },
  { id: 'd', name: 'Hello', artist: 'Adele', duration: 295 },
  { id: 'e', name: 'Без названия трека', artist: 'Неизвестный исполнитель', duration: 0 },
  { id: 'f', name: 'Believer', artist: 'Imagine Dragons', duration: 204 },
  { id: 'g', name: 'Live Forever', artist: 'Oasis', duration: 276 }
];
const make = (tracks = lib) => { const x = m.createLibraryMatcher(); x.update(tracks); return x; };

test('1. трек, который уже есть: точное совпадение несмотря на приписки и регистр', () => {
  const x = make();
  for (const title of ['Linkin Park - Numb (Official Music Video)', 'LINKIN PARK – NUMB [Official Audio] HD', 'linkin  park - numb lyrics']) {
    const r = x.match({ title, duration: 187 });
    assert.equal(r.level, 'exact', title);
    assert.equal(r.trackId, 'a');
  }
  assert.equal(m.matchBadge(x.match({ title: 'Linkin Park - Numb' })).tone, 'success');
});

test('2-3. похожий трек и другое написание названия', () => {
  const x = make();
  const r = x.match({ title: 'The Weeknd - Blinding Light', duration: 200 });
  assert.equal(r.trackId, 'b');
  assert.ok(['high', 'partial'].includes(r.level));
  assert.equal(m.matchBadge(r).tone, 'warning');
  // «The» и диакритика не мешают
  assert.equal(x.match({ title: 'Weeknd - Blinding Lights' }).trackId, 'b');
  // исполнитель в названии канала, без дефиса
  const viaChannel = x.match({ title: 'Believer', channel: 'Imagine Dragons - Topic', duration: 204 });
  assert.equal(viaChannel.trackId, 'f');
  assert.equal(viaChannel.level, 'exact');
});

test('4. разные версии одной композиции не считаются одной записью', () => {
  const x = make();
  const remix = x.match({ title: 'Avicii - Levels (Skrillex Remix)', duration: 203 });
  assert.equal(remix.trackId, 'c');
  assert.equal(remix.level, 'partial');
  assert.equal(remix.versionMismatch, true);
  const live = x.match({ title: 'Linkin Park - Numb (Live)', duration: 190 });
  assert.equal(live.level, 'partial');
  const original = x.match({ title: 'Avicii - Levels (Official Video)', duration: 203 });
  assert.equal(original.level, 'exact');
  // и наоборот: в библиотеке Remix, а в YouTube оригинал
  const x2 = make([{ id: 'r', name: 'Levels (Skrillex Remix)', artist: 'Avicii', duration: 200 }]);
  assert.equal(x2.match({ title: 'Avicii - Levels' }).level, 'partial');
  assert.equal(x2.match({ title: 'Avicii - Levels (Skrillex Remix)' }).level, 'exact');
  // слово Live в самом названии — не версия
  assert.equal(x.match({ title: 'Oasis - Live Forever' }).level, 'exact');
});

test('другой трек и другой исполнитель не совпадают', () => {
  const x = make();
  assert.equal(x.match({ title: 'Metallica - Nothing Else Matters' }).level, 'none');
  assert.equal(x.match({ title: 'Cover Band - Numb' }).level === 'exact', false);
  assert.equal(m.matchBadge(x.match({ title: 'Metallica - One' })).tone, 'secondary');
  assert.equal(x.match({ title: 'Rihanna - Hello' }).level === 'exact', false);
});

test('неизвестный исполнитель в библиотеке не даёт точного совпадения без подтверждения', () => {
  const x = make([{ id: 'u', name: 'Numb', artist: 'Неизвестный исполнитель', duration: 0 }]);
  assert.equal(x.match({ title: 'Linkin Park - Numb', duration: 185 }).level, 'partial');
  const y = make([{ id: 'u', name: 'Numb', artist: '', duration: 186 }]);
  assert.equal(y.match({ title: 'Linkin Park - Numb', duration: 185 }).level, 'high');
});

test('сильное расхождение длительности понижает уровень', () => {
  const x = make();
  const r = x.match({ title: 'Linkin Park - Numb', duration: 600 });
  assert.equal(r.level, 'high');
  assert.equal(r.durationConflict, true);
});

test('6. обновление после изменения библиотеки; кеш не переиспользуется', () => {
  const x = make();
  const query = { title: 'Eminem - Mockingbird', duration: 251 };
  assert.equal(x.match(query).level, 'none');
  assert.equal(x.update(lib), false, 'без изменений индекс не перестраивается');
  const revision = x.revision;
  assert.equal(x.update([...lib, { id: 'm', name: 'Mockingbird', artist: 'Eminem', duration: 251 }]), true);
  assert.ok(x.revision > revision);
  assert.equal(x.match(query).level, 'exact');
  x.update(lib);
  assert.equal(x.match(query).level, 'none');
});

test('5. скорость: 20 результатов на библиотеке из 20 000 треков', () => {
  const words = ['night', 'river', 'fire', 'love', 'time', 'heart', 'dream', 'road', 'light', 'rain', 'world', 'moon', 'dance', 'storm', 'gold'];
  const big = [];
  for (let i = 0; i < 20000; i++) {
    big.push({ id: 'x' + i, name: `${words[i % 15]} ${words[(i * 7) % 15]} ${i}`, artist: `Artist ${i % 900}`, duration: 120 + (i % 200) });
  }
  big.push({ id: 'target', name: 'Mockingbird', artist: 'Eminem', duration: 251 });
  const x = m.createLibraryMatcher();
  let started = performance.now();
  x.update(big);
  const buildMs = performance.now() - started;
  const queries = Array.from({ length: 20 }, (_, i) => ({ title: i === 0 ? 'Eminem - Mockingbird [Official Video]' : `Artist ${i} - ${words[i % 15]} ${words[(i * 3) % 15]} night`, duration: 200 }));
  started = performance.now();
  const results = queries.map((q) => x.match(q));
  const queryMs = performance.now() - started;
  assert.equal(results[0].trackId, 'target');
  console.log(`# индекс 20000 треков: ${buildMs.toFixed(0)} мс; 20 запросов: ${queryMs.toFixed(1)} мс`);
  assert.ok(queryMs < 250, 'запросы заняли ' + queryMs + ' мс');
  started = performance.now();
  queries.forEach((q) => x.match(q));
  assert.ok(performance.now() - started < queryMs + 5, 'повторные запросы берутся из кеша');
});

test('нормализация и похожесть', () => {
  assert.equal(m.titleCore('Blinding Lights (Official Video) [HD]'), 'blinding lights');
  assert.deepEqual(m.detectVersions('Levels (Skrillex Remix) [Live]'), ['live', 'remix']);
  assert.deepEqual(m.detectVersions('Live Forever'), []);
  assert.ok(m.similarity('blinding lights', 'blinding light') > 0.9);
  assert.ok(m.similarity('numb', 'hello') < 0.3);
});
