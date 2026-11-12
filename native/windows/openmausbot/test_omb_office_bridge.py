import runpy
import sys
import unittest
import urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import omb_office_bridge as bridge


class MapperTests(unittest.TestCase):
    def setUp(self):
        self.mapper = bridge.OfficeMapper()
        self.mapper.remember_bot({'id': 'bot_123456', 'name': 'Actual name',
                                  'threadId': 'thread_123',
                                  'tasks': [{'threadId': 'thread_456'}]})
        self.now = datetime.now(timezone.utc)

    def frame(self, event_id='event_1', typ='turn.started', thread='thread_123', stamp=None):
        return {'kind': 'runtime', 'event': {'eventId': event_id, 'type': typ,
                'threadId': thread, 'createdAt': stamp or self.now.isoformat(),
                'text': 'PRIVATE CONTENT'}}

    def deliver(self, frame):
        events = self.mapper.mapped_events(frame)
        if self.mapper.pending_event:
            self.mapper.acknowledge(self.mapper.pending_event)
        return events

    def test_original_time_and_replay(self):
        old = (self.now - timedelta(minutes=8)).isoformat()
        frame = self.frame(stamp=old)
        events = self.deliver(frame)
        self.assertEqual(events[0]['timestamp'], old)
        self.assertEqual(events[0]['data']['project_name'], 'Actual name')
        self.assertNotIn('PRIVATE CONTENT', repr(events))
        self.assertEqual(self.deliver(frame), [])

    def test_invalid_identity_or_timestamp_is_ignored(self):
        for event_id, stamp in [('', self.now.isoformat()), ('bad/id', self.now.isoformat()),
                                ('a', 'bad'), ('b', '2026-01-01T00:00:00'),
                                ('c', (self.now + timedelta(minutes=5)).isoformat())]:
            self.assertEqual(self.deliver(self.frame(event_id=event_id, stamp=stamp)), [])
        self.assertFalse(self.mapper.active)

    def test_roster_rename_and_threads_do_not_generate_activity(self):
        self.assertEqual(self.deliver({'kind': 'bot', 'bot': {
            'id': 'bot_123456', 'name': 'Renamed', 'threadId': 'thread_456'}}), [])
        self.assertEqual(self.deliver(self.frame()), [])
        self.assertEqual(self.deliver(self.frame(thread='thread_456'))[0]['data']['project_name'], 'Renamed')

    def test_overlapping_threads_and_duplicate_suppressed_before_transition(self):
        self.assertEqual(len(self.deliver(self.frame())), 1)
        second = self.frame(event_id='event_2', thread='thread_456')
        self.assertEqual(self.deliver(second), [])
        self.assertEqual(self.deliver(second), [])
        self.assertEqual(len(self.mapper.active), 2)
        self.assertEqual(self.deliver(self.frame(event_id='event_3', typ='turn.completed')), [])
        self.assertEqual(len(self.deliver(self.frame(event_id='event_4', typ='turn.completed', thread='thread_456'))), 1)

    def test_cache_is_bounded(self):
        for i in range(bridge.MAX_SEEN_EVENTS + 1):
            self.mapper.acknowledge(str(i))
        self.assertEqual(len(self.mapper.seen), bridge.MAX_SEEN_EVENTS)
        self.assertNotIn('0', self.mapper.seen)

    def test_delivery_is_not_acknowledged_by_mapping(self):
        frame = self.frame()
        self.mapper.mapped_events(frame)
        self.assertNotIn('event_1', self.mapper.seen)


