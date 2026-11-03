/**
 * Единый механизм определения исполнителя и названия трека.
 * Используется при скачивании (теги, имя файла), добавлении в библиотеку и отображении.
 * Чистый модуль без обращений к DOM/Android, поэтому полностью покрыт тестами.
 */
import { cleanArtistName, cleanTrackTitle } from './music-metadata.mjs';

// Разделитель «Исполнитель – Название»: только тире, окружённое пробелами.
// Дефис внутри слова (Jay-Z, Spider-Man) разделителем не является.
const DASHES = '\\-\\u2010\\u2011\\u2012\\u2013\\u2014\\u2015\\u2212';
const SEPARATOR_RE = new RegExp(`\\s+[${DASHES}]\\s+`);
const LEADING_SEPARATOR_RE = new RegExp(`^\\s*[${DASHES}]\\s+`);

const VERSION_ONLY_RE = /^[([{]?\s*(?:(?:official\s+)?(?:live(?:\s+(?:version|at\s+.+|from\s+.+|session))?|remix(?:ed)?|acoustic(?:\s+version)?|instrumental|remaster(?:ed)?(?:\s+\d{4})?|radio\s+edit|extended(?:\s+(?:mix|edit|version))?|demo|cover|version|edit|mix|reprise|unplugged|\d{4}\s+remaster(?:ed)?))\s*[)\]}]?$/i;
const FEAT_RE = /\b(?:featuring|feat\.?|ft\.?)\s+/gi;

// Только настоящие аудио-расширения. Раньше «расширением» считалось всё после последней точки,
// поэтому «Song (ft. Artist)» превращалось в «Song (ft», а «123. GONE» в «123».
const AUDIO_EXT_RE = /\.(?:mp3|m4a|aac|ogg|opus|wav|flac|webm|oga|mp4|wma|aiff?|alac)$/i;
export function stripAudioExtension(name) {
  return String(name ?? '').replace(AUDIO_EXT_RE, '');
}

