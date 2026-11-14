"""Fail-closed scheduler source contract; does not run PowerShell on Windows."""
import pathlib
import unittest

P = pathlib.Path(__file__).with_name("register-supervisor-task.ps1")

class SchedulerSourceContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.code = P.read_text(encoding="utf-8")

    def test_no_suppressed_scheduler_query(self):
        self.assertNotIn("-ErrorAction SilentlyContinue", self.code)
        self.assertIn("Get-ScheduledTask -ErrorAction Stop", self.code)
        self.assertIn("SUPERVISOR_SCHEDULER_UNAVAILABLE_REFUSE_MUTATION", self.code)

    def test_existing_task_strict_ownership(self):
        for part in ["$actions.Count -eq 1", "$triggers.Count -eq 1",
                     "MSFT_TaskLogonTrigger", "Principal.RunLevel -eq 'Limited'",
                     "Settings.Enabled -eq $true", "AMBIGUOUS_SUPERVISOR_TASK_REFUSED"]:
            self.assertIn(part, self.code)

    def test_unregister_requires_fresh_scheduler_readback(self):
        self.assertIn("TASK_UNREGISTER_VERIFICATION_UNAVAILABLE", self.code)
        self.assertIn("TASK_UNREGISTER_NOT_VERIFIED", self.code)
        self.assertIn("Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop", self.code)

    def test_register_checks_full_postcondition(self):
        self.assertIn("Register-ScheduledTask -TaskName $taskName", self.code)
        self.assertIn("TASK_REGISTRATION_NOT_VERIFIED", self.code)
        self.assertIn("$afterTriggers.Count -ne 1", self.code)

if __name__ == "__main__": unittest.main()
