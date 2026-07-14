function toDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function addOneCalendarMonth(date) {
  const next = new Date(date.getTime());
  const originalDay = next.getDate();
  next.setDate(1);
  next.setMonth(next.getMonth() + 1);
  const daysInTargetMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
  next.setDate(Math.min(originalDay, daysInTargetMonth));
  return next;
}

export function isDateRangeOverOneMonth(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00`);
  const end = new Date(`${endDate}T00:00:00`);
  return end > addOneCalendarMonth(start);
}

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

export function getCalendarMonthRange(monthValue) {
  const [yearText, monthText] = monthValue.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) return null;
  return { startDate: `${monthValue}-01`, endDate: toDateInputValue(new Date(year, month, 0)) };
}

export function monthIndex(monthValue) {
  const match = /^(\d{4})-(\d{2})$/.exec(monthValue || '');
  if (!match) return null;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 ? Number(match[1]) * 12 + month - 1 : null;
}

export function shiftMonth(monthValue, offset) {
  const index = monthIndex(monthValue);
  if (index === null) return '';
  const shifted = index + offset;
  return `${Math.floor(shifted / 12)}-${String((shifted % 12) + 1).padStart(2, '0')}`;
}