function text(value) {
  return String(value ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Ключ для сравнения имён: регистр, диакритика, пробелы и знаки не имеют значения. */
export function artistKey(value) {
  return text(value)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/&/g, ' and ')
    .replace(/^the\s+/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** feat./ft./featuring → единый вид «feat.». Информацию об участниках не удаляет. */
export function normalizeFeaturing(value) {
  return text(value).replace(FEAT_RE, 'feat. ').replace(/\s{2,}/g, ' ').trim();
}

/** Список отдельных участников: «A feat. B & C, D x E» → [A, B, C, D, E]. */
export function artistParts(value) {
  return text(value)
    .split(/\s*(?:,|;|&|\+|\bx\b|\band\b|\bfeat\.?|\bft\.?|\bfeaturing\b|\bwith\b|\bvs\.?)\s*/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Номер позиции из списка («123. GONE - Artist», «01 - Artist - Title») — не часть названия.
 * Убираем его только если после него остаётся полноценное «Исполнитель - Название».
 * «7 rings», «21 Guns» и «123» не затрагиваются: у них нет точки/скобки и разделителя.
 */
export function stripLeadingTrackNumber(value) {
  const input = text(value);
  const dotted = input.match(/^(\d{1,3})\s*[.)]\s+(\S.*)$/);
  if (dotted && splitArtistTitle(dotted[2])) return dotted[2];
  const dashed = input.match(new RegExp(`^(\\d{1,3})\\s+[${DASHES}]\\s+(\\S.*)$`));
  if (dashed && splitArtistTitle(dashed[2])) return dashed[2];
  return input;
}

const FEAT_GROUP_RE = /\s*[(\[]\s*(?:featuring|feat\.?|ft\.?)\s+([^()\[\]]+?)\s*[)\]]/i;
const FEAT_TAIL_RE = /\s+(?:featuring|feat\.?|ft\.?)\s+([^()\[\]]+?)(?=\s*[(\[]|$)/i;

/** Достаёт участников «feat. X» из названия. Ничего не теряет: гости возвращаются отдельно. */
export function extractFeaturing(title) {
  const value = text(title);
  for (const re of [FEAT_GROUP_RE, FEAT_TAIL_RE]) {
    const match = value.match(re);
    if (match && match[1].trim()) {
      const rest = text(value.replace(match[0], ' '));
      if (/[\p{L}\p{N}]/u.test(rest)) return { title: rest, guests: match[1].trim() };
    }
  }
  return { title: value, guests: '' };
}

/** «Artist» + «Guest» → «Artist feat. Guest»; уже перечисленные участники не дублируются. */
export function addGuestsToArtist(artist, guests) {
  const base = text(artist);
  const extra = text(guests);
  if (!base || !extra) return base;
  const known = new Set(artistParts(base).map(artistKey));
  const fresh = artistParts(extra).filter((name) => !known.has(artistKey(name)));
  if (!fresh.length) return base;
  return normalizeFeaturing(/\bfeat\./i.test(base) ? `${base} & ${fresh.join(' & ')}` : `${base} feat. ${fresh.join(' & ')}`);
}

function isVersionOnly(value) {
  return VERSION_ONLY_RE.test(text(value));
}

function dedupeNames(value) {
  const parts = text(value).split(/\s*[,;]\s*/).filter(Boolean);
  const seen = new Set();
  return parts.filter((name) => {
    const key = artistKey(name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(', ');
}

/** Приводит значение (строка или массив) из yt-dlp к одной очищенной строке исполнителей. */
export function joinArtists(value) {
  const list = Array.isArray(value) ? value : [value];
  const cleaned = list.map((item) => cleanArtistName(text(item))).filter(Boolean);
  return normalizeFeaturing(dedupeNames(cleaned.join(', ')));
}

/**
 * Делит «Исполнитель - Название» по первому разделителю.
 * Возвращает null, если разделителя нет или он расположен так, что делить небезопасно.
 */
export function splitArtistTitle(rawTitle) {
  const title = text(rawTitle);
  const match = SEPARATOR_RE.exec(title);
  if (!match || match.index === 0) return null;
  const left = title.slice(0, match.index).trim();
  const right = title.slice(match.index + match[0].length).trim();
  if (!left || !right) return null;
  return { left, right, hasMoreSeparators: SEPARATOR_RE.test(right) };
}

/**
 * Относится ли левая часть к известному исполнителю.
 * «Big Poe feat. Guest» относится к известному «Big Poe»: основной исполнитель совпадает, гость — дополнение.
 */
function leftMatchesKnownArtist(left, knownArtist) {
  const known = new Set(artistParts(knownArtist).map(artistKey).filter(Boolean));
  if (!known.size) return false;
  if (artistKey(left) === artistKey(knownArtist)) return true;
  const primary = text(left).split(/\s+(?:featuring|feat\.?|ft\.?)\s+/i)[0];
  const parts = artistParts(primary).map(artistKey).filter(Boolean);
  return parts.length > 0 && parts.every((part) => known.has(part));
}

/**
 * Убирает исполнителя из начала названия, но только когда это действительно он.
 * Повторяется, чтобы убрать дубль «Artist - Artist - Title».
 */
export function stripArtistFromTitle(artist, title) {
  let result = text(title);
  const knownArtist = text(artist);
  if (!knownArtist || !result) return result;
  for (let pass = 0; pass < 4; pass++) {
    const split = splitArtistTitle(result);
    if (!split || !leftMatchesKnownArtist(split.left, knownArtist)) break;
    if (isVersionOnly(split.right)) break; // «Artist - Live» — это название, а не дубль
    result = split.right;
  }
  // «Artist: Title» и «Artist – Title» без пробелов не трогаем: слишком велик риск испортить название.
  return result;
}

/**
 * Решает, можно ли считать левую часть названия исполнителем.
 * Структурированные данные важнее; без них нужен однозначный шаблон «Исполнитель - Название».
 */
function trustedTitleSplit(rawTitle, structuredArtist) {
  const split = splitArtistTitle(rawTitle);
  if (!split) return null;
  if (isVersionOnly(split.right)) return null;
  if (LEADING_SEPARATOR_RE.test(split.left)) return null;
  // Левая часть из одних цифр («123 - Название») — номер позиции, а не исполнитель.
  if (/^\d{1,3}$/.test(split.left)) return null;
  if (structuredArtist) {
    // Данные YouTube могут противоречить названию: тогда название не трогаем.
    return leftMatchesKnownArtist(split.left, structuredArtist) ? split : null;
  }
  if (split.left.length > 80) return null;
  return split;
}

/** Надёжный автоматический канал («Artist - Topic», «ArtistVEVO»): имя канала равно имени исполнителя. */
function reliableChannelArtist(channel) {
  const raw = text(channel);
  if (!raw || !/(?:\s[-–—]\s*Topic|VEVO)\s*$/i.test(raw)) return '';
  return joinArtists(raw);
}

/**
 * Главная функция. Приоритет источников:
 *   1) artists / artist — исполнители композиции, track — название;
 *   2) album_artist, creator — если основной исполнитель неизвестен;
 *   3) «Исполнитель - Название» из названия видео;
 *   4) канал/автор загрузки — ТОЛЬКО автоматические каналы «- Topic» и VEVO;
 *   5) иначе исполнитель неизвестен: поле пустое, название целиком сохраняется.
 * Если разделить достоверно нельзя, название остаётся исходным (очищенным только от служебных пометок).
 */
export function resolveTrackIdentity(input = {}) {
  const info = input.info && typeof input.info === 'object' ? input.info : {};
  const videoId = text(input.videoId || info.id);
  const rawTitle = text(input.title ?? info.title);
  const structuredTrack = text(info.track);
  const primaryArtist = joinArtists([info.artists ?? info.artist].flat().filter(Boolean));
  const secondaryArtist = joinArtists([info.album_artists ?? info.album_artist ?? info.creators ?? info.creator].flat().filter(Boolean));
  const structuredArtist = primaryArtist || secondaryArtist;
  // Артист из результатов поиска — это, как правило, название канала; используем только для сопоставления с библиотекой.
  const weakArtist = input.allowWeakArtist ? joinArtists(input.artist) : '';

  const cleanedRaw = stripLeadingTrackNumber(cleanTrackTitle(rawTitle, videoId)) || cleanTrackTitle(rawTitle, videoId);
  let artist = '';
  let title = '';
  let source = 'unknown';

  if (structuredTrack && structuredArtist) {
    artist = structuredArtist;
    title = cleanTrackTitle(structuredTrack, videoId) || cleanedRaw;
    source = primaryArtist ? 'structured' : 'structured-secondary';
  } else {
    let split = trustedTitleSplit(cleanedRaw, structuredArtist);
    // Некоторые загрузки называют «Название - Исполнитель». Меняем части местами только по данным:
    // известный исполнитель должен совпасть с ПРАВОЙ частью.
    const reversed = !split && structuredArtist ? splitArtistTitle(cleanedRaw) : null;
    if (reversed && !isVersionOnly(reversed.right) && leftMatchesKnownArtist(reversed.right, structuredArtist)) {
      split = { left: reversed.right, right: reversed.left };
    }
    if (split) {
      // Если слева исполнитель с гостями («Big Poe feat. X»), оставляем всю левую часть.
      artist = structuredArtist ? addGuestsToArtist(structuredArtist, extractGuestsFromLeft(split.left)) : joinArtists(split.left);
      title = split.right;
      source = structuredArtist ? 'structured+title' : 'title';
    } else {
      title = structuredTrack ? cleanTrackTitle(structuredTrack, videoId) : cleanedRaw;
      artist = structuredArtist || weakArtist;
      source = structuredArtist ? 'structured' : (weakArtist ? 'hint' : 'unknown');
    }
    if (!artist) {
      const channelArtist = reliableChannelArtist(info.channel || info.uploader || input.channel);
      if (channelArtist) { artist = channelArtist; source = 'channel'; }
    }
  }

  // Участники «feat. X» из названия переходят к исполнителю: информация сохраняется, название чище.
  if (artist) {
    const featured = extractFeaturing(title);
    if (featured.guests) {
      title = featured.title;
      artist = addGuestsToArtist(artist, featured.guests);
    }
  }
  // Исполнитель, оставшийся в начале названия, убираем (проверка по данным, не по позиции).
  const stripped = stripArtistFromTitle(artist, title);
  if (stripped && /[\p{L}\p{N}]/u.test(stripped)) title = stripped;
  title = cleanTrackTitle(title, videoId) || title;

  // Защита от порчи: пустое название никогда не записывается, берём исходное целиком.
  if (!/[\p{L}\p{N}]/u.test(title)) title = cleanedRaw || rawTitle;
  if (!artist) source = 'unknown';
  if (artist && artistKey(title) === artistKey(artist) && rawTitle && artistKey(rawTitle) !== artistKey(artist)) {
    title = cleanTrackTitle(rawTitle, videoId) || title;
  }

  const album = cleanTrackTitle(text(info.album || input.album));
  return { artist, title: title || 'Без названия', album, source };
}

/** Гости из левой части «Big Poe feat. Another Artist». */
function extractGuestsFromLeft(left) {
  const match = text(left).match(/\s+(?:featuring|feat\.?|ft\.?)\s+(.+)$/i);
  return match ? match[1] : '';
}

/** Безопасное имя файла: «Исполнитель - Название.ext»; без исполнителя — «Название.ext». */
export function buildTrackFilename(artist, title, extension = 'mp3') {
  const safe = (value) => text(value)
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 100)
    .trim();
  const cleanArtist = safe(artist);
  const cleanTitle = safe(title) || 'Без названия';
  const base = cleanArtist ? `${cleanArtist} - ${cleanTitle}` : cleanTitle;
  const ext = String(extension || '').replace(/^\./, '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'mp3';
  return `${base}.${ext}`;
}

/**
 * Полный набор значений для тегов, имени файла и библиотеки.
 * Все места приложения используют именно этот результат.
 */
export function buildTrackMetadata(input = {}, extension = 'mp3') {
  const identity = resolveTrackIdentity(input);
  const info = input.info && typeof input.info === 'object' ? input.info : {};
  const year = (() => {
    const raw = text(info.release_date || info.upload_date || info.release_year || input.year);
    const match = raw.match(/^(\d{4})/);
    if (!match) return '';
    const value = Number(match[1]);
    return value >= 1880 && value <= new Date().getFullYear() + 1 ? match[1] : '';
  })();
  const genreSource = info.genre ?? info.genres ?? input.genre;
  const genre = Array.isArray(genreSource) ? genreSource.map(text).filter(Boolean).join(', ') : text(genreSource);
  return {
    ...identity,
    year,
    genre,
    filename: buildTrackFilename(identity.artist, identity.title, extension),
    // Значения для ID3/MP4-тегов: ровно те же, что в библиотеке и имени файла.
    tags: { artist: identity.artist, title: identity.title, album: identity.album, date: year, genre }
  };
}

/**
 * Разбор имени файла из библиотеки с теми же правилами. Исполнитель не выдумывается.
 * Расширение снимается только если оно настоящее аудио-расширение; повторный вызов на имени
 * без расширения безопасен («Artist - Song (ft. X)» остаётся целым).
 */
export function parseLibraryFilename(filename, fallbackArtist = '') {
  const base = text(stripAudioExtension(String(filename || '')).replace(/_+/g, ' '));
  const identity = resolveTrackIdentity({ title: base, artist: fallbackArtist, allowWeakArtist: Boolean(fallbackArtist) });
  return { artist: identity.artist, name: identity.title };
}

/**
 * Название и исполнитель по имени файла из библиотеки (единственная точка разбора имён файлов).
 * Подчёркивания (замена запрещённых символов) → пробелы, пометка [videoId] убирается.
 */
export function libraryNameFromFilename(filename) {
  const base = text(stripAudioExtension(String(filename || '')).replace(/_+/g, ' '));
  const match = base.match(/(?:\[([A-Za-z0-9_-]{11})\]|\(([A-Za-z0-9_-]{11})\))\s*$/);
  const videoId = match ? (match[1] || match[2] || '') : '';
  const parsed = parseLibraryFilename(cleanTrackTitle(base, videoId));
  return { artist: parsed.artist, name: parsed.name, videoId };
}
