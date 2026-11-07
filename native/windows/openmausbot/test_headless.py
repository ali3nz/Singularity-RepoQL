"""Tests for the headless OpenMausBot layer (fleet#893 W1).

No Windows host, network, model call or real OpenMausBot install is needed:
the payload, the health endpoint and the MCP server are faked at the same
boundaries the real code uses. The live proof is a separate, explicitly gated
test (``test_headless_live.py``).
"""
from __future__ import annotations

import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import headless  # noqa: E402


def make_tarball(dest: Path, *, files: dict[str, bytes] | None = None,
                 symlink: str | None = None, escape: str | None = None) -> Path:
    payload = files if files is not None else {
        "package/cli.js": b"#!/usr/bin/env node\n",
        "package/dist-server/openmausbot.js": b"// bundle\n",
        "package/package.json": b'{"version":"0.1.141"}\n',
    }
    with tarfile.open(dest, "w:gz") as archive:
        for name, data in payload.items():
            info = tarfile.TarInfo(name)
            info.size = len(data)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(data))
        if symlink:
            info = tarfile.TarInfo(symlink)
            info.type = tarfile.SYMTYPE
            info.linkname = "/etc/passwd"
            archive.addfile(info)
        if escape:
            info = tarfile.TarInfo(escape)
            info.size = 3
            archive.addfile(info, io.BytesIO(b"bad"))
    return dest


class FakeHealth:
    def __init__(self, pid: int | None = None):
        self.pid = os.getpid() if pid is None else pid
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802 - stdlib naming
                if self.path != "/api/health":
                    self.send_error(404)
                    return
                body = json.dumps({"app": "openmausbot", "pid": outer.pid,
                                   "static": True}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_args):
                return

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *_exc):
        self.server.shutdown()
        self.server.server_close()


FAKE_CLI = r"""
const readline = require('node:readline');
const mode = process.env.FAKE_OMB_MODE || 'ok';
const rl = readline.createInterface({input: process.stdin});
rl.on('line', (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const reply = (result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0', id:msg.id, result}) + '\n');
  if (msg.method === 'initialize') return reply({protocolVersion:'2024-11-05', capabilities:{tools:{}}, serverInfo:{name:'fake-omb'}});
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'tools/list') return reply({tools:[{name:'list_bots'},{name:'send_bot_message'},{name:'wait_for_conversation'}]});
  if (msg.method === 'tools/call') {
    if (process.env.LEAK_CHECK_FILE) {
      require('node:fs').writeFileSync(process.env.LEAK_CHECK_FILE, JSON.stringify({argv: process.argv, env: Object.keys(process.env)}));
    }
    const name = msg.params.name;
    if (name === 'list_bots') return reply({content:[{type:'text', text: JSON.stringify({bots:[{id:'bot-1', name:'MausBot', chiefOfStaff:true}]})}], structuredContent:{bots:[{id:'bot-1', name:'MausBot', chiefOfStaff:true}]}});
    if (name === 'send_bot_message') {
      if (mode === 'refuse') return reply({isError:true, content:[{type:'text', text:'engine_not_ready: no model credential'}]});
      return reply({content:[{type:'text', text: JSON.stringify({messageId:'m-1', threadId:'t-1'})}], structuredContent:{messageId:'m-1', threadId:'t-1'}});
    }
    if (name === 'wait_for_conversation') {
      if (mode === 'refuse') return reply({isError:true, content:[{type:'text', text:'stalled'}]});
      return reply({content:[{type:'text', text: JSON.stringify({status:'settled', state:'completed'})}], structuredContent:{status:'settled', state:'completed'}});
    }
    return reply({content:[{type:'text', text:'{}'}], structuredContent:{}});
  }
});
"""


