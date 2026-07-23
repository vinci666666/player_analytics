/**
 * 共用顯示格式化與 HTML 跳脫。 / Shared display formatting and HTML escaping.
 * 數值格式器會在語系切換時重建，避免圖表與表格使用不同千分位規則。
 * The number formatter is rebuilt on locale changes so charts and tables stay consistent.
 */

let currentLocale = 'zh-TW';
let integerFormatter = new Intl.NumberFormat(currentLocale, { maximumFractionDigits: 0 });

/** 切換後續格式化使用的語系。 / Change the locale used by subsequent formatting calls. */
export function setFormatterLocale(locale) {
  currentLocale = locale || 'zh-TW';
  integerFormatter = new Intl.NumberFormat(currentLocale, { maximumFractionDigits: 0 });
}

/** 格式化 IDR 金額。 / Format an IDR-denominated amount. */
export function formatCurrency(value) {
  return `${integerFormatter.format(value)} IDR`;
}

/** 將可空值安全解析為有限數字。 / Parse a nullable value into a finite number. */
export function parseNullableNumber(value) {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 格式化整數計數；缺值顯示 --。 / Format an integer count, using -- for missing values. */
export function formatCount(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? '--'
    : integerFormatter.format(Number(value));
}

/** 格式化可空 IDR 金額。 / Format a nullable IDR amount. */
export function formatNullableCurrency(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? '--'
    : formatCurrency(Number(value));
}

/** 保留後端時間文字，缺值顯示 --。 / Preserve backend date-time text, using -- when absent. */
export function formatDateTimeText(value) {
  return value || '--';
}

/** 依目前語系產生圖表提示時間。 / Build locale-aware date-time text for chart tooltips. */
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

/** 跳脫插入 innerHTML 的不可信文字。 / Escape untrusted text before interpolation into innerHTML. */
export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}
