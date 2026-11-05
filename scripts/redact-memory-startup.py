#!/usr/bin/env python3
"""Stream/filter vendored Memory Core startup output without exposing keys."""
from __future__ import annotations

import codecs
import re
import shlex
import sys
from pathlib import Path

if len(sys.argv) != 2:
    raise SystemExit("usage: redact-memory-startup.py ADMIN_KEY_FILE")
key_file = Path(sys.argv[1])
export_marker = "export ANTHROPIC_AUTH_TOKEN="
triggers = (
    "sk-mem-",
    "authorization",
    "password",
    "passwd",
    "token",
    "secret",
    "api_key",
    "api-key",
    "user_key",
    "user-key",
    "credential",
    export_marker,
)
redaction_patterns = (
    (re.compile(r"(?i)\bsk-mem-[A-Za-z0-9_*.-]+"), "[REDACTED_KEY]"),
    (
        re.compile(
            r"(?i)(\b(?:[A-Z0-9]+[_-])*(?:API[_-]?KEY|TOKEN|PASSWORD|SECRET)\b\s+\[)[^]\r\n]+(\])"
        ),
        r"\1REDACTED\2",
    ),
    (re.compile(r"(?i)(authorization\s*:\s*bearer\s+)[^\s,;]+"), r"\1[REDACTED]"),
    (
        re.compile(
            r"(?i)(\b(?:password|passwd|token|secret|api[_-]?key|user[_-]?key|credential)\b\s*[:=]\s*[\"']?)[^\s\"'`,;}]+"
        ),
        r"\1[REDACTED]",
    ),
)
open_secret_patterns = (
    re.compile(r"(?i)\bsk-mem-[A-Za-z0-9_*.-]*$"),
    re.compile(r"(?i)\b(?:[A-Z0-9]+[_-])*(?:API[_-]?KEY|TOKEN|PASSWORD|SECRET)\b\s*$"),
    re.compile(r"(?i)\b(?:[A-Z0-9]+[_-])*(?:API[_-]?KEY|TOKEN|PASSWORD|SECRET)\b\s+\[[^]\r\n]*$"),
    re.compile(r"(?i)\bauthorization\s*:\s*bearer\s+[^\s,;]*$"),
    re.compile(
        r"(?i)\b(?:password|passwd|token|secret|api[_-]?key|user[_-]?key|credential)\b\s*[:=]\s*[\"']?[^\s\"'`,;}]*$"
    ),
)


def read_secret() -> str:
    try:
        return key_file.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def partial_trigger_start(text: str, secret: str) -> int:
    """Find a trailing partial marker/key prefix that must not be split off."""
    best = len(text)
    folded = text.casefold()
    for trigger in triggers:
        candidate = trigger.casefold()
        for size in range(1, min(len(candidate), len(text)) + 1):
            if folded.endswith(candidate[:size]):
                best = min(best, len(text) - size)
    if secret:
        for size in range(1, min(len(secret), len(text)) + 1):
            if text.endswith(secret[:size]):
                best = min(best, len(text) - size)
    return best


def safe_boundary(text: str, secret: str) -> int:
    boundary = partial_trigger_start(text, secret)
    for pattern in open_secret_patterns:
        match = pattern.search(text)
        if match and match.end() == len(text):
            boundary = min(boundary, match.start())

    marker_at = text.find(export_marker)
    if marker_at >= 0 and text.find("\n", marker_at) < 0:
        boundary = min(boundary, marker_at)

    # Do not split a complete sensitive match across the output boundary.
    changed = True
    while changed:
        changed = False
        for pattern, _replacement in redaction_patterns:
            for match in pattern.finditer(text):
                if match.start() < boundary < match.end():
                    boundary = match.start()
                    changed = True
        if secret:
            start = 0
            while True:
                start = text.find(secret, start)
                if start < 0:
                    break
                if start < boundary < start + len(secret):
                    boundary = start
                    changed = True
                start += 1
    return boundary


def sanitize(text: str, secret: str) -> str:
    output: list[str] = []
    for raw_line in text.splitlines(keepends=True):
        if raw_line.endswith("\r\n"):
            line, ending = raw_line[:-2], "\r\n"
        elif raw_line.endswith("\n") or raw_line.endswith("\r"):
            line, ending = raw_line[:-1], raw_line[-1:]
        else:
            line, ending = raw_line, ""
        if export_marker in line:
            prefix = line.split(export_marker, 1)[0]
            command = f'$(cat {shlex.quote(str(key_file))})'
            line = f'{prefix}{export_marker}"{command}"'
        line += ending
        if secret:
            line = line.replace(secret, "[REDACTED_KEY]")
        for pattern, replacement in redaction_patterns:
            line = pattern.sub(replacement, line)
        output.append(line)
    return "".join(output)


def emit_safe(pending: str, *, eof: bool) -> str:
    secret = read_secret()
    boundary = len(pending) if eof else safe_boundary(pending, secret)
    if boundary:
        sys.stdout.write(sanitize(pending[:boundary], secret))
        sys.stdout.flush()
    return pending[boundary:]


pending = ""
decoder = codecs.getincrementaldecoder("utf-8")("replace")
reader = getattr(sys.stdin.buffer, "read1", sys.stdin.buffer.read)
while True:
    chunk = reader(4096)
    if not chunk:
        break
    pending += decoder.decode(chunk)
    pending = emit_safe(pending, eof=False)
pending += decoder.decode(b"", final=True)
emit_safe(pending, eof=True)
