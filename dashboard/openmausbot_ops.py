"""Read-only shared operations view over OpenMausBot's own routines and runs.

OpenMausBot stays authoritative: this module only reads `routines.json` and
`bots.json` (the files it owns), expands the enabled routines' schedules into
occurrences for a requested window, and pairs them with the execution records
OpenMausBot kept.  It never schedules, retries, writes or calls a bot.

Scheduled occurrences and execution records are different things and stay
separate in the output.  A past occurrence with no record is reported as
"no record", never as "missed": the run log is bounded, so absence proves
nothing.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import time
from zoneinfo import ZoneInfo

DATA_DIR = '/var/lib/docker/volumes/openmausbot_data/_data/.openmausbot'
IDENTITY_OVERRIDES = '/etc/omb-identity-overrides.json'
MAX_OCCURRENCES = 3000
MAX_WINDOW_DAYS = 45
STALE_AFTER_S = 15 * 60          # source file not rewritten for this long -> "stale" hint
OVERDUE_GRACE_MS = 10 * 60_000   # nextRunAt this far in the past -> attention
MATCH_WINDOW_MS = 10 * 60_000    # run.scheduledFor within this of an occurrence -> same one
DONE = {'completed', 'failed'}

MONTHS = {m: i + 1 for i, m in enumerate('jan feb mar apr may jun jul aug sep oct nov dec'.split())}
DAYS = {d: i for i, d in enumerate('sun mon tue wed thu fri sat'.split())}


def _field(text: str, lo: int, hi: int, names: dict | None = None) -> set[int]:
    out: set[int] = set()
    for part in text.split(','):
        step = 1
        if '/' in part:
            part, s = part.split('/', 1)
            step = int(s)
            if step < 1:
                raise ValueError('step')
        if part in ('*', '?', ''):
            a, b = lo, hi
        else:
            def num(tok: str) -> int:
                tok = tok.lower()
                if names and tok[:3] in names:
                    return names[tok[:3]]
                return int(tok)
            if '-' in part:
                x, y = part.split('-', 1)
                a, b = num(x), num(y)
            else:
                a = num(part)
                b = hi if step > 1 else a
        if a < lo or b > hi or a > b:
            raise ValueError('range')
        out.update(range(a, b + 1, step))
    return out


def parse_cron(expr: str) -> dict:
    parts = expr.split()
    if len(parts) != 5:
        raise ValueError('cron needs 5 fields')
    dow = _field(parts[4].replace('7', '0') if parts[4].isdigit() else parts[4], 0, 7, DAYS)
    return {
        'min': _field(parts[0], 0, 59), 'hour': _field(parts[1], 0, 23),
        'dom': _field(parts[2], 1, 31), 'mon': _field(parts[3], 1, 12, MONTHS),
        'dow': {d % 7 for d in dow},
        'dom_star': parts[2] in ('*', '?'), 'dow_star': parts[4] in ('*', '?'),
    }


def _day_matches(c: dict, d: dt.date) -> bool:
    if d.month not in c['mon']:
        return False
    dom_ok = d.day in c['dom']
    dow_ok = ((d.weekday() + 1) % 7) in c['dow']
    if c['dom_star'] and c['dow_star']:
        return True
    if c['dom_star']:
        return dow_ok
    if c['dow_star']:
        return dom_ok
    return dom_ok or dow_ok          # standard cron: either restricted field may match


def cron_occurrences(expr: str, tz_name: str, start_ms: int, end_ms: int) -> list[int]:
    """Epoch-ms occurrences in [start_ms, end_ms) evaluated in the routine's own zone.

    Wall-clock times that do not exist (spring-forward gap) are skipped; an
    ambiguous time (autumn fold) fires once, at its first occurrence.
    """
    c = parse_cron(expr)
    tz = ZoneInfo(tz_name)
    first = dt.datetime.fromtimestamp(start_ms / 1000, tz).date() - dt.timedelta(days=1)
    last = dt.datetime.fromtimestamp(end_ms / 1000, tz).date() + dt.timedelta(days=1)
    out: list[int] = []
    day = first
    while day <= last:
        if _day_matches(c, day):
            for h in sorted(c['hour']):
                for m in sorted(c['min']):
                    naive = dt.datetime(day.year, day.month, day.day, h, m)
                    local = naive.replace(tzinfo=tz, fold=0)
                    utc = local.astimezone(dt.timezone.utc)
                    # nonexistent local time: round-trip changes the wall clock
                    if utc.astimezone(tz).replace(tzinfo=None) != naive:
                        continue
                    ms = int(utc.timestamp() * 1000)
                    if start_ms <= ms < end_ms:
                        out.append(ms)
        day += dt.timedelta(days=1)
    return sorted(set(out))


def occurrences_for(routine: dict, start_ms: int, end_ms: int) -> tuple[list[int], str | None]:
    sched = routine.get('schedule') or {}
    kind = sched.get('type')
    try:
        if kind == 'cron':
            return cron_occurrences(sched['expression'], sched.get('timeZone') or 'UTC', start_ms, end_ms), None
        if kind == 'once':
            at = int(sched['at'])
            return ([at] if start_ms <= at < end_ms else []), None
        if kind == 'interval':
            every = int(sched['everyMinutes']) * 60_000
            anchor = sched.get('anchorAt')
            if anchor is None:
                anchor = routine.get('createdAt') or start_ms
            anchor = int(anchor)
            if every <= 0:
                return [], 'invalid interval'
            k = max(0, -(-(start_ms - anchor) // every))
            out, t = [], anchor + k * every
            while t < end_ms and len(out) < MAX_OCCURRENCES:
                out.append(t)
                t += every
            return out, None
    except (KeyError, ValueError, TypeError, ZoneInfoError) as exc:
        return [], 'unreadable schedule: %s' % type(exc).__name__
    return [], 'unsupported schedule type'


try:                                 # ZoneInfoNotFoundError subclasses KeyError
    from zoneinfo import ZoneInfoNotFoundError as ZoneInfoError
except ImportError:                  # pragma: no cover
    ZoneInfoError = KeyError


def _read_json(path: str):
    with open(path, 'r', encoding='utf-8') as fh:
        return json.load(fh)


def build(start_ms: int, end_ms: int, now_ms: int | None = None, data_dir: str | None = None, *,
          source_documents: dict | None = None, source_states: dict | None = None) -> dict:
    now_ms = now_ms or int(time.time() * 1000)
    data_dir = data_dir or os.environ.get('OMB_DATA_DIR', DATA_DIR)
    if end_ms <= start_ms or end_ms - start_ms > MAX_WINDOW_DAYS * 86_400_000:
        raise ValueError('window must be between 1 ms and %d days' % MAX_WINDOW_DAYS)
    if source_documents is None:
        sources = {}
        try:
            routines_doc = _read_json(os.path.join(data_dir, 'routines.json'))
            rpath = os.path.join(data_dir, 'routines.json')
            age = time.time() - os.path.getmtime(rpath)
            sources['routines'] = {'state': 'ok', 'label': 'OpenMausBot routines.json',
                                   'age_seconds': int(age)}
        except (OSError, ValueError):
            routines_doc = None
            sources['routines'] = {'state': 'unavailable', 'label': 'OpenMausBot routines.json'}
        try:
            bots_doc = _read_json(os.path.join(data_dir, 'bots.json'))
            sources['bots'] = {'state': 'ok', 'label': 'OpenMausBot bots.json'}
        except (OSError, ValueError):
            bots_doc = None
            sources['bots'] = {'state': 'unavailable', 'label': 'OpenMausBot bots.json'}
    
    else:
        routines_doc = source_documents.get('routines')
        bots_doc = source_documents.get('bots')
        sources = {
            name: {'state': 'ok' if document is not None else 'unavailable',
                   'label': 'OpenMausBot %s API' % name}
            for name, document in (('routines', routines_doc), ('bots', bots_doc))
        }
        if source_states:
            sources.update(source_states)

    bots = []
    if bots_doc is not None:
        rows = bots_doc.get('bots') if isinstance(bots_doc, dict) else bots_doc
        for b in rows or []:
            if isinstance(b, dict) and isinstance(b.get('id'), str):
                bots.append({'id': b['id'], 'name': b.get('name') or b['id'][:8],
                             'color': b.get('color') if isinstance(b.get('color'), str) else None})
    known = {b['id'] for b in bots}

    result = {'generated_at': now_ms, 'window': {'from': start_ms, 'to': end_ms},
              'sources': sources, 'bots': bots,
              'routines': [], 'occurrences': [], 'runs': [], 'attention': [], 'now': {},
              'history': {}, 'unsupported': ['pending approvals', 'blocked/queued work states']}
    if routines_doc is None:
        return result

    all_runs = [r for r in routines_doc.get('runs') or [] if isinstance(r, dict)]
    routines = [r for r in routines_doc.get('routines') or [] if isinstance(r, dict)]
    names = {r['id']: r.get('name') for r in routines if 'id' in r}

    for r in routines:
        sched = r.get('schedule') or {}
        result['routines'].append({
            'id': r.get('id'), 'name': r.get('name'), 'bot_id': r.get('botId'),
            'enabled': bool(r.get('enabled')), 'schedule_type': sched.get('type'),
            'cron': sched.get('expression'), 'timezone': sched.get('timeZone'),
            'every_minutes': sched.get('everyMinutes'), 'duration_minutes': r.get('durationMinutes'),
            'timeout_minutes': r.get('timeoutMinutes'), 'next_run_at': r.get('nextRunAt'),
            'bot_known': r.get('botId') in known, 'source': 'OpenMausBot routine',
        })

    runs = []
    for x in all_runs:
        runs.append({
            'id': x.get('id'), 'routine_id': x.get('routineId'),
            'routine_name': x.get('routineName') or names.get(x.get('routineId')),
            'bot_id': x.get('botId'), 'status': x.get('status'),
            'trigger': x.get('triggerSource') or ('manual' if x.get('manual') else 'unknown'),
            'manual': bool(x.get('manual')), 'scheduled_for': x.get('scheduledFor'),
            'started_at': x.get('startedAt'), 'finished_at': x.get('finishedAt'),
            'created_at': x.get('createdAt'),
            'outcome': (x.get('report') or {}).get('state') if isinstance(x.get('report'), dict) else None,
            'thread_id': x.get('threadId') or x.get('resultsThreadId'),
            'source': 'OpenMausBot run record',
        })
    runs.sort(key=lambda r: r.get('started_at') or r.get('created_at') or 0, reverse=True)
    result['runs'] = runs

    sched_runs = [r for r in runs if r['trigger'] == 'schedule' and r['scheduled_for']]
    oldest_kept = min((r['created_at'] for r in runs if r.get('created_at')), default=None)

    occ, warnings = [], []
    for r in routines:
        if not r.get('enabled'):
            continue
        times, warn = occurrences_for(r, start_ms, end_ms)
        if warn:
            warnings.append({'routine_id': r.get('id'), 'message': warn})
        mine = [x for x in sched_runs if x['routine_id'] == r.get('id')]
        for t in times:
            match = next((x for x in mine if abs(x['scheduled_for'] - t) <= MATCH_WINDOW_MS), None)
            if match:
                state = 'ran' if match['status'] == 'completed' else (
                    'failed' if match['status'] == 'failed' else 'running')
            elif t > now_ms:
                state = 'scheduled'
            elif oldest_kept is not None and t < oldest_kept:
                state = 'unknown'        # older than the retained run log
            else:
                state = 'no_record'
            occ.append({'routine_id': r.get('id'), 'bot_id': r.get('botId'), 'at': t,
                        'state': state, 'run_id': match['id'] if match else None})
    occ.sort(key=lambda o: o['at'])
    result['occurrences'] = occ[:MAX_OCCURRENCES]
    result['occurrences_truncated'] = len(occ) > MAX_OCCURRENCES
    result['schedule_warnings'] = warnings

    # Needs attention: only what the source states or what is verifiable from it.
    att = []
    for x in runs:
        if x['status'] == 'failed':
            att.append({'kind': 'failed_run', 'bot_id': x['bot_id'], 'routine_id': x['routine_id'],
                        'run_id': x['id'], 'at': x['finished_at'] or x['started_at'] or x['created_at'],
                        'text': 'Run failed: %s' % (x['routine_name'] or 'routine'), 'source': x['source']})
    for r in routines:
        n = r.get('nextRunAt')
        if r.get('enabled') and isinstance(n, int) and n < now_ms - OVERDUE_GRACE_MS \
                and (r.get('schedule') or {}).get('type') != 'once':
            att.append({'kind': 'overdue_next_run', 'bot_id': r.get('botId'), 'routine_id': r.get('id'),
                        'at': n, 'text': 'Next run time has passed without advancing: %s' % r.get('name'),
                        'source': 'OpenMausBot routine'})
        if r.get('botId') not in known and bots_doc is not None:
            att.append({'kind': 'orphan_routine', 'bot_id': r.get('botId'), 'routine_id': r.get('id'),
                        'at': None, 'text': 'Routine points at a bot that is not in the roster: %s' % r.get('name'),
                        'source': 'OpenMausBot routine'})
    for w in warnings:
        att.append({'kind': 'schedule_unreadable', 'bot_id': None, 'routine_id': w['routine_id'],
                    'at': None, 'text': w['message'], 'source': 'dashboard'})
    # The file is only rewritten when a routine runs, so age alone is not staleness:
    # flag it only when an enabled recurring routine is overdue as well.
    overdue = any(a['kind'] == 'overdue_next_run' for a in att)
    sources['routines']['stale'] = bool(overdue and sources['routines'].get('age_seconds', 0) > STALE_AFTER_S)
    if sources['routines']['stale']:
        att.append({'kind': 'stale_source', 'bot_id': None, 'routine_id': None, 'at': None,
                    'text': 'routines.json has not been rewritten for %d min; it may be stale'
                    % (sources['routines']['age_seconds'] // 60), 'source': 'dashboard'})
    att.sort(key=lambda a: a['at'] or 0, reverse=True)
    result['attention'] = att

    running = [x for x in runs if x['status'] not in DONE]
    upcoming = []
    for r in routines:
        n = r.get('nextRunAt')
        if r.get('enabled') and isinstance(n, int) and n >= now_ms:
            upcoming.append({'routine_id': r.get('id'), 'bot_id': r.get('botId'), 'at': n})
    upcoming.sort(key=lambda u: u['at'])
    result['now'] = {'running': running, 'upcoming': upcoming[:20]}
    result['history'] = {
        'kept_runs': len(runs), 'oldest_kept_at': oldest_kept,
        'note': 'OpenMausBot keeps a bounded run log; older occurrences cannot be verified.',
    }
    return result
