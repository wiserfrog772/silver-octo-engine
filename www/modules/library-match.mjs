/**
 * Проверка «есть ли этот трек в локальной библиотеке».
 * - нормализация названий и исполнителей;
 * - распознавание версий (Remix / Live / Acoustic ...): разные версии — разные записи;
 * - инвертированный индекс по токенам, поэтому поиск не сканирует всю библиотеку;
 * - кеш результатов, который сбрасывается при изменении библиотеки.
 */
import { resolveTrackIdentity, artistKey, artistParts } from './track-identity.mjs';

export const MATCH_LEVEL = Object.freeze({ EXACT: 'exact', HIGH: 'high', PARTIAL: 'partial', NONE: 'none' });

// Версии, которые меняют саму запись. Remaster/HD/Lyrics сюда не входят.
const VERSION_PATTERNS = [
  ['remix', /\b(?:remix(?:ed)?|rmx|bootleg|mashup|flip|rework|vip(?:\s+mix)?)\b/i],
  ['live', /\b(?:live|concert|unplugged|session|tour)\b/i],
  ['acoustic', /\b(?:acoustic|unplugged)\b/i],
  ['instrumental', /\b(?:instrumental|karaoke|backing\s+track|minus)\b/i],
  ['cover', /\bcover\b/i],
  ['sped', /\b(?:sped\s*up|speed\s*up|nightcore)\b/i],
  ['slowed', /\b(?:slowed|reverb|8d)\b/i],
  ['extended', /\b(?:extended(?:\s+(?:mix|version|edit))?)\b/i],
  ['radio', /\bradio\s+edit\b/i],
  ['demo', /\bdemo\b/i]
];
const BRACKET_RE = /[([{]([^\])}]*)[\])}]/g;
const NOISE_WORDS = new Set(['official', 'video', 'audio', 'lyrics', 'lyric', 'hd', 'hq', 'music', 'visualizer', 'remastered', 'remaster']);
function fold(value) {
  return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
}
// fold() раскладывает «й» в «и» + диакритику, поэтому список приводим тем же способом.
const UNKNOWN_ARTISTS = new Set(['', 'неизвестный исполнитель', 'unknown artist', 'unknown', '<unknown>'].map(fold));

export function detectVersions(text) {
  const found = [];
  const source = String(text ?? '');
  // Версии ищем в скобках и в хвосте после тире, чтобы слово Live в самом названии не считалось версией.
  const zones = [];
  let match;
  BRACKET_RE.lastIndex = 0;
  while ((match = BRACKET_RE.exec(source))) zones.push(match[1]);
  const tail = source.split(/\s+[-–—]\s+/).slice(1).join(' ');
  if (tail) zones.push(tail);
  for (const zone of zones) {
    for (const [kind, re] of VERSION_PATTERNS) if (re.test(zone) && !found.includes(kind)) found.push(kind);
  }
  return found.sort();
}

/** Ядро названия: без скобок с версиями/шумом, feat., знаков и регистра. */
export function titleCore(title) {
  let value = String(title ?? '');
  value = value.replace(BRACKET_RE, ' ');
  value = value.split(/\s+[-–—]\s+/)[0];
  value = fold(value)
    .replace(/\b(?:feat\.?|ft\.?|featuring)\b.*$/i, ' ')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter((word) => word && !NOISE_WORDS.has(word));
  return value.join(' ');
}

function bigrams(value) {
  const compact = value.replace(/\s+/g, '');
  const result = new Map();
  for (let i = 0; i < compact.length - 1; i++) {
    const gram = compact.slice(i, i + 2);
    result.set(gram, (result.get(gram) || 0) + 1);
  }
  return result;
}

/** Похожесть строк 0..1: коэффициент Дайса по биграммам. */
export function similarity(a, b) {
  if (a === b) return a ? 1 : 0;
  if (!a || !b) return 0;
  if (a.replace(/\s+/g, '') === b.replace(/\s+/g, '')) return 1;
  const left = bigrams(a);
  const right = bigrams(b);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  let total = 0;
  for (const count of left.values()) total += count;
  for (const count of right.values()) total += count;
  for (const [gram, count] of left) overlap += Math.min(count, right.get(gram) || 0);
  return (2 * overlap) / total;
}

function tokens(value) {
  return Array.from(new Set(String(value).split(/\s+/).filter((word) => word.length >= 2)));
}

