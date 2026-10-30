"""Draft release gate: Claude Office Ghost-only patch provenance and applied build.

Three layers:

* repository layer (always runs): the patch set exists, targets the known files, removes the
  two Sol seeds and adds filters instead, seeds the operator's "Ben" layout as the default,
  renders the full authored desk set, accepts loopback WebSocket origins, and is documented by
  office/PROVENANCE.md;
* asset layer (always runs): the bundled Ben layout is byte-identical to the layout the live
  Docker deployment serves (43 desk/entity overrides, 11 inserted sprites);
* source-tree layer (runs only when SINGULARITY_OFFICE_SOURCE points at the pinned Office
  checkout): the applied sources carry every patch, the served backend/static build is
  byte-identical to frontend/out, and validate_websocket_origin() accepts a loopback origin on
  the native port while still rejecting a non-loopback one.

The source-tree layer SKIPS loudly when the environment variable is absent. A skipped gate is
NOT a passed gate; the release report must say NOT TESTED in that case.

Draft, 2026-10-30. Not yet referenced by CI.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PATCH_DIR = ROOT / "office" / "patches"
PATCH = PATCH_DIR / "windows-ghost-only.patch"
BEN_PATCH = PATCH_DIR / "ben-default-layout.patch"
DESKS_PATCH = PATCH_DIR / "desks-unconditional.patch"
WS_PATCH = PATCH_DIR / "ws-loopback-origin.patch"
BOSS_PATCH = PATCH_DIR / "boss-desk-unconditional.patch"
PROVENANCE = ROOT / "office" / "PROVENANCE.md"
BEN_ASSET = ROOT / "office" / "assets" / "ben-layout.json"
BEN_SAVED_ASSET = ROOT / "office" / "assets" / "ben-saved-layouts.json"
EXPECTED_FILES = (
    "frontend/src/systems/persistentIdentities.ts",
    "frontend/src/components/game/OfficeGame.tsx",
    "frontend/src/systems/idleSweep.ts",
)
SEED_RE = re.compile(r"PERSISTENT_SEEDS[^=]*=\s*\[(.*?)\]\s*(?:as\s+const\s*)?;", re.S)
ID_RE = re.compile(r'id:\s*"([^"]+)"')
NAME_RE = re.compile(r'name:\s*"([^"]+)"')
SEED_OBJECT_RE = re.compile(r'name:\s*"Sol (?:Docker|Webserver)"\s*,\s*id:')
# sha256 of the layout bundled in the live claude-office container
# (/app/app/assets/default_layout.json), captured 2026-10-30.
LIVE_LAYOUT_SHA256 = "4fc64eeab169901bd447fff63ac35d28986180d778a50d1252b9b4b671210d99"
LIVE_SAVED_SHA256 = "6cce0cc278547071c75141de3af664cad94b121e12091d265ba158a3eac94005"
EXPECTED_DESK_IDS = tuple(f"desk-{i}" for i in range(1, 11)) + (
    "boss-desk",
    "desk-ghostreporting",
    "desk-sol-webserver",
)
LIVE_LAYOUT_OVERRIDES = 43
LIVE_LAYOUT_INSERTED = 11


def _text(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


def _headers(path: Path) -> list[str]:
    return re.findall(r"^--- a/(.+)$", _text(path), re.M)


def _added(body: str) -> str:
    return "\n".join(
        line for line in body.splitlines() if line.startswith("+") and not line.startswith("+++")
    )


def _removed(body: str) -> str:
    return "\n".join(
        line for line in body.splitlines() if line.startswith("-") and not line.startswith("---")
    )


def _build_id(next_dir: Path) -> str:
    candidates = sorted(p.name for p in next_dir.iterdir() if p.is_dir() and p.name != "static")
    if len(candidates) != 1:
        raise AssertionError(f"{next_dir}: expected exactly one build id directory, got {candidates}")
    return candidates[0]


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class OfficeGhostOnlyPatchRepo(unittest.TestCase):
    def test_patch_exists_and_targets_exactly_the_three_files(self):
        self.assertTrue(PATCH.is_file(), f"missing patch: {PATCH}")
        self.assertEqual(_headers(PATCH), list(EXPECTED_FILES))

    def test_patch_removes_sol_seeds_and_adds_filters(self):
        body = _text(PATCH)
        removed = _removed(body)
        added = _added(body)
        self.assertTrue(any('name: "Sol Docker"' in line for line in removed.splitlines()))
        self.assertTrue(any('name: "Sol Webserver"' in line for line in removed.splitlines()))
        # No seed object may be re-added: the only Sol references left are filters.
        for line in added.splitlines():
            self.assertIsNone(SEED_OBJECT_RE.search(line), f"seed object re-added: {line!r}")
        self.assertIn('agent.id !== "gateway-dockerhost"', added)
        self.assertIn('agent.id !== "gateway-webserver"', added)
        self.assertIn('agent.name !== "Sol Docker"', added)
        self.assertIn('agent.name !== "Sol Webserver"', added)

    def test_provenance_documents_the_patch(self):
        self.assertTrue(PROVENANCE.is_file(), f"missing provenance: {PROVENANCE}")
        body = _text(PROVENANCE)
        self.assertIn("windows-ghost-only.patch", body)
        self.assertIn("95d8bdc5728b23bcf0fee4c371b35e071c44f642", body)


class OfficeBenDefaultLayoutRepo(unittest.TestCase):
    def test_ben_patch_targets_layout_and_startup(self):
        self.assertTrue(BEN_PATCH.is_file(), f"missing patch: {BEN_PATCH}")
        self.assertEqual(
            _headers(BEN_PATCH),
            ["backend/app/api/routes/layout.py", "backend/app/main.py"],
        )

    def test_ben_patch_seeds_only_missing_preferences(self):
        body = _text(BEN_PATCH)
        added = _added(body)
        self.assertIn('BEN_LAYOUT_NAME = "Ben"', added)
        self.assertIn("async def seed_default_layouts", added)
        self.assertIn("UserPreference.key == LAYOUT_KEY", added)
        self.assertIn("UserPreference.key == SAVED_LAYOUTS_KEY", added)
        # Both seeds are guarded by an existence check: never overwrite an operator layout.
        self.assertEqual(added.count("scalar_one_or_none() is None"), 2)
        # Startup must call the seeder.
        self.assertIn("seed_default_layouts", added)

    def test_desks_patch_drops_the_occupancy_draw_gate(self):
        self.assertTrue(DESKS_PATCH.is_file(), f"missing patch: {DESKS_PATCH}")
        self.assertEqual(_headers(DESKS_PATCH), ["frontend/src/components/game/OfficeDesks.tsx"])
        body = _text(DESKS_PATCH)
        self.assertIn("if (!occupied.has(i + 1)) return null;", _removed(body))
        self.assertNotIn("occupied.has(", _added(body))

    def test_boss_desk_patch_removes_the_owner_gate(self):
        self.assertTrue(BOSS_PATCH.is_file(), f"missing patch: {BOSS_PATCH}")
        self.assertEqual(_headers(BOSS_PATCH), ["frontend/src/components/game/OfficeGame.tsx"])
        body = _text(BOSS_PATCH)
        self.assertIn('{presentPinned.has("Sol Docker") && <BossDesk />}', _removed(body))
        self.assertIn("<BossDesk />", _added(body))

    def test_ws_patch_accepts_loopback_any_port_and_keeps_the_allowlist(self):
        self.assertTrue(WS_PATCH.is_file(), f"missing patch: {WS_PATCH}")
        self.assertEqual(_headers(WS_PATCH), ["backend/app/api/websocket.py"])
        body = _text(WS_PATCH)
        added = _added(body)
        self.assertIn("host = urlparse(origin).hostname", added)
        self.assertIn("if host in _LOCALHOST_HOSTS:", added)
        self.assertIn("return True", added)
        # The allowlist path must survive for non-loopback origins.
        self.assertIn("return origin.rstrip", body)

    def test_ben_layout_asset_matches_the_live_deployment(self):
        self.assertTrue(BEN_ASSET.is_file(), f"missing asset: {BEN_ASSET}")
        data = json.loads(BEN_ASSET.read_text(encoding="utf-8"))
        self.assertEqual(_sha256(BEN_ASSET), LIVE_LAYOUT_SHA256)
        self.assertEqual(len(data["overrides"]), LIVE_LAYOUT_OVERRIDES)
        self.assertEqual(len(data["inserted"]), LIVE_LAYOUT_INSERTED)
        saved = json.loads(BEN_SAVED_ASSET.read_text(encoding="utf-8"))
        self.assertEqual(_sha256(BEN_SAVED_ASSET), LIVE_SAVED_SHA256)
        self.assertEqual(len(saved["Ben"]["layout"]["overrides"]), LIVE_LAYOUT_OVERRIDES)
        self.assertEqual(len(saved["Ben"]["layout"]["inserted"]), LIVE_LAYOUT_INSERTED)
        body = _text(PROVENANCE)
        self.assertIn("ben-layout.json", body)
        self.assertIn("ben-saved-layouts.json", body)
        self.assertIn(LIVE_LAYOUT_SHA256, body)
        self.assertIn(LIVE_SAVED_SHA256, body)

    def test_provenance_documents_the_boss_desk_patch(self):
        body = _text(PROVENANCE)
        self.assertIn("boss-desk-unconditional.patch", body)
        self.assertIn("boss-desk", body)

    def test_provenance_documents_the_b5_patches(self):
        body = _text(PROVENANCE)
        for patch in ("ben-default-layout.patch", "desks-unconditional.patch", "ws-loopback-origin.patch"):
            self.assertIn(patch, body)


class OfficeGhostOnlyPatchSourceTree(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        value = os.environ.get("SINGULARITY_OFFICE_SOURCE", "").strip()
        if not value:
            raise unittest.SkipTest(
                "SINGULARITY_OFFICE_SOURCE not set: Office applied-build checks are NOT TESTED"
            )
        cls.office = Path(value).resolve()
        if not (cls.office / "frontend").is_dir():
            raise AssertionError(f"SINGULARITY_OFFICE_SOURCE has no frontend/: {cls.office}")

    def _assert_only_ghost(self, relative: str) -> None:
        body = _text(self.office / relative)
        match = SEED_RE.search(body)
        self.assertIsNotNone(match, f"PERSISTENT_SEEDS not found in {relative}")
        block = match.group(1)
        self.assertEqual(ID_RE.findall(block), ["ai-companion"], f"{relative}: seeds must be Ghost only")
        self.assertEqual(NAME_RE.findall(block), ["Ghost Protocol"], f"{relative}: seeds must be Ghost only")
        self.assertNotIn("gateway-dockerhost", block)
        self.assertNotIn("gateway-webserver", block)

    def test_persistent_identities_seeds_are_ghost_only(self):
        self._assert_only_ghost("frontend/src/systems/persistentIdentities.ts")

    def test_office_game_seeds_are_ghost_only(self):
        self._assert_only_ghost("frontend/src/components/game/OfficeGame.tsx")

    def test_idle_sweep_never_keeps_gateway_sessions(self):
        body = _text(self.office / "frontend/src/systems/idleSweep.ts")
        self.assertNotIn('"Sol Docker",', body)
        self.assertNotIn('"Sol Webserver",', body)
        self.assertIn('agent.id === "gateway-dockerhost"', body)
        self.assertIn('agent.id === "gateway-webserver"', body)

    def test_ben_layout_is_seeded_and_active_on_first_boot(self):
        layout = _text(self.office / "backend/app/api/routes/layout.py")
        main = _text(self.office / "backend/app/main.py")
        self.assertIn('BEN_LAYOUT_NAME = "Ben"', layout)
        self.assertIn("async def seed_default_layouts", layout)
        self.assertEqual(layout.count("scalar_one_or_none() is None"), 2)
        self.assertIn("seed_default_layouts", main)
        self.assertIn("from app.api.routes.layout import seed_default_layouts", main)

    def test_ben_layout_asset_matches_the_live_deployment(self):
        asset = self.office / "backend/app/assets/default_layout.json"
        self.assertTrue(asset.is_file(), f"missing source layout: {asset}")
        data = json.loads(asset.read_text(encoding="utf-8"))
        self.assertEqual(_sha256(asset), LIVE_LAYOUT_SHA256)
        self.assertEqual(len(data["overrides"]), LIVE_LAYOUT_OVERRIDES)

    def test_desks_render_without_an_occupancy_gate(self):
        body = _text(self.office / "frontend/src/components/game/OfficeDesks.tsx")
        self.assertNotIn("if (!occupied.has(i + 1))", body)
        self.assertIn("seats.map((seat, i)", body)

    def test_pinned_desks_render_without_an_owner(self):
        # B6: desks are furniture. The pinned (Sol Webserver / Ghost) desks must
        # render even when their owner identity is absent; identity stays Ghost-only.
        body = _text(self.office / "frontend/src/components/game/OfficeDesks.tsx")
        self.assertIn("export function SolDesks", body)
        self.assertNotIn("present.has(PINNED_DESK_OWNERS", body)

    def test_boss_desk_renders_without_sol_docker(self):
        # B8 (operator): the desk by the printer is boss-desk, not a Sol desk.
        # It used to disappear in a Ghost-only roster because it was gated on
        # Sol Docker being present. Desks are furniture and render regardless.
        body = _text(self.office / "frontend/src/components/game/OfficeGame.tsx")
        self.assertNotIn('presentPinned.has("Sol Docker") && <BossDesk />', body)
        self.assertIn("<BossDesk />", body)

    def test_rendered_desk_id_set_matches_the_live_floor(self):
        body = _text(self.office / "frontend/src/components/game/OfficeDesks.tsx")
        # Pool desks are built dynamically (desk-<n>), the pinned ones are literals.
        self.assertIn("desk-${", body)
        for desk_id in ("boss-desk", "desk-ghostreporting", "desk-sol-webserver"):
            self.assertIn(f'"{desk_id}"', body, f"{desk_id} missing from OfficeDesks")
        layout = json.loads((self.office / "backend/app/assets/default_layout.json").read_text(encoding="utf-8"))
        self.assertTrue(set(EXPECTED_DESK_IDS) <= set(layout["overrides"]),
                        "the live Ben layout must override every rendered desk id")

    def test_ws_origin_loopback_accepted_non_loopback_rejected(self):
        backend = str(self.office / "backend")
        if backend not in sys.path:
            sys.path.insert(0, backend)
        try:
            from app.api.websocket import validate_websocket_origin
        except Exception as exc:  # pragma: no cover - environment dependent
            raise unittest.SkipTest(f"cannot import app.api.websocket ({exc!r}): WS origin check NOT TESTED")

        class _WS:
            def __init__(self, origin=None, api_key=""):
                self.headers = {}
                if origin is not None:
                    self.headers["origin"] = origin
                self.headers["x-api-key"] = api_key

        self.assertTrue(validate_websocket_origin(_WS("http://127.0.0.1:18128")))
        self.assertTrue(validate_websocket_origin(_WS("http://localhost:18128")))
        self.assertTrue(validate_websocket_origin(_WS("http://[::1]:18128")))
        self.assertFalse(validate_websocket_origin(_WS("http://evil.example.com")))
        self.assertFalse(validate_websocket_origin(_WS("http://192.0.2.10:18128")))
        self.assertFalse(validate_websocket_origin(_WS(None, "")))

    def test_served_static_matches_frontend_out(self):
        out = self.office / "frontend" / "out"
        static = self.office / "backend" / "static"
        self.assertTrue((out / "index.html").is_file(), "frontend/out is not built")
        self.assertTrue((static / "index.html").is_file(), "backend/static is missing")
        self.assertEqual(_build_id(out / "_next"), _build_id(static / "_next"),
                         "backend/static serves a different Next.js build than frontend/out")
        self.assertEqual(_sha256(out / "index.html"), _sha256(static / "index.html"),
                         "backend/static/index.html differs from frontend/out/index.html")


if __name__ == "__main__":
    unittest.main()
