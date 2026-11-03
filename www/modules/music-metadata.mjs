const TECHNICAL_LABELS = [
  'official music video', 'official video', 'official audio', 'music video',
  'lyric video', 'lyrics video', 'lyrics', 'lyric', 'visualizer', 'audio hq',
  'full hd', 'ultra hd', '4k', '2160p', '1440p', '1080p', '720p', '480p', 'hd'
];
const TECHNICAL_RE = new RegExp(`\\b(?:${TECHNICAL_LABELS.map(escapeRegExp).join('|')})\\b`, 'i');
const VERSION_RE = /\b(?:remix(?:ed)?|live(?:\s+(?:version|at\s+.+))?|acoustic(?:\s+version)?|instrumental|remaster(?:ed)?(?:\s+\d{4})?|radio\s+edit|extended\s+mix|extended\s+edit|edit|demo|version|part\s+\d+|pt\.?\s*\d+)\b/i;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(value) {
  return String(value ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Сегмент считается мусором, только если ВСЕ его слова служебные. Раньше хватало одного совпадения,
// поэтому «(Why Do Lyrics Hurt)» или «[Black Parade 4K Edition]» теряли часть настоящего названия.
const NOISE_WORDS = new Set([
  'official', 'music', 'video', 'audio', 'lyrics', 'lyric', 'lyrical', 'visualizer', 'visualiser', 'clip', 'new', 'full',
  'ultra', 'hq', 'hd', '4k', '8k', '2160p', '1440p', '1080p', '720p', '480p', '360p'
]);
function isNoiseSegment(value) {
  const words = normalizeText(value).replace(/[()[\]{}]/g, ' ').toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.length > 0 && words.every((word) => NOISE_WORDS.has(word)) && !VERSION_RE.test(value);
}

function cleanBracketedNoise(value) {
  let text = value;
  for (let pass = 0; pass < 3; pass++) {
    const before = text;
    text = text.replace(/\s*[([{]([^\])}]+)[\])}]/g, (whole, inner) => isNoiseSegment(inner) ? ' ' : whole);
    if (before === text) break;
  }
  return text;
}

function cleanTechnicalSuffix(value) {
  let text = value;
  const labels = TECHNICAL_LABELS.map(escapeRegExp).join('|');
  const suffixNoise = new RegExp(`(?:\\s*[-–—|•·]\\s*(?:${labels})\\b)+\\s*$`, 'i');
  const plainNoise = new RegExp(`(?:\\s+(?:${labels})\\b)+\\s*$`, 'i');
  for (let pass = 0; pass < 5; pass++) {
    const before = text;
    text = text.replace(suffixNoise, '').replace(plainNoise, '');
    if (text === before) break;
  }
  return text;
}

/** Clean only known promotional/technical noise; retain meaningful track versions. */
export function cleanTrackTitle(value, videoId = '') {
  let title = normalizeText(value);
  const id = normalizeText(videoId);
  if (!title) return '';
  if (/^[A-Za-z0-9_-]{11}$/.test(id)) {
    title = title.replace(new RegExp(`\\s*[[(]${escapeRegExp(id)}[)\\]]\\s*$`, 'i'), '');
  }
  title = cleanBracketedNoise(title);
  title = cleanTechnicalSuffix(title);
  // A technical segment after a pipe is a common upload convention. Remove only
  // trailing segments that consist entirely of known noise.
  const parts = title.split(/\s*[|•·]\s*/);
  while (parts.length > 1 && isNoiseSegment(parts[parts.length - 1])) parts.pop();
  title = parts.join(' | ');
  // Очистка не должна уничтожить название целиком: «Lyrics», «HD» и т. п. могут быть настоящим названием.
  if (!/[\p{L}\p{N}]/u.test(title)) return normalizeText(value);
  title = title
    .replace(/[\s|•·-]+$/g, '')
    .replace(/^[\s|•·]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;!?])/g, '$1')
    .replace(/([|•·])\s*\1+/g, '$1')
    .trim();
  return title;
}

/** Remove channel suffixes without stripping legitimate artist names. */
export function cleanArtistName(value) {
  let artist = normalizeText(value);
  if (!artist) return '';
  artist = artist
    .replace(/\s*[-–—|•·]\s*Topic\s*$/i, '')
    .replace(/\s*[([]\s*(?:Official(?:\s+Artist)?(?:\s+Channel)?|VEVO)\s*[)\]]\s*$/i, '')
    .replace(/(?:\s*[-–—|•·]\s*)?(?:Official(?:\s+Artist)?(?:\s+Channel)?|VEVO)\s*$/i, '')
    .replace(/\.VEVO\s*$/i, '')
    .replace(/\s*[-–—|•·]+\s*$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // Remove exact duplicates only. Delimiters commonly separate collaborators,
  // so preserve distinct artists and their original ordering.
  const artists = artist.split(/\s*[,;]\s*/).filter(Boolean);
  const seen = new Set();
  const unique = artists.filter((name) => {
    const key = name.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.join(', ').trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const parts = value.map((item) => normalizeText(item)).filter(Boolean);
      if (parts.length) return parts.join(', ');
    } else if (normalizeText(value)) return normalizeText(value);
  }
  return '';
}

function extractYear(value) {
  const text = normalizeText(value);
  const match = text.match(/^(\d{4})/);
  if (!match) return '';
  const year = Number(match[1]);
  return year >= 1880 && year <= new Date().getFullYear() + 1 ? match[1] : '';
}

/** Resolve extractor metadata conservatively; never invent an artist or album. */
export function resolveMusicMetadata(info = {}, fallback = {}) {
  const source = info && typeof info === 'object' ? info : {};
  const track = cleanTrackTitle(firstNonEmpty(source.track, source.title, fallback.title));
  const artist = cleanArtistName(firstNonEmpty(
    source.artists, source.artist, source.album_artists, source.album_artist,
    source.creator, source.creators, source.uploader, source.channel, fallback.artist
  ));
  return {
    title: track || 'Без названия',
    artist,
    album: cleanTrackTitle(firstNonEmpty(source.album, source.series)),
    year: extractYear(firstNonEmpty(source.release_date, source.upload_date, source.release_year, source.release_timestamp)),
    genre: firstNonEmpty(source.genre, source.genres, source.categories),
    thumbnail: firstNonEmpty(source.thumbnail, fallback.thumbnail),
    duration: Number(source.duration ?? fallback.duration) || 0
  };
}

export function createAudioFilename(artist, title, extension, fallbackId = '') {
  const cleanArtist = cleanArtistName(artist);
  const cleanTitle = cleanTrackTitle(title) || normalizeText(fallbackId) || 'Без названия';
  const safePart = (value) => normalizeText(value)
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, '_')
    .replace(/[. ]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 100)
    .trim();
  const base = [cleanArtist, cleanTitle].filter(Boolean).map(safePart).filter(Boolean).join(' - ') || safePart(fallbackId) || 'Crimson Track';
  const ext = String(extension || '').replace(/^\./, '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'audio';
  return `${base}.${ext}`;
}

export const __test = { normalizeText, isNoiseSegment, extractYear };