function isUnknownArtist(value) {
  return UNKNOWN_ARTISTS.has(fold(value).trim());
}

function artistScore(queryArtist, libraryArtist) {
  if (isUnknownArtist(queryArtist) || isUnknownArtist(libraryArtist)) return { score: 0.5, known: false };
  const a = artistKey(queryArtist);
  const b = artistKey(libraryArtist);
  if (!a || !b) return { score: 0.5, known: false };
  if (a === b) return { score: 1, known: true };
  const left = new Set(artistParts(queryArtist).map(artistKey).filter(Boolean));
  const right = new Set(artistParts(libraryArtist).map(artistKey).filter(Boolean));
  let shared = 0;
  for (const part of left) if (right.has(part)) shared += 1;
  if (shared) return { score: 0.75 + 0.25 * (shared / Math.max(left.size, right.size)), known: true };
  if (a.includes(b) || b.includes(a)) return { score: 0.8, known: true };
  return { score: similarity(a, b) * 0.7, known: true };
}

function durationAgreement(a, b) {
  const x = Number(a) || 0;
  const y = Number(b) || 0;
  if (x <= 0 || y <= 0) return 'unknown';
  const diff = Math.abs(x - y);
  if (diff <= 5 || diff / Math.max(x, y) <= 0.03) return 'agree';
  if (diff > 20 && diff / Math.max(x, y) > 0.1) return 'conflict';
  return 'neutral';
}

/** Подготовленное описание трека библиотеки: считается один раз при построении индекса. */
function describeLibraryTrack(track) {
  const name = String(track.name ?? track.title ?? '');
  const artist = isUnknownArtist(track.artist) ? '' : String(track.artist ?? '');
  const core = titleCore(name);
  return {
    id: track.id,
    track,
    artist,
    core,
    coreKey: core.replace(/\s+/g, ''),
    versions: detectVersions(name),
    duration: Number(track.duration) || 0,
    tokens: tokens(core)
  };
}

