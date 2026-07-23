let currentLocale = 'zh-TW';
let integerFormatter = new Intl.NumberFormat(currentLocale, { maximumFractionDigits: 0 });

export function setFormatterLocale(locale) {
  currentLocale = locale || 'zh-TW';
  integerFormatter = new Intl.NumberFormat(currentLocale, { maximumFractionDigits: 0 });
}

export function formatCurrency(value) {
  return `${integerFormatter.format(value)} IDR`;
}

export function parseNullableNumber(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatCount(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? '--'
    : integerFormatter.format(Number(value));
}

export function formatNullableCurrency(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? '--'
    : formatCurrency(Number(value));
}

export function formatDateTimeText(value) {
  return value || '--';
}

export function formatDateTimeForTooltip(dateValue) {
  if (!(dateValue instanceof Date) || Number.isNaN(dateValue.getTime())) return '--';
  const datePart = dateValue.toLocaleDateString(currentLocale, {
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const timePart = dateValue.toLocaleTimeString(currentLocale, {
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  return `${datePart} ${timePart}`;
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}