class InventoryTests(unittest.TestCase):
    def test_transient_retry_and_exhaustion(self):
        for error in (urllib.error.URLError('offline'), TimeoutError(),
                      urllib.error.HTTPError('http://localhost', 503, 'unavailable', {}, None)):
            with self.subTest(error=type(error).__name__), patch.object(bridge, 'request_json', side_effect=[error, []]) as request, patch.object(bridge.time, 'sleep') as sleep:
                self.assertEqual(bridge.initial_inventory(None, 'endpoint', ''), [])
                self.assertEqual(request.call_count, 2)
                sleep.assert_called_once_with(5)
        with patch.object(bridge, 'request_json', side_effect=urllib.error.URLError('offline')) as request, patch.object(bridge.time, 'sleep') as sleep:
            with self.assertRaises(RuntimeError):
                bridge.initial_inventory(None, 'endpoint', '')
            self.assertEqual(request.call_count, 5)
            self.assertEqual([x.args[0] for x in sleep.call_args_list], [5, 10, 20, 40])

    def test_refusal_and_invalid_inventory_are_terminal(self):
        for error in (urllib.error.HTTPError('http://localhost', 401, 'refused', {}, None),
                      urllib.error.HTTPError('http://localhost', 429, 'refused', {}, None),
                      ValueError('invalid JSON'), RuntimeError('invalid schema or oversized')):
            with self.subTest(error=type(error).__name__), patch.object(bridge, 'request_json', side_effect=error) as request, patch.object(bridge.time, 'sleep') as sleep:
                with self.assertRaises(type(error)):
                    bridge.initial_inventory(None, 'endpoint', '')
                request.assert_called_once()
                sleep.assert_not_called()


class RunnerTests(unittest.TestCase):
    def test_terminal_refusal_is_not_retried(self):
        script = Path(__file__).with_name('omb_office_bridge_run.py')
        with patch('subprocess.run') as run, patch('time.sleep') as sleep, patch.object(sys, 'argv', [str(script)]):
            run.return_value.returncode = 2
            with self.assertRaises(SystemExit) as result:
                runpy.run_path(str(script), run_name='__main__')
        self.assertEqual(result.exception.code, 2)
        self.assertEqual(run.call_count, 1)
        sleep.assert_not_called()

    def test_explicit_port_and_invalid_port(self):
        script = Path(__file__).with_name('omb_office_bridge_run.py')
        for value, expected in [('8799', 2), ('80', 2), ('65535', 2), ('nope', 2)]:
            with self.subTest(value=value), patch('subprocess.run') as run, patch.object(sys, 'argv', [str(script), '--openmausbot-port', value]):
                run.return_value.returncode = 2
                with self.assertRaises(SystemExit) as result:
                    runpy.run_path(str(script), run_name='__main__')
                self.assertEqual(result.exception.code, expected)
                if value == '8799':
                    self.assertEqual(run.call_args.kwargs['env']['OMB_ORIGIN'], 'http://127.0.0.1:8799')
                else:
                    run.assert_not_called()


class StreamTests(unittest.TestCase):
    def test_gap_refresh_preserves_acknowledged_replay_guard(self):
        from contextlib import nullcontext
        bot = {'id': 'bot_123456', 'name': 'Real name', 'threadId': 'thread_123'}
        event = {'kind': 'runtime', 'event': {'eventId': 'event_1', 'threadId': 'thread_123',
                 'type': 'turn.started', 'createdAt': datetime.now(timezone.utc).isoformat()}}
        def frames(_response):
            yield 'cursor1', event
            yield None, {'kind': 'hello', 'resumed': False}
            yield 'cursor1', event
            raise bridge.OfficeRefused()
        class Response:
            status = 200
            headers = {'Content-Type': 'text/event-stream'}
        class Opener:
            def open(self, *_args, **_kwargs):
                return nullcontext(Response())
        with patch.dict('os.environ', {'OFFICE_KEYS_JSON': 'unused'}), \
             patch.object(bridge, 'read_office_key', return_value='test-key'), \
             patch.object(bridge.urllib.request, 'build_opener', return_value=Opener()), \
             patch.object(bridge, 'request_json', return_value=[bot]) as inventory, \
             patch.object(bridge, 'sse_messages', side_effect=frames), \
             patch.object(bridge, 'send_office') as send, \
             patch('sys.stderr'):
            self.assertEqual(bridge.run(), 2)
        self.assertEqual(inventory.call_count, 2)
        self.assertEqual(send.call_count, 1)


if __name__ == '__main__':
    unittest.main()
