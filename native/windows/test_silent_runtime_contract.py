"""Offline source checks; Windows Task Scheduler and GUI capture need native acceptance."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class SilentRuntimeContract(unittest.TestCase):
    def test_pythonw_host_executes_and_logs_without_shell(self):
        with tempfile.TemporaryDirectory() as d:
            base=Path(d)
            target=base/'child.py'; target.write_text('print("READY")\n')
            log=base/'host.log'
            host=ROOT/'native/windows/silent_python_host.py'
            result=subprocess.run([sys.executable,str(host),'--log',str(log),'--',str(target)],
                                  capture_output=True,text=True,timeout=10)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertIn('READY',log.read_text())
            self.assertEqual(result.stdout,'')

    def test_windowless_registers_real_native_owned_actions(self):
        files = {
            'dashboard':('native/windows/manage_claude_complete_dashboard.ps1', 'New-ScheduledTaskAction -Execute $pythonw', 'silent_python_host.py'),
            'office':('native/windows/manage_claude_office.ps1', 'New-ScheduledTaskAction -Execute $venvPythonw', 'Scripts\\pythonw.exe'),
            'gateway':('native/windows/manage_unified_gateway.ps1', 'New-ScheduledTaskAction -Execute $binary', '--config'),
            'supervisor':('native/windows/register-supervisor-task.ps1', 'New-ScheduledTaskAction -Execute $runtimeExe', 'singularity-windows-supervisorw.exe'),
        }
        for service,(name,action,marker) in files.items():
            with self.subTest(service=service):
                s=(ROOT/name).read_text()
                self.assertIn(action,s)
                self.assertIn(marker,s)
                self.assertIn('-RestartCount 3',s)
                self.assertIn('-RestartInterval (New-TimeSpan -Minutes 1)',s)

    def test_gui_binaries_and_shortcut_never_launch_console_shell(self):
        for name in ('native/windows/unified-gateway-rust/src/main.rs',
                     'native/windows/unified-gateway-rust/src/bin/singularity_dashboard_open.rs',
                     'native/windows/rust-supervisor/src/bin/singularity_windows_supervisorw.rs'):
            self.assertIn('windows_subsystem = "windows"',(ROOT/name).read_text())
        shortcut=(ROOT/'native/windows/manage_dashboard_shortcut.ps1').read_text()
        self.assertIn('$l.TargetPath=$opener',shortcut)
        self.assertNotIn('powershell.exe',shortcut.lower())
        gateway=(ROOT/'native/windows/manage_unified_gateway.ps1').read_text()
        self.assertNotIn('New-ScheduledTaskAction -Execute $ps',gateway)
        self.assertIn('LEGACY_GATEWAY_TASK_REQUIRES_SCOPED_REPLACEMENT',gateway)

    def test_extra_dashboard_children_no_console(self):
        for name in ('dashboard/native_cpu.py','dashboard/repoql_native_auth.py',
                     'dashboard/harness_telemetry.py','dashboard/freebuff_allowance.py',
                     'dashboard/unified_bridge.py','dashboard/repoql_bridge.py'):
            with self.subTest(file=name):
                self.assertIn('creationflags=getattr(subprocess,', (ROOT/name).read_text())

    def test_retired_scheduler_is_not_needed_for_windowless_checks(self):
        for name in ('ghost_task_scheduler.ps1', 'ghost_scheduler_host.py', 'manage_ghost_scheduler.ps1'):
            self.assertFalse((ROOT / 'native/windows' / name).exists())


if __name__=='__main__': unittest.main()