@unittest.skipUnless(shutil.which("node"), "node is required to drive the MCP boundary")
class HeadlessTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="omb-headless-"))
        self.root = self.tmp / "root"
        self.state = self.tmp / "state"
        self.real_node = shutil.which("node")
        self.node = self.write_node_shim()
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def write_node_shim(self) -> str:
        """A `node` that reports the package's minimum version but runs the real one.

        The host's node may be older than engines.node (>=24); the shim keeps
        version gating testable without depending on the CI toolchain.
        """
        if os.name == "nt":
            return self.real_node
        shim = self.tmp / "bin" / "node"
        shim.parent.mkdir(parents=True, exist_ok=True)
        shim.write_text('#!/bin/sh\nif [ "$1" = "-v" ]; then echo v24.0.0; exit 0; fi\n'
                        f'exec "{self.real_node}" "$@"\n')
        shim.chmod(0o755)
        return str(shim)

    # -- payload verification -------------------------------------------------
    def test_integrity_pin_is_required_and_enforced(self):
        tarball = make_tarball(self.tmp / "pkg.tgz")
        computed = headless.digest_bytes(tarball.read_bytes())
        with self.assertRaises(headless.HeadlessError) as caught:
            headless.verify_source(tarball)
        self.assertEqual(caught.exception.code, "OMB_PAYLOAD_UNPINNED")
        verified = headless.verify_source(tarball, integrity="sha512-" + computed["sha512_b64"])
        self.assertEqual(verified["sha256"], computed["sha256"])
        with self.assertRaises(headless.HeadlessError) as caught:
            headless.verify_source(tarball, integrity="sha512-" + "A" * 88)
        self.assertEqual(caught.exception.code, "OMB_INTEGRITY_MISMATCH")
        with self.assertRaises(headless.HeadlessError):
            headless.verify_source(tarball, sha256="0" * 64)

    def test_extract_swaps_the_single_top_level_directory(self):
        tarball = make_tarball(self.tmp / "pkg.tgz")
        dest = self.root / "stage" / "omb"
        result = headless.extract_payload(tarball, dest)
        self.assertTrue((dest / "cli.js").is_file())
        self.assertTrue((dest / headless.MARKER).is_file())
        self.assertTrue(headless.payload_ready(self.root))
        self.assertFalse((dest / "package").exists())
        self.assertEqual(Path(result["path"]), dest)

    def test_extract_refuses_traversal_and_symlinks(self):
        for kwargs in ({"escape": "../escape.txt"}, {"symlink": "package/link"}):
            tarball = make_tarball(self.tmp / (next(iter(kwargs)) + ".tgz"), **kwargs)
            with self.assertRaises(headless.HeadlessError):
                headless.extract_payload(tarball, self.root / "stage" / "omb")
            self.assertFalse((self.root / "stage" / "omb").exists())

    def test_extract_refuses_incomplete_payload(self):
        tarball = make_tarball(self.tmp / "bare.tgz", files={"package/readme.md": b"x"})
        with self.assertRaises(headless.HeadlessError) as caught:
            headless.extract_payload(tarball, self.root / "stage" / "omb")
        self.assertEqual(caught.exception.code, "OMB_PAYLOAD_INCOMPLETE")

    # -- detection ------------------------------------------------------------
    def test_detect_reports_missing_payload_and_low_node(self):
        state, detail = headless.detect(self.state, self.node)
        self.assertEqual(state, headless.NEEDS_ATTENTION)
        self.assertIn("payload", detail)
        self.stage_payload()
        ok, detail = headless.node_ready("definitely-not-node")
        self.assertFalse(ok)
        self.assertIn("node unavailable", detail)

    def test_detect_connected_only_for_the_manifest_pid(self):
        self.stage_payload()
        with FakeHealth() as fake:
            payload = str(headless.payload_dir(self.root))
            headless.write_instance(self.state, {"pid": fake.pid, "port": fake.port,
                                                "payload": payload})
            state, detail = headless.detect(self.state, self.node, port=fake.port)
            self.assertEqual(state, headless.CONNECTED)
            self.assertIn(str(fake.pid), detail)
            headless.write_instance(self.state, {"pid": fake.pid + 1, "port": fake.port,
                                                "payload": payload})
            state, _ = headless.detect(self.state, self.node, port=fake.port)
            self.assertEqual(state, headless.NEEDS_ATTENTION)

    # -- lifecycle refusals ---------------------------------------------------
    def test_start_refuses_foreign_listener_and_busy_port(self):
        self.stage_payload()
        with FakeHealth() as fake:
            with self.assertRaises(headless.HeadlessError) as caught:
                headless.start(self.root, self.state, self.node, port=fake.port)
            self.assertEqual(caught.exception.code, "OMB_PORT_FOREIGN")
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", 0))
            sock.listen(1)
            busy = sock.getsockname()[1]
            with self.assertRaises(headless.HeadlessError) as caught:
                headless.start(self.root, self.state, self.node, port=busy)
            self.assertIn(caught.exception.code, {"OMB_PORT_BUSY", "OMB_PORT_FOREIGN"})

    def test_stop_leaves_a_reused_port_alone(self):
        with FakeHealth() as fake:
            headless.write_instance(self.state, {"pid": fake.pid + 999, "port": fake.port})
            result = headless.stop(self.state)
            self.assertFalse(result["stopped"])
            self.assertIn("pid mismatch", result["reason"])
        fresh = self.tmp / "fresh-state"
        self.assertEqual(headless.stop(fresh), {"stopped": False, "reason": "no instance manifest"})

    # -- official MCP boundary ------------------------------------------------
    def stage_payload(self) -> Path:
        dest = headless.payload_dir(self.root)
        (dest / "dist-server").mkdir(parents=True, exist_ok=True)
        (dest / headless.MARKER).write_text("// fake\n")
        (dest / "cli.js").write_text(FAKE_CLI)
        return dest

    def test_mcp_lists_and_calls_tools_without_a_token(self):
        self.stage_payload()
        leak = self.tmp / "leak.json"
        os.environ["LEAK_CHECK_FILE"] = str(leak)
        self.addCleanup(os.environ.pop, "LEAK_CHECK_FILE", None)
        os.environ["OPENMAUSBOT_TOKEN"] = "omb_sess_should_not_leak"
        self.addCleanup(os.environ.pop, "OPENMAUSBOT_TOKEN", None)
        port = 18799
        headless.write_instance(self.state, {"pid": 1, "port": port,
                                            "payload": str(headless.payload_dir(self.root))})
        result = headless.list_bots(self.state, self.node)
        self.assertIn("list_bots", result["tools"])
        self.assertEqual(result["bots"]["bots"][0]["name"], "MausBot")
        observed = json.loads(leak.read_text())
        self.assertNotIn("OPENMAUSBOT_TOKEN", observed["env"])
        self.assertFalse(any("omb_sess_" in arg for arg in observed["argv"]))

    def test_send_probe_reports_the_precise_blocker(self):
        self.stage_payload()
        headless.write_instance(self.state, {"pid": 1, "port": 18799,
                                            "payload": str(headless.payload_dir(self.root))})
        os.environ["FAKE_OMB_MODE"] = "refuse"
        self.addCleanup(os.environ.pop, "FAKE_OMB_MODE", None)
        blocked = headless.send_probe(self.state, self.node, "probe")
        self.assertFalse(blocked["sent"])
        self.assertFalse(blocked["settled"])
        self.assertIn("no model credential", blocked["reason"])

    def test_send_probe_success_path(self):
        self.stage_payload()
        headless.write_instance(self.state, {"pid": 1, "port": 18799,
                                            "payload": str(headless.payload_dir(self.root))})
        done = headless.send_probe(self.state, self.node, "probe")
        self.assertTrue(done["sent"])
        self.assertTrue(done["settled"])
        self.assertEqual(done["state"], "completed")

    def test_rollback_removes_only_rc_owned_paths(self):
        self.stage_payload()
        headless.write_instance(self.state, {"pid": 1, "port": 18799})
        keep = self.tmp / "keep.txt"
        keep.write_text("owner data")
        result = headless.rollback(self.root, self.state)
        self.assertIn(str(headless.payload_dir(self.root)), result["removed"])
        self.assertFalse(headless.payload_dir(self.root).exists())
        self.assertTrue(keep.is_file())

    def test_cli_status_install_and_bots(self):
        tarball = make_tarball(self.tmp / "pkg.tgz")
        computed = headless.digest_bytes(tarball.read_bytes())
        status = subprocess.run([sys.executable, headless.__file__, "status", "--root",
                                 str(self.root), "--state-dir", str(self.state), "--node",
                                 self.node], capture_output=True, text=True)
        self.assertEqual(status.returncode, 0)
        self.assertIn("needs-attention", status.stdout)
        install = subprocess.run([sys.executable, headless.__file__, "install", "--root",
                                  str(self.root), "--state-dir", str(self.state),
                                  "--tarball", str(tarball), "--integrity",
                                  "sha512-" + computed["sha512_b64"]],
                                 capture_output=True, text=True)
        self.assertEqual(install.returncode, 0, install.stdout + install.stderr)
        self.assertTrue(headless.payload_ready(self.root))


if __name__ == "__main__":
    unittest.main(verbosity=2)
