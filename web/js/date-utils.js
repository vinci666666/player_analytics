/**
 * 日期與月份的純函式，所有輸入／輸出日期字串皆採 YYYY-MM-DD 或 YYYY-MM。
 * Pure date and month helpers; string inputs and outputs use YYYY-MM-DD or YYYY-MM.
 */

/** 將本地 Date 轉成日期輸入框格式。 / Convert a local Date to an HTML date-input value. */
function toDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** 取得下一曆月同日，月底會自動截斷。 / Move to the same day next month, clamped at month-end. */
export function addOneCalendarMonth(date) {
  const next = new Date(date.getTime());
  const originalDay = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + 1);
  const daysInTargetMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(originalDay, daysInTargetMonth));
  return next;
}

/** 判斷結束日是否超過一個曆月上限。 / Test whether an end date exceeds one calendar month. */
export function isDateRangeOverOneMonth(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  return end > addOneCalendarMonth(start);
}

/** 判斷結束日是否超過一個曆年，並正確處理閏日。 / Test the one-calendar-year limit with leap-day handling. */
export function isDateRangeOverOneYear(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  const maxEnd = new Date(start.getTime());
  const originalMonth = maxEnd.getMonth();
  maxEnd.setFullYear(maxEnd.getFullYear() + 1);
  if (maxEnd.getMonth() !== originalMonth) maxEnd.setDate(0);
  return end > maxEnd;
}

/** 從可用日期中選擇接近一個月前的預設起日。 / Pick the nearest available default start around one month earlier. */
export function getDefaultRangeStartDate(dates, endDate) {
  const end = new Date(`${endDate}T00:00:00`);
  const minStart = new Date(end.getTime());
  const originalDay = minStart.getDate();
  minStart.setDate(1);
  minStart.setMonth(minStart.getMonth() - 1);
  const daysInTargetMonth = new Date(minStart.getFullYear(), minStart.getMonth() + 1, 0).getDate();
  minStart.setDate(Math.min(originalDay, daysInTargetMonth));
  const candidates = dates.filter(date => new Date(`${date}T00:00:00`) >= minStart && date <= endDate);
  return candidates.length ? candidates[candidates.length - 1] : endDate;
}

/** 取得最新日期之前一個完整曆月的首尾日期。 / Return the complete calendar month preceding the latest date. */
export function getPreviousCalendarMonthRange(latestDate) {
  const latest = new Date(`${latestDate}T00:00:00`);
  const currentMonthStart = new Date(latest.getFullYear(), latest.getMonth(), 1);
  const previousMonthEnd = new Date(currentMonthStart.getTime() - 86400000);
  const previousMonthStart = new Date(previousMonthEnd.getFullYear(), previousMonthEnd.getMonth(), 1);
  return {
    startDate: toDateInputValue(previousMonthStart),
    endDate: toDateInputValue(previousMonthEnd)
  };
}

/** 將 YYYY-MM 展開為該月首日與末日。 / Expand YYYY-MM into the first and last dates of that month. */
export function getCalendarMonthRange(monthValue) {
  const [yearText, monthText] = monthValue.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  return { startDate: `${monthValue}-01`, endDate: toDateInputValue(new Date(year, month, 0)) };
}

/** 將月份轉為可排序、可相減的整數索引。 / Convert a month into a sortable integer index. */
export function monthIndex(monthValue) {
  const match = /^(\d{4})-(\d{2})$/.exec(monthValue || '');
  if (!match) return null;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? Number(match[1]) * 12 + month - 1 : null;
}

/** 依指定月數位移 YYYY-MM，支援跨年。 / Shift YYYY-MM by a number of months across year boundaries. */
export function shiftMonth(monthValue, offset) {
  const index = monthIndex(monthValue);
  if (index === null) return '';
  const shifted = index + offset;
  return `${Math.floor(shifted / 12)}-${String((shifted % 12) + 1).padStart(2, '0')}`;
}
