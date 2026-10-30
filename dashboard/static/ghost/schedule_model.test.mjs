import assert from 'node:assert/strict';
import {test} from 'node:test';
import {dayKeyInZone, parseDay, addDays, weekDays, occurrencesForDay} from './schedule_model.mjs';

test('seven calendar days including empty days, Monday first', () => {
  assert.deepEqual(weekDays('2026-10-30'), ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01']);
  assert.deepEqual(weekDays('2026-10-30', 1), ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07', '2026-11-08']);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
});
test('NZ date key handles timezone transitions without browser locale-dependent formatting', () => {
  assert.equal(dayKeyInZone(new Date('2026-10-29T21:00:00Z')), '2026-10-30');
  assert.equal(dayKeyInZone(new Date('2026-04-04T23:00:00Z')), '2026-04-05');
});
test('rejects impossible dates and unreasonable week offsets', () => {
  assert.throws(() => parseDay('2026-02-29'), /invalid_calendar_day/);
  assert.throws(() => weekDays('2026-10-30', 9999), /invalid_week_offset/);
});
test('drafts appear as daily/weekly recurrences only on matching days and remain non-executable', () => {
  const p = (id, recurrence, date='2026-10-30') => ({id, title:id, date, time:'10:00', recurrence, status:'draft', active:false});
  const plans = [p('once','once'),p('daily','daily'),p('weekly','weekly'),p('future','once','2026-11-01'),p('active','daily'),{...p('unknown','once'),status:'unknown'}];
  plans[4].active=true;
  assert.deepEqual(occurrencesForDay(plans,'2026-10-30').map(p=>p.id), ['once','daily','weekly']);
  assert.deepEqual(occurrencesForDay(plans,'2026-10-31').map(p=>p.id), ['daily']);
  assert.deepEqual(occurrencesForDay(plans,'2026-11-06').map(p=>p.id), ['daily','weekly']);
  assert.deepEqual(occurrencesForDay(plans,'2026-10-29'), []);
});
