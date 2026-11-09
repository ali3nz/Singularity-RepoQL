import datetime as dt, json, os, sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, os.path.dirname(__file__))
import openmausbot_ops as ops
from zoneinfo import ZoneInfo
NZ = 'Pacific/Auckland'
def ms(y, m, d, h=0, mi=0, tz=NZ):
    return int(dt.datetime(y, m, d, h, mi, tzinfo=ZoneInfo(tz)).timestamp() * 1000)

class Cron(unittest.TestCase):
    def test_daily_local_time(self):
        o = ops.cron_occurrences('55 19 * * *', NZ, ms(2026, 11, 8), ms(2026, 11, 11))
        self.assertEqual(len(o), 3)
        self.assertEqual(dt.datetime.fromtimestamp(o[0] / 1000, ZoneInfo(NZ)).strftime('%H:%M'), '19:55')
    def test_weekday_name(self):
        o = ops.cron_occurrences('30 13 * * SAT', NZ, ms(2026, 11, 1), ms(2026, 11, 30))
        self.assertEqual(len(o), 4)
        for t in o:
            self.assertEqual(dt.datetime.fromtimestamp(t / 1000, ZoneInfo(NZ)).weekday(), 5)
    def test_dst_gap_skipped_and_fold_once(self):
        # NZ springs forward 2026-09-27 02:00->03:00, falls back 2027-04-04 03:00->02:00
        gap = ops.cron_occurrences('30 2 * * *', NZ, ms(2026, 9, 26), ms(2026, 9, 29))
        self.assertEqual(len(gap), 2)
        fold = ops.cron_occurrences('30 2 * * *', NZ, ms(2027, 4, 3), ms(2027, 4, 6))
        self.assertEqual(len(fold), 3)
    def test_midnight_and_week_boundary(self):
        o = ops.cron_occurrences('0 0 * * MON', NZ, ms(2026, 11, 8), ms(2026, 11, 16))
        self.assertEqual(len(o), 1)
        end = ms(2026, 11, 9)               # window end is exclusive at local midnight
        self.assertEqual(ops.cron_occurrences('0 0 * * MON', NZ, ms(2026, 11, 8), end), [])
    def test_bad_cron(self):
        with self.assertRaises(ValueError): ops.parse_cron('61 * * * *')
        with self.assertRaises(ValueError): ops.parse_cron('* * *')

class Build(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.d = temporary.name
        now = ms(2026, 11, 8, 12)
        self.now = now
        Path(self.d, 'bots.json').write_text(json.dumps(
            {'bots': [{'id': 'b1', 'name': 'One'}, {'id': 'b2', 'name': 'Two'}]}), encoding='utf-8')
        document = {'routines': [
            {'id': 'r1', 'name': 'Nightly', 'botId': 'b1', 'enabled': True, 'nextRunAt': now - 3_600_000,
             'schedule': {'type': 'cron', 'expression': '0 6 * * *', 'timeZone': NZ}},
            {'id': 'r2', 'name': 'Off', 'botId': 'b2', 'enabled': False, 'schedule': {'type': 'cron', 'expression': '0 6 * * *', 'timeZone': NZ}},
            {'id': 'r3', 'name': 'Orphan', 'botId': 'gone', 'enabled': True, 'nextRunAt': now + 1000,
             'schedule': {'type': 'interval', 'everyMinutes': 60, 'anchorAt': now}},
            {'id': 'r4', 'name': 'BadTz', 'botId': 'b1', 'enabled': True, 'schedule': {'type': 'cron', 'expression': '0 6 * * *', 'timeZone': 'Nope/Zone'}},
        ], 'runs': [
            {'id': 'u1', 'routineId': 'r1', 'botId': 'b1', 'status': 'failed', 'triggerSource': 'schedule',
             'scheduledFor': ms(2026, 11, 8, 6), 'createdAt': ms(2026, 11, 8, 6), 'startedAt': ms(2026, 11, 8, 6), 'finishedAt': ms(2026, 11, 8, 6, 5)},
            {'id': 'u2', 'routineId': 'r1', 'botId': 'b1', 'status': 'running', 'triggerSource': 'webhook',
             'createdAt': now - 1000, 'startedAt': now - 900},
        ]}
        Path(self.d, 'routines.json').write_text(json.dumps(document), encoding='utf-8')
    def run_build(self, a, b):
        return ops.build(ms(*a), ms(*b), now_ms=self.now, data_dir=self.d)
    def test_states_and_separation(self):
        r = self.run_build((2026, 11, 6), (2026, 11, 10))
        st = {(o['routine_id'], o['at']): o['state'] for o in r['occurrences']}
        self.assertEqual(st[('r1', ms(2026, 11, 8, 6))], 'failed')
        self.assertEqual(st[('r1', ms(2026, 11, 9, 6))], 'scheduled')
        self.assertEqual(st[('r1', ms(2026, 11, 7, 6))], 'unknown')   # older than the retained log
        self.assertFalse(any(o['routine_id'] == 'r2' for o in r['occurrences']))  # disabled
        self.assertEqual(len(r['runs']), 2)       # executions stay a separate list
    def test_attention_and_now(self):
        r = self.run_build((2026, 11, 8), (2026, 11, 9))
        kinds = {a['kind'] for a in r['attention']}
        self.assertTrue({'failed_run', 'overdue_next_run', 'orphan_routine', 'schedule_unreadable'} <= kinds)
        self.assertEqual([x['id'] for x in r['now']['running']], ['u2'])
        self.assertIn('pending approvals', r['unsupported'])
    def test_source_unavailable_not_healthy(self):
        os.remove(self.d + '/routines.json')
        r = self.run_build((2026, 11, 8), (2026, 11, 9))
        self.assertEqual(r['sources']['routines']['state'], 'unavailable')
        self.assertEqual(r['attention'], []); self.assertEqual(r['occurrences'], [])
    def test_window_bounds(self):
        with self.assertRaises(ValueError): ops.build(10, 5, data_dir=self.d)
        with self.assertRaises(ValueError): ops.build(0, 90 * 86_400_000, data_dir=self.d)
if __name__ == '__main__': unittest.main()
