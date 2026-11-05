import json, os, shutil, subprocess, tempfile, unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "manage_dashboard_shortcut.ps1"
LAUNCHER = HERE / "open_dashboard.ps1"
ICON = HERE / "assets" / "singularity-dashboard.ico"


class ShortcutStaticContract(unittest.TestCase):
    def test_icon_is_multi_size_ico(self):
        data = ICON.read_bytes()
        self.assertEqual(data[:4], b"\x00\x00\x01\x00")
        self.assertGreaterEqual(int.from_bytes(data[4:6], "little"), 4)

    def test_script_contract(self):
        text = SCRIPT.read_text(encoding="utf-8")
        for needle in ("SHORTCUT_FOREIGN_FILE_REFUSED", "managed-by=singularity-dashboard-shortcut",
                       "127.0.0.1", "IconLocation", "'Create','Status','Remove'", "open_dashboard.ps1"):
            self.assertIn(needle, text)
        for forbidden in ("RunAs", "Set-ExecutionPolicy", "Invoke-WebRequest", "HKLM"):
            self.assertNotIn(forbidden, text)

    def test_launcher_never_prints_the_key(self):
        text = LAUNCHER.read_text(encoding="utf-8")
        self.assertIn("Start-Process", text)
        for forbidden in ("Write-Host", "Write-Output", "Write-Verbose", "Write-Debug", "Out-File", "Add-Content", "Set-Content", "Tee-Object"):
            self.assertNotIn(forbidden, text)


@unittest.skipUnless(os.name == "nt" and shutil.which("powershell.exe"), "Windows PowerShell required")
class ShortcutBehaviour(unittest.TestCase):
    def run_ps(self, args):
        r = subprocess.run(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", *args],
                           capture_output=True, text=True)
        return r.returncode, r.stdout.strip(), r.stderr

    def mode(self, mode, desk, assets, extra=()):
        return self.run_ps([str(SCRIPT), "-Mode", mode, "-DesktopPath", desk, "-AssetRoot", assets, *extra])

    def test_create_idempotent_status_remove_and_foreign_refusal(self):
        with tempfile.TemporaryDirectory() as t:
            desk, assets = os.path.join(t, "desk"), os.path.join(t, "assets")
            os.makedirs(desk)
            link = Path(desk) / "Singularity Dashboard.lnk"
            for _ in range(2):
                rc, out, _ = self.mode("Create", desk, assets, ("-DashboardPort", "18222"))
                self.assertEqual(rc, 0)
                self.assertTrue(json.loads(out)["created"])
            self.assertTrue(link.exists())
            self.assertTrue((Path(assets) / "singularity-dashboard.ico").exists())
            self.assertTrue((Path(assets) / "open_dashboard.ps1").exists())
            st = json.loads(self.mode("Status", desk, assets)[1])
            self.assertTrue(st["owned"])
            self.assertEqual(st["url"], "http://127.0.0.1:18222/")
            self.assertEqual(self.mode("Remove", desk, assets)[0], 0)
            self.assertFalse(link.exists())
            self.assertFalse((Path(assets) / "open_dashboard.ps1").exists())
            link.write_bytes(b"not ours")
            self.assertNotEqual(self.mode("Create", desk, assets)[0], 0)
            self.assertNotEqual(self.mode("Remove", desk, assets)[0], 0)
            self.assertEqual(link.read_bytes(), b"not ours")

    def test_launcher_opens_local_signin_without_exposing_key(self):
        # Stub Start-Process so no browser opens; capture the target it would open.
        with tempfile.TemporaryDirectory() as t:
            state = os.path.join(t, "state"); os.makedirs(state)
            Path(state, "token").write_text("A" * 40 + "\n")
            probe = os.path.join(t, "probe.ps1")
            Path(probe).write_text(
                "function Start-Process { param($FilePath) [IO.File]::WriteAllText('%s', $FilePath) }\n"
                "& '%s' -DashboardPort 18333 -StateDir '%s'\n" % (os.path.join(t, "out.txt"), LAUNCHER, state))
            rc, out, err = self.run_ps([probe])
            self.assertEqual(rc, 0, err)
            self.assertEqual(out, "")
            self.assertEqual(Path(t, "out.txt").read_text(), "http://127.0.0.1:18333/")
            os.remove(os.path.join(state, "token"))
            self.run_ps([probe])
            self.assertEqual(Path(t, "out.txt").read_text(), "http://127.0.0.1:18333/")


if __name__ == "__main__":
    unittest.main()
