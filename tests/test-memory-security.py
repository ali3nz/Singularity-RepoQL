#!/usr/bin/env python3
"""Regression tests for safe Memory Core startup output and key verification."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import shutil
import select
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SENTINEL = "sk-mem-test-only-sentinel-value"
MASKED_TOKEN = "sk-mem-ADMINKEY12****ghij"
PROVIDER_DEFAULT = "unit-test-api-key-6942"


class VerifyHandler(BaseHTTPRequestHandler):
    valid = False
    received_key = ""

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length))
        type(self).received_key = body.get("user_key", "")
        payload = json.dumps({"code": 0, "data": {"valid": self.valid}}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, _format: str, *_args: object) -> None:
        return


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def test_redaction(tmp: Path) -> None:
    key_file = tmp / "admin-key"
    key_file.write_text(SENTINEL, encoding="utf-8")
    key_file.chmod(0o600)
    sample = (
        f"  │  export ANTHROPIC_AUTH_TOKEN='{SENTINEL}'\n"
        f"diagnostic user_key={SENTINEL}\n"
        f"upstream admin user_key validation — {MASKED_TOKEN}\n"
        f"memory group API_KEY [{PROVIDER_DEFAULT}]: \n"
    )
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts/redact-memory-startup.py"), str(key_file)],
        input=sample,
        text=True,
        capture_output=True,
        check=True,
    )
    check(SENTINEL not in result.stdout + result.stderr, "redactor leaked the sentinel key")
    check(MASKED_TOKEN not in result.stdout + result.stderr, "redactor leaked an upstream masked/foreign key")
    check(PROVIDER_DEFAULT not in result.stdout + result.stderr, "redactor leaked a provider key from an upstream prompt default")
    check("API_KEY [REDACTED]" in result.stdout, "redactor did not mask a bracketed API-key default")
    check("$(cat " in result.stdout, "export example does not read from the protected key file")
    check("[REDACTED_KEY]" in result.stdout or "[REDACTED]" in result.stdout, "diagnostic key was not redacted")


def test_redaction_streams_prompts_and_buffers_split_keys(tmp: Path) -> None:
    key_file = tmp / "streaming-admin-key"
    key_file.write_text(SENTINEL, encoding="utf-8")
    key_file.chmod(0o600)
    proc = subprocess.Popen(
        [sys.executable, str(ROOT / "scripts/redact-memory-startup.py"), str(key_file)],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    assert proc.stdin is not None and proc.stdout is not None and proc.stderr is not None
    prompt = "Enter LLM provider: "
    try:
        proc.stdin.write(prompt)
        proc.stdin.flush()
        ready, _, _ = select.select([proc.stdout], [], [], 2.0)
        check(bool(ready), "redactor delayed a prompt until newline")
        check(proc.stdout.read(len(prompt)) == prompt, "redactor changed the interactive prompt")

        safe_prefix = "memory group "
        proc.stdin.write("memory group API_KEY ")
        proc.stdin.flush()
        ready, _, _ = select.select([proc.stdout], [], [], 2.0)
        check(bool(ready), "redactor delayed safe text before a provider-key prompt")
        check(proc.stdout.read(len(safe_prefix)) == safe_prefix, "redactor withheld safe prompt text")
        proc.stdin.write(f"[{PROVIDER_DEFAULT[:8]}")
        proc.stdin.flush()
        ready, _, _ = select.select([proc.stdout], [], [], 0.2)
        check(not ready, "redactor emitted a split provider-key default")
        proc.stdin.write(f"{PROVIDER_DEFAULT[8:]}]: ")
        proc.stdin.flush()
        replacement = "API_KEY [REDACTED]: "
        ready, _, _ = select.select([proc.stdout], [], [], 2.0)
        check(bool(ready), "redactor failed to flush the sanitized provider-key prompt")
        default_output = proc.stdout.read(len(replacement))
        check(default_output == replacement, "redactor did not sanitize the provider-key prompt")

        proc.stdin.write(f"user_key={SENTINEL[:12]}")
        proc.stdin.flush()
        ready, _, _ = select.select([proc.stdout], [], [], 0.2)
        check(not ready, "redactor emitted a partial sensitive value")
        proc.stdin.write(f"{SENTINEL[12:]}\n")
        proc.stdin.flush()
        proc.stdin.close()
        tail = proc.stdout.read()
        stderr = proc.stderr.read()
        rc = proc.wait(timeout=3)
        check(rc == 0, "streaming redactor exited unsuccessfully")
        check(SENTINEL not in tail + stderr, "streaming redactor leaked a split key")
        check(PROVIDER_DEFAULT not in tail + stderr, "streaming redactor leaked a split provider key")
        check("[REDACTED" in tail, "streaming redactor did not replace the split key")
    finally:
        if proc.poll() is None:
            proc.kill()
            proc.wait(timeout=3)


def test_wrapper(tmp: Path) -> None:
    root = tmp / "wrapper-fixture"
    scripts = root / "scripts"
    upstream = root / "memory" / "upstream"
    scripts.mkdir(parents=True)
    upstream.mkdir(parents=True)
    for name in ("start-memory-stack.sh", "redact-memory-startup.py", "verify-memory-user-key.py",
                 "memory-port-boundary.sh", "memory-loopback-docker.sh"):
        shutil.copy2(ROOT / "scripts" / name, scripts / name)

    fake_upstream = upstream / "start-all.sh"
    fake_upstream.write_text(
        "#!/usr/bin/env bash\n"
        "set -e\n"
        "DIR=\"$(cd \"$(dirname \"${BASH_SOURCE[0]}\")\" && pwd)\"\n"
        f"printf '%s\\n' '{SENTINEL}' > \"$DIR/.admin-key\"\n"
        "chmod 600 \"$DIR/.admin-key\"\n"
        f"printf \"  export ANTHROPIC_AUTH_TOKEN='{SENTINEL}'\\n\"\n"
        f"printf '%s\\n' 'admin user_key validation — {MASKED_TOKEN}'\n"
        f"printf '%s\\n' 'memory group API_KEY [{PROVIDER_DEFAULT}]:'\n"
        "if [[ \"${FAIL_UPSTREAM:-0}\" != 0 ]]; then exit \"$FAIL_UPSTREAM\"; fi\n",
        encoding="utf-8",
    )
    fake_upstream.chmod(0o755)
    (upstream / ".env").write_text("# test fixture\n", encoding="utf-8")

    VerifyHandler.valid = True
    VerifyHandler.received_key = ""
    server = ThreadingHTTPServer(("127.0.0.1", 0), VerifyHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        env = os.environ.copy()
        env["MEMORY_CORE_PORT"] = str(server.server_address[1])
        env.pop("MEMORY_CORE_GATEWAY_API_KEY", None)
        # The wrapper's loopback-boundary check is host-dependent (a real host
        # may publish tdai-* wide): the fixture tests the startup pipeline, so
        # pass the documented escape hatch the wrapper accepts.
        env["SINGULARITY_ALLOW_WIDE_MEMORY_PORTS"] = "1"
        wrapper = subprocess.run(
            ["bash", str(scripts / "start-memory-stack.sh")],
            text=True,
            capture_output=True,
            env=env,
            check=False,
        )
        check(wrapper.returncode == 0, "safe startup wrapper failed its fake-upstream run")
        check(SENTINEL not in wrapper.stdout + wrapper.stderr, "startup wrapper leaked the sentinel key")
        check(MASKED_TOKEN not in wrapper.stdout + wrapper.stderr, "startup wrapper leaked the upstream masked key")
        check(PROVIDER_DEFAULT not in wrapper.stdout + wrapper.stderr, "startup wrapper leaked a provider key default")
        check("export ANTHROPIC_AUTH_TOKEN=\"$(cat " in wrapper.stdout, "startup wrapper did not replace the token example")
        check(VerifyHandler.received_key == SENTINEL, "startup wrapper did not reach the auth verifier")
        check((upstream / ".admin-key").stat().st_mode & 0o777 == 0o600, "wrapper did not protect the key file")

        env["FAIL_UPSTREAM"] = "7"
        failed = subprocess.run(
            ["bash", str(scripts / "start-memory-stack.sh")],
            text=True,
            capture_output=True,
            env=env,
            check=False,
        )
        check(failed.returncode == 7, "startup wrapper did not propagate upstream failure")
        check(SENTINEL not in failed.stdout + failed.stderr, "failed startup wrapper leaked the sentinel key")
        check(MASKED_TOKEN not in failed.stdout + failed.stderr, "failed wrapper leaked the upstream masked key")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def test_verifier(tmp: Path, valid: bool) -> None:
    VerifyHandler.valid = valid
    VerifyHandler.received_key = ""
    server = ThreadingHTTPServer(("127.0.0.1", 0), VerifyHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        key_file = tmp / ("admin-key-valid" if valid else "admin-key-invalid")
        key_file.write_text(SENTINEL, encoding="utf-8")
        key_file.chmod(0o600)
        env = os.environ.copy()
        env["MEMORY_CORE_PORT"] = str(server.server_address[1])
        env.pop("MEMORY_CORE_GATEWAY_API_KEY", None)
        # The wrapper's loopback-boundary check is host-dependent (a real host
        # may publish tdai-* wide): the fixture tests the startup pipeline, so
        # pass the documented escape hatch the wrapper accepts.
        env["SINGULARITY_ALLOW_WIDE_MEMORY_PORTS"] = "1"
        result = subprocess.run(
            [sys.executable, str(ROOT / "scripts/verify-memory-user-key.py"), str(key_file)],
            text=True,
            capture_output=True,
            env=env,
            check=False,
        )
        check(VerifyHandler.received_key == SENTINEL, "verifier did not send the key to the API")
        check(SENTINEL not in result.stdout + result.stderr, "verifier leaked the sentinel key")
        check((result.returncode == 0) is valid, "verifier did not honor data.valid")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="memory-key-test-") as name:
        tmp = Path(name)
        test_redaction(tmp)
        test_redaction_streams_prompts_and_buffers_split_keys(tmp)
        test_wrapper(tmp)
        test_verifier(tmp, valid=False)  # HTTP 200/code 0 must not be enough.
        test_verifier(tmp, valid=True)
    print("Memory key safety tests passed")


if __name__ == "__main__":
    main()