function versionsEqual(a, b) {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

export function createLibraryMatcher({ cacheLimit = 400 } = {}) {
  let entries = [];
  let byCoreKey = new Map();
  let postings = new Map();
  let signature = '';
  let revision = 0;
  const cache = new Map();

  function trackSignature(tracks) {
    let hash = 5381;
    for (const track of tracks) {
      const part = `${track.id}\u0001${track.name}\u0001${track.artist}\u0001${track.duration || 0}`;
      for (let i = 0; i < part.length; i++) hash = ((hash << 5) + hash + part.charCodeAt(i)) | 0;
    }
    return `${tracks.length}:${hash}`;
  }

  /** Перестраивает индекс только если библиотека действительно изменилась. */
  function update(tracks) {
    const list = Array.isArray(tracks) ? tracks.filter((track) => track && track.id != null) : [];
    const next = trackSignature(list);
    if (next === signature) return false;
    signature = next;
    revision += 1;
    entries = list.map(describeLibraryTrack);
    byCoreKey = new Map();
    postings = new Map();
    for (const entry of entries) {
      if (entry.coreKey) {
        if (!byCoreKey.has(entry.coreKey)) byCoreKey.set(entry.coreKey, []);
        byCoreKey.get(entry.coreKey).push(entry);
      }
      for (const token of entry.tokens) {
        if (!postings.has(token)) postings.set(token, []);
        postings.get(token).push(entry);
      }
    }
    cache.clear();
    return true;
  }

  function invalidate() { signature = ''; cache.clear(); }

  function candidatesFor(core, coreKey, queryTokens) {
    const found = new Map();
    for (const entry of byCoreKey.get(coreKey) || []) found.set(entry.id, entry);
    // Берём самые редкие токены: так не обходим длинные списки частых слов.
    const lists = queryTokens.map((token) => postings.get(token)).filter(Boolean).sort((a, b) => a.length - b.length);
    for (const list of lists.slice(0, 3)) {
      for (const entry of list.length > 600 ? list.slice(0, 600) : list) found.set(entry.id, entry);
      if (found.size > 800) break;
    }
    return found.values();
  }

  function classify(titleScore, artistInfo, sameVersions, duration) {
    let level = MATCH_LEVEL.NONE;
    if (titleScore >= 0.995 && artistInfo.known && artistInfo.score >= 0.995) level = MATCH_LEVEL.EXACT;
    else if (titleScore >= 0.9 && artistInfo.known && artistInfo.score >= 0.75) level = MATCH_LEVEL.HIGH;
    else if (titleScore >= 0.995 && !artistInfo.known) level = MATCH_LEVEL.HIGH;
    else if (titleScore >= 0.72 && (artistInfo.score >= 0.5)) level = MATCH_LEVEL.PARTIAL;
    if (level === MATCH_LEVEL.NONE) return level;
    // Разные версии (оригинал/Remix) — не одна и та же запись.
    if (!sameVersions) level = MATCH_LEVEL.PARTIAL;
    // Сильное расхождение длительности понижает уровень на одну ступень.
    if (duration === 'conflict') level = level === MATCH_LEVEL.EXACT ? MATCH_LEVEL.HIGH : MATCH_LEVEL.PARTIAL;
    // Без известного исполнителя точным совпадением быть нельзя без подтверждения длительностью.
    if (!artistInfo.known && level === MATCH_LEVEL.HIGH && duration !== 'agree') level = MATCH_LEVEL.PARTIAL;
    return level;
  }

  const RANK = { exact: 3, high: 2, partial: 1, none: 0 };

  /** query: { title, artist?, channel?, duration?, id? } — сырые данные результата YouTube. */
  function match(query) {
    const raw = query || {};
    const identity = resolveTrackIdentity({ title: raw.title, artist: raw.artist, info: { channel: raw.channel || raw.uploader } });
    const titleText = identity.title || String(raw.title ?? '');
    const key = `${revision}|${artistKey(identity.artist)}|${titleCore(titleText)}|${detectVersions(titleText).join(',')}|${Math.round(Number(raw.duration) || 0)}`;
    if (cache.has(key)) {
      const hit = cache.get(key);
      cache.delete(key); cache.set(key, hit); // LRU
      return hit;
    }
    const core = titleCore(titleText);
    const coreKey = core.replace(/\s+/g, '');
    const versions = detectVersions(titleText);
    const queryTokens = tokens(core);
    let best = null;
    if (coreKey || queryTokens.length) {
      for (const entry of candidatesFor(core, coreKey, queryTokens)) {
        const titleScore = entry.coreKey === coreKey ? 1 : similarity(core, entry.core);
        if (titleScore < 0.72) continue;
        const artistInfo = artistScore(identity.artist, entry.artist);
        const sameVersions = versionsEqual(versions, entry.versions);
        const duration = durationAgreement(raw.duration, entry.duration);
        const level = classify(titleScore, artistInfo, sameVersions, duration);
        if (level === MATCH_LEVEL.NONE) continue;
        const score = titleScore * 0.6 + artistInfo.score * 0.4 - (sameVersions ? 0 : 0.15);
        if (!best || RANK[level] > RANK[best.level] || (RANK[level] === RANK[best.level] && score > best.score)) {
          best = { level, score: Math.round(score * 1000) / 1000, trackId: entry.id, track: entry.track, versionMismatch: !sameVersions, durationConflict: duration === 'conflict' };
        }
      }
    }
    const result = best || { level: MATCH_LEVEL.NONE, score: 0, trackId: null, track: null, versionMismatch: false, durationConflict: false };
    cache.set(key, result);
    if (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
    return result;
  }

  return { update, invalidate, match, get size() { return entries.length; }, get revision() { return revision; } };
}

/** Подпись и стиль бейджа для интерфейса. */
export function matchBadge(result) {
  const level = result && result.level;
  if (level === MATCH_LEVEL.EXACT) return { tone: 'success', label: 'Есть в библиотеке', hint: 'Точное совпадение исполнителя и названия' };
  if (level === MATCH_LEVEL.HIGH) return { tone: 'warning', label: 'Возможно, есть в библиотеке', hint: 'Высокая вероятность совпадения' };
  if (level === MATCH_LEVEL.PARTIAL) {
    return {
      tone: 'warning', label: 'Возможно, есть в библиотеке',
      hint: result.versionMismatch ? 'Похожий трек, но другая версия (Remix, Live, Acoustic и т. п.)' : 'Частичное совпадение'
    };
  }
  return { tone: 'secondary', label: 'Не найден', hint: 'Подходящей композиции в библиотеке нет' };
}
