export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

export function formatTimeLabel(seconds) {
  const value = Number(seconds) || 0;
  if (!Number.isFinite(value) || value < 0) return '0:00';
  const total = Math.floor(value);
  return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}

export function pluralTrackCount(count) {
  const number = Math.abs(Number(count) || 0);
  const last = number % 10;
  const tens = number % 100;
  if (tens > 10 && tens < 20) return number + ' треков';
  if (last > 1 && last < 5) return number + ' трека';
  return number + (last === 1 ? ' трек' : ' треков');
}
