"""Optional identity-free Rust grouping for authenticated dashboard service errors.

Python retains RepoQL log access, message redaction policy, query filtering and
signature derivation; Rust only receives stable signature positions and the rank
of each timestamp. Compiled results require exact Python comparison.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess

SCHEMA = "singularity-dashboard-service-errors/v1"
MAX_EVENTS = 10000
MAX_INPUT_BYTES = 350000
MAX_OUTPUT_BYTES = 20000


def _reference(records, page, page_size):
    groups = {}
    positions = {}
    for event_index, record in enumerate(records):
        signature = re.sub(r"\d+", "#", record["msg"])[:180]
        if signature not in groups:
            positions[signature] = len(positions)
            groups[signature] = {"message": record["msg"], "count": 0,
                                 "first_ts": record["ts"], "last_ts": record["ts"],
                                 "level": record["level"], "component": "repoql-host",
                                 "kind": "service", "signature": signature,
                                 "_group_index": positions[signature], "_last_event": event_index}
        item = groups[signature]
        item["count"] += 1
        # Preserve the original Handler.errors semantics exactly, including
        # its first_ts update on every event rather than the historical earliest.
        item["first_ts"] = record["ts"]
        item["last_ts"] = record["ts"]
        item["level"] = record["level"]
        item["_last_event"] = event_index
    ordered = sorted(groups.values(), key=lambda item: item["last_ts"], reverse=True)
    result = [{key:value for key,value in row.items() if not key.startswith('_')}
              for row in ordered[(page-1)*page_size:page*page_size]]
    expected = {"total": len(ordered), "groups": [
        {"group_index": row["_group_index"], "count": row["count"], "last_event":row["_last_event"]}
        for row in ordered[(page-1)*page_size:page*page_size]]}
    return {"total":len(ordered), "rows":result}, expected


def group_service_errors(records, page, page_size, *, rust_bin=None, runner=subprocess.run):
    if type(page) is not int or type(page_size) is not int or page < 1 or page_size < 1 or page_size > 200:
        raise ValueError("invalid_error_paging")
    projected, expected = _reference(records, page, page_size)
    binary = os.environ.get('SINGULARITY_DASHBOARD_SERVICE_ERRORS_RUST_BINARY','') if rust_bin is None else rust_bin
    if not binary:
        return projected
    if len(records) > MAX_EVENTS:
        raise RuntimeError('service_errors_native_input_too_large')
    # Stable ordinal group and time mappings never expose the log messages or timestamps.
    names = {}
    for record in records:
        signature = re.sub(r"\d+", "#", record["msg"])[:180]
        if signature not in names:
            names[signature] = len(names)
    ranks = {ts:i for i,ts in enumerate(sorted({record["ts"] for record in records}))}
    events = [
        {"group":names[re.sub(r"\d+", "#", rec["msg"])[:180]], "time_rank":ranks[rec["ts"]]}
        for rec in records
    ]
    path = Path(binary)
    if not path.is_absolute() or path.is_symlink() or not path.is_file():
        raise RuntimeError('service_errors_native_binary_invalid')
    parent=path.parent
    while parent != parent.parent:
        if parent.is_symlink():
            raise RuntimeError('service_errors_native_binary_invalid')
        parent=parent.parent
    request=json.dumps({"schema":SCHEMA,"events":events,"page":page,"page_size":page_size},
                       separators=(',',':'))
    if len(request.encode('utf-8')) > MAX_INPUT_BYTES:
        raise RuntimeError('service_errors_native_input_too_large')
    env={k:v for k,v in os.environ.items()
         if k.upper() in {'PATH','SYSTEMROOT','WINDIR','TEMP','TMP','HOME'}}
    try:
        process=runner([str(path)],input=request,text=True,capture_output=True,
                       check=False,shell=False,timeout=8,env=env)
        if process.returncode or len(process.stdout.encode('utf-8')) > MAX_OUTPUT_BYTES:
            raise RuntimeError('service_errors_native_execution_failed')
        actual=json.loads(process.stdout)
    except (OSError,ValueError,subprocess.SubprocessError) as exc:
        raise RuntimeError('service_errors_native_execution_failed') from exc
    if actual != expected:
        raise RuntimeError('service_errors_native_parity_mismatch')
    return projected
