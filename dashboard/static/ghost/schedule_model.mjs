/** View-only calendar model: this never schedules or executes a Ghost task. */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function dayKeyInZone(when = new Date(), timeZone = 'Pacific/Auckland') {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(when);
  const part = type => parts.find(p => p.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function parseDay(day) {
  if (typeof day !== 'string' || !ISO_DAY.test(day)) throw new RangeError('invalid_calendar_day');
  const utc = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(utc.getTime()) || utc.toISOString().slice(0, 10) !== day) {
    throw new RangeError('invalid_calendar_day');
  }
  return utc;
}

export function addDays(day, count) {
  if (!Number.isInteger(count) || Math.abs(count) > 365000) throw new RangeError('invalid_day_offset');
  const d = parseDay(day);
  d.setUTCDate(d.getUTCDate() + count);
  return d.toISOString().slice(0, 10);
}

export function weekDays(day, offset = 0) {
  if (!Number.isInteger(offset) || Math.abs(offset) > 520) throw new RangeError('invalid_week_offset');
  const mondayShift = (parseDay(day).getUTCDay() + 6) % 7;
  const monday = addDays(day, -mondayShift + 7 * offset);
  return Array.from({length: 7}, (_, i) => addDays(monday, i));
}

export function occurrencesForDay(plans, day) {
  const target = parseDay(day).getTime();
  if (!Array.isArray(plans)) return [];
  return plans.filter(p => {
    if (!p || typeof p !== 'object' || p.active === true || p.status !== 'draft') return false;
    let start;
    try { start = parseDay(p.date).getTime(); } catch { return false; }
    const daysSince = Math.round((target - start) / 86400000);
    if (daysSince < 0) return false;
    if (p.recurrence === 'once') return daysSince === 0;
    if (p.recurrence === 'daily') return true;
    if (p.recurrence === 'weekly') return daysSince % 7 === 0;
    return false;
  }).sort((a, b) => String(a.time).localeCompare(String(b.time)));
}
