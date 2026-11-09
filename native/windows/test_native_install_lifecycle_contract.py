"""Static lifecycle contracts for the Codex-operated native Windows manager.

These checks inspect the installer path without registering or starting tasks.
Live Task Scheduler acceptance is a separate receipt.
"""
import base64
import hashlib
import json
import os
import tempfile
from pathlib import Path
import shutil
import subprocess
import unittest


HERE = Path(__file__).resolve().parent
POWERSHELL = shutil.which("powershell.exe")
SOURCE_POWERSHELL = shutil.which("pwsh") or POWERSHELL
BEHAVIOUR = HERE / "test_native_install_lifecycle_behaviour.ps1"
MANAGER = (HERE / "manage_native_windows.ps1").read_text(encoding="utf-8")
STAGE = (HERE / "stage-native.ps1").read_text(encoding="utf-8")
GHOST = (HERE / "manage_ghost_scheduler.ps1").read_text(encoding="utf-8")
DASHBOARD = (HERE / "manage_claude_complete_dashboard.ps1").read_text(encoding="utf-8")
GHOST_TASK_ADAPTER = (HERE / "ghost_task_scheduler.ps1").read_text(encoding="utf-8")
DASHBOARD_HOST = (HERE / "claude_complete_dashboard_host.py").read_text(encoding="utf-8")
GHOST_HOST = (HERE / "ghost_scheduler_host.py").read_text(encoding="utf-8")
VERIFY = (HERE / "verify_after_reboot.ps1").read_text(encoding="utf-8")
OFFICE = (HERE / "manage_claude_office.ps1").read_text(encoding="utf-8")
OFFICE_BEHAVIOUR = HERE / "test_office_restage_behaviour.ps1"


def section(source: str, start: str, end: str) -> str:
    begin = source.index(start)
    finish = source.index(end, begin + len(start))
    return source[begin:finish]


class NativeInstallLifecycleContracts(unittest.TestCase):
    def test_single_complete_variant_entry_keeps_local_gui_optional(self):
        params = section(MANAGER, "param(", ")\nSet-StrictMode")
        self.assertNotIn("$Option", params)
        self.assertIn("$Option=2", MANAGER)
        self.assertIn("$hasGhost=$false", MANAGER)
        self.assertIn("if (-not $hasGhost -and ((Get-Task $taskGhost) -or (Test-GhostOwnershipArtifacts))) { throw 'NATIVE_LEGACY_GHOST_REMOVAL_UNVERIFIED' }", MANAGER)
        self.assertNotIn("SINGULARITY_GHOST_CONTROL_CONFIG", DASHBOARD_HOST)
        self.assertNotIn("SINGULARITY_NATIVE_BRIDGE_EXE", DASHBOARD_HOST)
        self.assertIn("  if ((Get-Task $taskGhost)) { throw 'NATIVE_EXISTING_TASK_REQUIRES_OWNERSHIP_REVIEW' }", MANAGER)
        self.assertIn("  if ((Test-GhostOwnershipArtifacts)) { throw 'NATIVE_EXISTING_RECEIPT_REQUIRES_OWNERSHIP_REVIEW' }", MANAGER)
        self.assertIn("if ($hasGhost) {", MANAGER)
        self.assertIn("if ($GuiExe) { $script:GuiExe=Assert-LocalPath", MANAGER)
        self.assertIn("claudeRequired=$false", MANAGER)
        self.assertIn("guiIntegrationInstalled=$false", MANAGER)
        self.assertIn("DASHBOARD_REPOQL_VERSION_OR_CONTRACT_REFUSED", DASHBOARD)
        self.assertIn("--variant '+$Variant", DASHBOARD)

    def test_install_registers_without_start_and_lifecycle_requires_apply(self):
        self.assertIn("$mutating=$Mode -in @('Install','Start','Stop','Uninstall','Reinstall','RefreshSource','RollbackSource')", MANAGER)
        self.assertIn("$sourceRefreshMode=$Mode -in @('RefreshSource','RollbackSource')", MANAGER)
        self.assertIn("$connectorMutating=$ConnectorAction -in @('build','install')", MANAGER)
        self.assertIn("if (($mutating -or ($MemoryAction -and -not $memoryReadOnly) -or $connectorMutating) -and -not $Apply -and -not $sourceRefreshMode)", MANAGER)
        self.assertIn("if (-not $mutating -and -not $MemoryAction -and -not $ConnectorAction -and $Apply) { throw 'NATIVE_LIFECYCLE_READ_ONLY_REFUSES_APPLY' }", MANAGER)
        register = section(MANAGER, "function Register-Components", "function Get-SupervisorTask")
        self.assertNotIn("Start-ScheduledTask", register)
        self.assertIn("servicesStarted=$false", MANAGER)

    def test_source_refresh_modes_are_source_only_and_fail_closed(self):
        refresh = section(MANAGER, "function Invoke-SourceRefreshTransaction", "function Remove-VerifiedSourceTree")
        rollback = section(MANAGER, "function Invoke-SourceRollbackTransaction", "function Remove-VerifiedStage")
        consumers = section(MANAGER, "function Assert-SourceConsumersStopped", "function Read-SourceRefreshSnapshot")
        snapshot = section(MANAGER, "function Read-SourceRefreshSnapshot", "function Invoke-SourceRefreshTransaction")
        self.assertIn("'RefreshSource','RollbackSource'", MANAGER)
        self.assertIn("PrepareSource=$true", MANAGER)
        self.assertIn("Get-SourceTree $SourceRoot $selected", MANAGER)
        self.assertIn("NATIVE_SOURCE_CANDIDATE_DRIFT_REFUSED", MANAGER)
        self.assertIn("NATIVE_SOURCE_SNAPSHOT_EXISTS", MANAGER)
        self.assertIn("Assert-ExactFileInventory", MANAGER)
        self.assertIn("NATIVE_SOURCE_UNOWNED_FILE_REFUSED", MANAGER)
        self.assertIn("Assert-SourceConsumersStopped", refresh)
        self.assertIn("Assert-SourceConsumersStopped", rollback)
        self.assertIn("Get-CimInstance -ClassName Win32_Process -ErrorAction Stop", consumers)
        self.assertIn("NATIVE_SOURCE_CONSUMER_STATE_UNKNOWN", consumers)
        self.assertIn("NATIVE_SOURCE_CONSUMER_RUNNING", consumers)
        self.assertIn("$pathHit=($command -and $command.IndexOf($sourceNeedle", consumers)
        self.assertIn("if (-not $command) { throw 'NATIVE_SOURCE_CONSUMER_STATE_UNKNOWN' }", consumers)
        self.assertIn("Assert-ReceiptNonSourceFieldsEqual", refresh)
        self.assertIn("Assert-ReceiptNonSourceFieldsEqual", snapshot)
        self.assertIn("[IO.File]::Replace($temp,$Path,$backup)", MANAGER)
        self.assertIn("STAGING_RECEIPT.preimage.json", MANAGER)
        self.assertIn("INSTALLATION_RECEIPT.preimage.json", MANAGER)
        self.assertIn("NATIVE_SOURCE_REFRESH_FAILED_RECOVERED", MANAGER)
        self.assertIn("NATIVE_SOURCE_ROLLBACK_FAILED_RECOVERED", MANAGER)
        for forbidden in ("Start-ScheduledTask", "Stop-ScheduledTask", "Register-ScheduledTask", "Unregister-ScheduledTask"):
            self.assertNotIn(forbidden, refresh + rollback)
        self.assertNotIn("Remove-Item -Recurse", refresh + rollback)

    def test_source_only_staging_does_not_take_binary_inputs_or_change_the_current_stage(self):
        prepare = section(STAGE, "if ($PrepareSource) {", "Assert-LocalExistingFile $BridgeExe")
        self.assertIn("SOURCE_PREPARATION_BINARY_INPUTS_REFUSED", STAGE)
        self.assertIn("SOURCE_PREPARATION_CANDIDATE_EXISTS", prepare)
        self.assertIn("SOURCE_UNMANIFESTED_FILE_REFUSED", STAGE)
        self.assertIn("Set-PrivateDirectoryAcl $sourceCandidate", prepare)
        self.assertIn("binariesTouched=$false", prepare)
        self.assertNotIn("$current", prepare)
        self.assertNotIn("Move-Item", prepare)

    def test_uninstall_and_reinstall_remove_only_verified_owned_tasks(self):
        remove = section(MANAGER, "function Remove-Components", "function Emit-Result")
        self.assertIn("Invoke-Dashboard 'Remove' $true", remove)
        self.assertIn("Invoke-Ghost 'Remove' $true", remove)
        self.assertIn("$childArgs=@{SupervisorExe=$supervisorPath;ConfigPath=[string]$Receipt.supervisorConfig;Remove=$true;Apply=$true", remove)
        self.assertIn("NATIVE_SUPERVISOR_REMOVAL_UNVERIFIED", remove)
        self.assertIn("NATIVE_DASHBOARD_REMOVAL_UNVERIFIED", remove)
        self.assertIn("NATIVE_GHOST_REMOVAL_UNVERIFIED", remove)
        self.assertIn("Stop-Components $receipt\n    Remove-Components $receipt\n    if ((Get-Task $taskGhost) -or (Test-GhostOwnershipArtifacts)) { throw 'NATIVE_LEGACY_GHOST_REMOVAL_UNVERIFIED' }", MANAGER)
        self.assertIn("if ($Mode -eq 'Uninstall') {\n  if (-not $PSCmdlet.ShouldProcess", MANAGER)
        uninstall = MANAGER[MANAGER.index("if ($Mode -eq 'Uninstall') {"):]
        guard = "NATIVE_LEGACY_GHOST_REMOVAL_UNVERIFIED"
        first_guard = uninstall.index(guard)
        self.assertLess(first_guard, uninstall.index("Stop-Components $receipt"))
        second_guard = uninstall.index(guard, first_guard + 1)
        self.assertLess(uninstall.index("Remove-Components $receipt"), second_guard)
        self.assertLess(second_guard, uninstall.index("Remove-VerifiedStage $current"))
        self.assertLess(uninstall.index("Remove-VerifiedStage $current"),
                        uninstall.index("Remove-Item -LiteralPath $installReceiptPath"))
        self.assertIn("legacyGhostResidue=[bool]((Get-Task $taskGhost) -or (Test-GhostOwnershipArtifacts))", MANAGER)
        self.assertIn("userDataPreserved=$true;externalGuiSettingsModified=$false", MANAGER)

    def test_ghost_host_registers_before_dashboard_and_supplies_private_client_config(self):
        register = section(MANAGER, "function Register-Components", "function Get-SupervisorTask")
        self.assertLess(register.index("Invoke-Ghost 'Register'"), register.index("Invoke-Dashboard 'Register'"))
        invoke = section(MANAGER, "function Invoke-Dashboard", "function Invoke-Ghost")
        # Ghost is removed from the Windows release: the dashboard registration must not carry Ghost paths.
        self.assertNotIn("NativeBridgeExe", invoke)
        self.assertNotIn("GhostControlConfig", invoke)
        self.assertIn("native-bridge-client.json", GHOST)
        self.assertIn("clientConfigSha256=$clientConfigHash", GHOST)
        self.assertIn("Set-PrivateFileAcl $clientConfigPendingPath", GHOST)
        self.assertIn("Assert-ClientConfig $config", GHOST)
        self.assertIn("clientConfigSha256", GHOST)
        self.assertIn("do not inspect paths or load Ghost config", (HERE / "claude_complete_dashboard_host.py").read_text(encoding="utf-8"))
        self.assertIn("--log \"'+(Join-Path $state 'dashboard-runtime.log')+'\" -- \"'+$entry", DASHBOARD)
        self.assertIn("-- \"' + $script + '\" --config", GHOST_TASK_ADAPTER)
        self.assertIn("sys.dont_write_bytecode = True", DASHBOARD_HOST)
        self.assertIn("sys.dont_write_bytecode = True", GHOST_HOST)
        self.assertIn("PYTHONDONTWRITEBYTECODE", DASHBOARD_HOST)
        self.assertIn('PYTHONDONTWRITEBYTECODE', GHOST_HOST)

    def test_partial_cleanup_allows_absent_supervisor_but_verifies_a_present_task(self):
        stop = section(MANAGER, "function Stop-Components", "function Remove-Components")
        self.assertIn("$supervisorTaskNow=Get-Task $taskSupervisor", stop)
        self.assertIn("if ($supervisorTaskNow) { $s=Get-SupervisorStatus", stop)
        self.assertIn("if ($s.registeredOwnedAndConfigured -ne $true)", stop)
        self.assertIn("NATIVE_SUPERVISOR_TASK_STOP_READBACK_FAILED", stop)

    def test_stage_inventory_is_hash_exact_and_deletion_is_manifest_owned(self):
        read_stage = section(MANAGER, "function Read-Stage", "function Remove-VerifiedStage")
        self.assertIn("Get-FileSha256", read_stage)
        self.assertIn("Compare-Object", read_stage)
        self.assertIn("NATIVE_STAGE_UNOWNED_FILE_REFUSED", read_stage)
        remove_stage = section(MANAGER, "function Remove-VerifiedStage", "function Get-Task")
        self.assertIn("foreach ($file in $stage.files)", remove_stage)
        self.assertIn("NATIVE_STAGE_DIRECTORY_NOT_EMPTY", remove_stage)
        self.assertNotIn("Remove-Item -Recurse", remove_stage)
        self.assertNotIn("Remove-Item -LiteralPath $installRoot", MANAGER)

    def test_partial_receipts_are_explicit_and_secrets_never_enter_status(self):
        self.assertIn("'installing','installed_not_started','reinstalling','partial'", MANAGER)
        self.assertIn("NATIVE_INSTALL_PARTIAL", MANAGER)
        self.assertIn("GHOST_PARTIAL_REGISTRATION_REFUSED", GHOST)
        self.assertIn("configContainsControlKey=$false;secretsPrinted=$false", GHOST)
        emit = section(GHOST, "function Emit-Status", "$existing=@(Get-TaskCandidates)")
        self.assertNotIn("$Readback.controlKey", emit)
        self.assertNotIn("$config.controlKey", emit)

    def test_ghost_files_are_owned_by_complete_only_lifecycle(self):
        self.assertIn("$hasGhost -and -not (Test-Path -LiteralPath $ghostManager", MANAGER)
        self.assertIn("if ($hasGhost) {\n    $null=Invoke-Ghost 'Plan' $false", MANAGER)
        self.assertIn("runnerArguments=@();", GHOST)
        self.assertIn("--log \"'+(Join-Path $privateRoot 'ghost-runtime.log')+'\" -- \"'+$HostScript+'\" --config \"'+$configPath+'\"'", GHOST)
        self.assertIn("$configPath", GHOST)

    def test_memory_and_supervisor_configs_are_generated_from_the_staged_install(self):
        memory = section(MANAGER, "function Get-MemoryNode", "function Test-SupervisorConfig")
        self.assertIn("throw 'NATIVE_MEMORY_CONFIG_BUILDER_MISSING'", memory)
        self.assertIn("'--root',$memoryRoot,'--output',$memoryConfig,'--node',$node", memory)
        self.assertIn("NATIVE_MEMORY_CONFIG_GENERATION_FAILED", memory)
        self.assertIn("Join-Path $current 'source/scripts/native-memory-supervisor.mjs'", memory)
        self.assertIn("NATIVE_MEMORY_SUPERVISOR_MISSING", memory)
        self.assertIn("$lines=@(& $node $supervisor $Verb --config $memoryConfig --json", memory)
        self.assertIn("throw 'NATIVE_SUPERVISOR_CONFIG_BUILDER_MISSING'", memory)
        self.assertIn("'--install-root',$installRoot,'--source-root',(Join-Path $current 'source')", memory)
        self.assertIn("'--root',$memoryRoot,'--output',$memoryConfig", memory)
        self.assertIn("'--memory-build-root',$memoryBuildRoot,'--memory-stack-config',$memoryConfig", memory)
        self.assertIn("NATIVE_SUPERVISOR_CONFIG_GENERATION_FAILED", memory)
        self.assertIn("Set-PrivateDirectoryAcl $dashboardState", memory)
        self.assertIn("elseif (Test-Path -LiteralPath (Join-Path $memoryBuildRoot 'MemoryCore') -PathType Container)", memory)
        self.assertIn("$builderArgs += @('--node',(Get-MemoryNode))", memory)
        self.assertIn("$script:SupervisorConfig=Test-SupervisorConfig $SupervisorConfig", memory)
        register = section(MANAGER, "function Register-Components", "function Get-SupervisorTask")
        self.assertIn("if (-not $SupervisorConfig) { New-GeneratedSupervisorConfig }", register)
        self.assertIn("supervisorConfigWillGenerate=(-not [bool]$SupervisorConfig)", MANAGER)
        self.assertIn("$memoryReadOnly=$MemoryAction -in @('status','verify')", MANAGER)
        self.assertIn("schema='singularity-native-memory-lifecycle/v1'", MANAGER)
        self.assertIn("[switch]$SkipOffice", MANAGER)
        self.assertIn("$hasOffice=-not $SkipOffice", MANAGER)
        self.assertIn("'--skip-office'", MANAGER)
        self.assertIn("officeWillRegister=$hasOffice", MANAGER)
        self.assertIn("if ($hasOffice -and ((Test-Path -LiteralPath $officeRoot)", MANAGER)
        self.assertIn("$ownedRootNames=@('memory')", MANAGER)
        self.assertIn("if (-not $hasOffice) { $ownedRootNames += 'office' }", MANAGER)

    def test_ghost_draft_root_sid_and_partial_cleanup_are_fail_closed(self):
        self.assertIn("function Test-DashboardStatePath", GHOST)
        self.assertIn("$fullPath.Equals($fullRoot", GHOST)
        self.assertIn("Test-DashboardStatePath $DraftStateDirectory $dashboardRoot", GHOST)
        self.assertIn("function Convert-PrincipalSid([string]$PrincipalValue)", GHOST)
        self.assertIn("[Security.Principal.NTAccount]::new($PrincipalValue)).Translate(", GHOST)
        self.assertIn("$principalSid -cne $ownerSid", GHOST)
        self.assertIn("$partialCleanupAllowed=$Mode -in @('Stop','Uninstall')", MANAGER)
        self.assertIn("if ($ghostTaskNow) {", MANAGER)
        self.assertIn("NATIVE_GHOST_SCHEDULES_REMAIN_REFUSE_STOP", MANAGER)
        self.assertIn("NATIVE_GHOST_TASK_NOT_OWNED", MANAGER)
        self.assertIn("Invoke-Dashboard 'Remove' $true $true", MANAGER)
        self.assertIn("Test-GhostOwnershipArtifacts", MANAGER)
        self.assertIn("$receipt.arguments -notmatch '^(-B", GHOST)
        self.assertIn("function Test-GhostOwnershipArtifacts", MANAGER)

    def test_post_reboot_verifier_is_read_only_and_covers_owned_stack(self):
        self.assertIn("param(\n  [string]$InstallRoot", VERIFY)
        self.assertIn("[switch]$Json", VERIFY)
        self.assertIn("Singularity-Rust-Native-Supervisor", VERIFY)
        self.assertIn("Singularity-ClaudeComplete-Dashboard", VERIFY)
        self.assertNotIn("Singularity-Ghost-Scheduler", VERIFY)
        self.assertNotIn("18473", VERIFY)
        self.assertIn("Singularity-ClaudeComplete-Office", VERIFY)
        for port in ("18100", "18128"):
            self.assertIn(port, VERIFY)
        self.assertIn("http:18128", VERIFY)
        self.assertIn("memoryConfigPath", VERIFY)
        self.assertIn("Test-LoopbackPort $component.port", VERIFY)
        self.assertIn("memory:l0-readback", VERIFY)
        self.assertIn("1\\.7\\.18", VERIFY)
        self.assertIn("repoql@repoql-plugins", VERIFY)
        self.assertIn("post-reboot-", VERIFY)
        self.assertNotIn("Start-ScheduledTask", VERIFY)
        self.assertNotIn("Stop-ScheduledTask", VERIFY)
        self.assertNotIn("Register-ScheduledTask", VERIFY)
        self.assertNotIn("Remove-Item", VERIFY)
        self.assertNotIn("18129", VERIFY)


class OfficeRestageContracts(unittest.TestCase):
    """Restage is a bounded restage, never a start and never a weakened start."""

    def restage(self) -> str:
        return section(OFFICE, "function Invoke-OfficeRestage", "function Invoke-Result")

    def test_restage_mode_requires_explicit_apply_and_should_process(self):
        params = section(OFFICE, "param(", ")\nSet-StrictMode")
        self.assertIn("'Restage'", params)
        self.assertIn("$mutating = $Mode -in @('Install','Restage','Start','Stop','Uninstall')", OFFICE)
        self.assertIn("if ($Mode -eq 'Restage') {", OFFICE)
        self.assertIn("$PSCmdlet.ShouldProcess($root, \"Restage Office source from $OfficeSource\")", OFFICE)
        self.assertIn("OFFICE_RESTAGE_NOT_CONFIRMED", OFFICE)

    def test_restage_requires_owned_stopped_task_and_verified_closed_port(self):
        block = self.restage()
        self.assertIn("Assert-ReceiptIntegrity $Receipt", block)
        self.assertIn("$task = Get-OfficeTask", block)
        self.assertIn("Assert-TaskOwned $task $Receipt", block)
        self.assertIn("Assert-OfficeStopped $task", block)
        self.assertIn("[string]$Task.State -notin @('Ready','Disabled')", OFFICE)
        port = section(OFFICE, "function Assert-PortClosed", "function Wait-PortFree")
        self.assertIn("ConnectAsync('127.0.0.1'", port)
        self.assertIn("ConnectionRefused", port)
        self.assertIn("OFFICE_PORT_IN_USE_REFUSED", port)
        self.assertIn("OFFICE_PORT_STATE_UNKNOWN_REFUSE", port)
        self.assertNotIn("Get-NetTCPConnection", port)

    def test_restage_rejects_nested_paths_and_reparse_chains(self):
        block = self.restage()
        self.assertIn("$null = Assert-NoReparseChain $source", block)
        self.assertIn("$null = Assert-NoReparseChain $root", block)
        self.assertIn("$null = Assert-NoReparseChain $sourceDir", block)
        self.assertIn("$null = Assert-NoReparseChain $manifestPath", block)
        self.assertIn("$null = Assert-NoReparseChain $receiptPath", block)
        self.assertIn("$null = Assert-NoReparseChain $txRoot", block)
        self.assertIn("$null = Assert-NoReparseChain $layout", block)
        self.assertIn("Assert-DisjointPaths $source $root", block)
        self.assertIn("Assert-DisjointPaths $source $sourceDir", block)
        self.assertIn("$null = Assert-NoReparseUnder $sourceDir", block)
        self.assertIn("$null = Assert-NoReparseUnder $stagedSource", block)
        self.assertIn("if ($full -notmatch '^[A-Za-z]:\\\\') { throw $Code }", OFFICE)

    def test_restage_reuses_existing_source_guards_and_coherent_build(self):
        block = self.restage()
        for required in (
            "Assert-SourcePin $source",
            "Assert-SourceTree $source",
            "Assert-FrontendNextBuild $source",
            "Assert-PatchedSource $source",
            "Invoke-StageCopy $source $stagedSource",
            "Assert-PatchedSource $stagedSource",
            "Assert-FrontendNextBuild $stagedSource",
        ):
            self.assertIn(required, block)
        self.assertIn("frontend\\.next", OFFICE)
        self.assertIn("BUILD_ID", OFFICE)
        self.assertIn("OFFICE_SOURCE_BUILD_ID_INCOHERENT", OFFICE)
        self.assertIn("OFFICE_RESTAGE_BUILD_ID_CHANGED", block)

    def test_restage_verifies_every_staged_file_and_rewrites_both_receipts(self):
        block = self.restage()
        self.assertIn("Get-SelectedFileInventory $source $installExclusions", block)
        self.assertIn("Get-SelectedFileInventory $stagedSource @()", block)
        self.assertIn("Assert-InventoryMatches $expectedInventory $stagedInventory", block)
        self.assertIn("Write-StageManifest -StageRoot $txDir -SourceRoot $stagedSource -ManifestPath $candidateManifest", block)
        self.assertIn("Assert-StageManifest -StageRoot $txDir -SourceRoot $stagedSource -ManifestPath $candidateManifest", block)
        self.assertIn("New-RestageReceipt $Receipt $candidateManifest", block)
        self.assertIn("Write-OfficeReceipt $candidateReceiptData $candidateReceipt", block)
        self.assertIn("Assert-ReceiptShape $candidateReadback", block)

    def test_restage_rechecks_inputs_before_promotion_and_keeps_install_identity(self):
        block = self.restage()
        self.assertIn("OFFICE_RESTAGE_SOURCE_CHANGED_BEFORE_PROMOTION", block)
        self.assertIn("$taskNow = Get-OfficeTask", block)
        self.assertIn("Assert-TaskOwned $taskNow $Receipt", block)
        self.assertIn("Assert-OfficeStopped $taskNow", block)
        self.assertIn("Assert-ReceiptIntegrity $Receipt", block)
        self.assertIn(
            "foreach ($name in @('pythonExe','arguments','userId','taskName','installRoot','port','requirementsLockSha256','installedAtUtc'))",
            block,
        )
        self.assertIn("Add-Member -NotePropertyName restagedAtUtc", OFFICE)
        self.assertNotIn("$next.installedAtUtc", OFFICE)

    def test_restage_is_transactional_and_rolls_back_verified(self):
        block = self.restage()
        for required in (
            "Move-Item -LiteralPath $sourceDir -Destination $previousSource",
            "Move-Item -LiteralPath $stagedSource -Destination $sourceDir",
            "Move-OwnedFile $candidateManifest $manifestPath",
            "Move-OwnedFile $candidateReceipt $receiptPath",
            "Invoke-RestageRollback",
            "OFFICE_RESTAGE_FAILED_ROLLED_BACK",
            "OFFICE_RESTAGE_ROLLBACK_FAILED",
            "previousSourceRetained",
            "rollbackPath",
        ):
            self.assertIn(required, block)

    def test_restage_never_starts_registers_installs_or_removes(self):
        block = self.restage()
        for forbidden in (
            "Start-ScheduledTask",
            "Stop-ScheduledTask",
            "Register-ScheduledTask",
            "Unregister-ScheduledTask",
            "pip install",
            "ensurepip",
            "Uninstall",
            "Invoke-WebRequest",
            "Remove-Item",
        ):
            self.assertNotIn(forbidden, block)
        self.assertIn("state\\office.db", OFFICE)
        self.assertIn("state\\keys.json", OFFICE)

    def test_start_still_asserts_the_stage_manifest_before_starting(self):
        start = section(OFFICE, "if ($Mode -eq 'Start') {", "if ($Mode -eq 'Stop') {")
        self.assertLess(start.index("Assert-StageManifest"), start.index("Start-ScheduledTask"))
        self.assertNotIn("Restage", start)


@unittest.skipUnless(POWERSHELL, "Native Windows PowerShell unavailable")
class NativeWhatIfHashTests(unittest.TestCase):
    """Real -File invocation: hash validation must not inherit WhatIf suppression."""

    def test_prepare_source_file_whatif_validates_without_writing(self):
        with tempfile.TemporaryDirectory(prefix="singularity-whatif-") as folder:
            root = Path(folder)
            local = root / "LocalAppData"
            install = local / "Singularity" / "WindowsNative"
            install.mkdir(parents=True)
            marker = install / "untouched.bin"
            marker.write_bytes(b"existing installation sentinel")
            source = root / "source"
            source.mkdir()
            rows = []
            for i in range(200):
                name = f"fixture-{i:03}.txt"
                data = f"source {i}\n".encode()
                (source / name).write_bytes(data)
                rows.append(dict(path=name, bytes=len(data), sha256=hashlib.sha256(data).hexdigest()))
            manifest = dict(schema=1, variant=2, release_status="SOURCE_ONLY_UNCOMPILED_NOT_INSTALLER",
                            repoql=dict(requiredVersion="1.7.18", connectorContract="fetch-render"),
                            features=dict(office=True, ghost=False), rustOfficeFeature=True,
                            rustGhostFeature=False, gui="claude-desktop-code", files=rows)
            (source / "NATIVE_WINDOWS_SOURCE_MANIFEST.json").write_text(json.dumps(manifest), encoding="utf-8")
            before = {p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()}
            args = [POWERSHELL, "-NoLogo", "-NoProfile", "-NonInteractive", "-File",
                    str(HERE / "stage-native.ps1"), "-PrepareSource", "-Option", "2",
                    "-SourceRoot", str(source), "-InstallRoot", str(install), "-Apply", "-WhatIf"]
            env = dict(os.environ, LOCALAPPDATA=str(local))
            result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertIn("SOURCE_REFRESH_CANDIDATE_PREVIEW", result.stdout)
            self.assertIn("What if:", result.stdout)
            self.assertFalse((install / ".source-refresh-candidate").exists())
            self.assertEqual(before, {p.relative_to(root): p.read_bytes() for p in root.rglob("*") if p.is_file()})
            # Dry runs must still reject changed bytes, not merely skip validation.
            (source / rows[0]["path"]).write_bytes(b"changed!\n")
            result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=60)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("SOURCE_HASH_MISMATCH", result.stderr)
            self.assertFalse((install / ".source-refresh-candidate").exists())
            self.assertEqual(marker.read_bytes(), b"existing installation sentinel")

    def test_both_read_only_hash_helpers_work_under_global_whatif(self):
        with tempfile.TemporaryDirectory(prefix="singularity-hash-") as folder:
            root = Path(folder)
            probe = root / "probe.bin"
            probe.write_bytes(b"read-only hash regression\x00\xff")
            expected = hashlib.sha256(probe.read_bytes()).hexdigest()
            def quote(value):
                return "'" + str(value).replace("'", "''") + "'"
            for name in ("stage-native.ps1", "manage_native_windows.ps1"):
                script = r"""$ErrorActionPreference='Stop';$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(__SCRIPT__,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'PARSE_ERROR'}
$defs=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -ceq 'Get-FileSha256'},$true))
if($defs.Count -ne 1){throw 'HASH_HELPER_NOT_UNIQUE'}
. ([scriptblock]::Create($defs[0].Extent.Text))
$WhatIfPreference=$true
$actual=Get-FileSha256 __PROBE__
if($actual -cne '__EXPECTED__'){throw 'HASH_MISMATCH'}
$missingRefused=$false
try{$null=Get-FileSha256 (__PROBE__+'.missing')}catch{$missingRefused=$true}
if(-not $missingRefused){throw 'MISSING_FILE_NOT_REFUSED'}
$stream=[IO.File]::Open(__PROBE__,[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None);$stream.Dispose()
'HASH_WHATIF_PASS'
""".replace("__SCRIPT__", quote(HERE / name)).replace("__PROBE__", quote(probe)).replace("__EXPECTED__", expected)
                result = subprocess.run([POWERSHELL, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
                                         base64.b64encode(script.encode("utf-16le")).decode()],
                                        capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, name + result.stdout + result.stderr)
                self.assertIn("HASH_WHATIF_PASS", result.stdout)


@unittest.skipUnless(SOURCE_POWERSHELL and BEHAVIOUR.is_file(), "PowerShell lifecycle harness unavailable")
class NativeInstallLifecycleBehaviourTests(unittest.TestCase):
    """Execute the real manager functions with stubbed scheduler/child managers."""

    def run_scenario(self, scenario: str) -> dict:
        result = subprocess.run(
            [
                SOURCE_POWERSHELL,
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(BEHAVIOUR),
                "-Scenario",
                scenario,
            ],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        self.assertEqual(
            result.returncode,
            0,
            f"{scenario}: PowerShell failed\nstdout={result.stdout}\nstderr={result.stderr}",
        )
        lines = [line for line in result.stdout.splitlines() if line.strip()]
        self.assertTrue(lines, f"{scenario}: no JSON output")
        return json.loads(lines[-1])

    def test_skip_office_receipt_and_result_report_the_real_office_task(self):
        existing = self.run_scenario("SkipOfficeExistingOfficeTask")
        self.assertGreaterEqual(existing["receiptWrites"], 4)
        self.assertTrue(existing["receiptOfficeTaskRegistered"])
        self.assertTrue(existing["resultOfficeTaskRegistered"])
        self.assertFalse(existing["officeIncluded"])
        self.assertTrue(existing["receiptSupervisorTaskRegistered"])
        self.assertTrue(existing["receiptDashboardTaskRegistered"])
        self.assertTrue(existing["receiptGhostTaskRegistered"])
        self.assertEqual(existing["receiptState"], "installed_not_started")

        absent = self.run_scenario("SkipOfficeAbsentOfficeTask")
        self.assertFalse(absent["receiptOfficeTaskRegistered"])
        self.assertFalse(absent["resultOfficeTaskRegistered"])
        self.assertFalse(absent["officeIncluded"])

    def test_receipt_writer_preserves_a_concurrent_fresh_pending_file(self):
        result = self.run_scenario("StaleReceiptTemp")
        self.assertTrue(result["finalExists"])
        self.assertEqual(result["finalState"], "installing")
        self.assertTrue(result["freshOtherSurvived"])
        self.assertTrue(result["oldOwnRemoved"])
        self.assertTrue(result["oldOtherRemoved"])

    def test_orphan_office_stop_targets_only_the_exact_product_task(self):
        result = self.run_scenario("OrphanOfficeStop")
        self.assertEqual(result["stopCallCount"], 1)
        self.assertEqual(result["stoppedTaskName"], "Singularity-ClaudeComplete-Office")
        self.assertEqual(result["stoppedTaskPath"], "\\")
        self.assertEqual(result["officeState"], "Ready")
        self.assertEqual(result["decoyState"], "Running")
        self.assertEqual(result["unrelatedState"], "Running")

    def test_source_refresh_and_rollback_round_trip_exact_preimages(self):
        result = self.run_scenario("SourceRefreshRoundTrip")
        self.assertTrue(result["roundTrip"], result)
        self.assertTrue(result["sourceRefreshSucceeded"], result)
        self.assertGreaterEqual(result["consumerChecks"], 2, result)
        self.assertFalse(result["releaseReady"], result)

    def test_source_refresh_failures_restore_exact_source_and_receipts(self):
        for scenario in ("SourceRefreshMoveFailure", "SourceRefreshStageReceiptFailure", "SourceRefreshReceiptFailure"):
            with self.subTest(scenario=scenario):
                result = self.run_scenario(scenario)
                self.assertTrue(result["refreshRecovered"], result)
                self.assertIn("NATIVE_SOURCE_REFRESH_FAILED_RECOVERED:", result["refreshError"])

    def test_source_rollback_failures_restore_refreshed_source_and_receipts(self):
        for scenario in ("SourceRollbackMoveFailure", "SourceRollbackStageReceiptFailure", "SourceRollbackReceiptFailure"):
            with self.subTest(scenario=scenario):
                result = self.run_scenario(scenario)
                self.assertTrue(result["rollbackRecovered"], result)
                self.assertIn("NATIVE_SOURCE_ROLLBACK_FAILED_RECOVERED:", result["rollbackError"])

    def test_unmanifested_pyc_is_refused_and_never_deleted(self):
        for scenario, expected in (
            ("SourceCandidateUnownedPycacheRefused", "NATIVE_SOURCE_UNOWNED_FILE_REFUSED"),
            ("SourceCurrentUnownedPycacheRefused", "NATIVE_STAGE_UNOWNED_FILE_REFUSED"),
        ):
            with self.subTest(scenario=scenario):
                result = self.run_scenario(scenario)
                self.assertTrue(result["unownedRefused"], result)
                self.assertTrue(result["unownedFilePreserved"], result)
                self.assertEqual(result["refusalError"], expected)

    def test_source_refresh_refuses_binary_owner_and_receipt_pin_mismatch(self):
        scenarios = (
            ("SourceCurrentBinaryMismatchRefused", "binaryMismatchRefused"),
            ("SourceInstallReceiptOwnerMismatchRefused", "ownerMismatchRefused"),
            ("SourceReceiptPinMismatchRefused", "receiptPinMismatchRefused"),
        )
        for scenario, key in scenarios:
            with self.subTest(scenario=scenario):
                result = self.run_scenario(scenario)
                self.assertTrue(result[key], result)

    def test_source_consumer_process_and_unknown_state_block_refresh(self):
        for scenario, key, error in (
            ("SourceConsumerProcessRefused", "consumerProcessRefused", "NATIVE_SOURCE_CONSUMER_RUNNING"),
            ("SourceConsumerProcessStateUnknown", "consumerProcessStateUnknown", "NATIVE_SOURCE_CONSUMER_STATE_UNKNOWN"),
        ):
            with self.subTest(scenario=scenario):
                result = self.run_scenario(scenario)
                self.assertTrue(result[key], result)
                self.assertEqual(result["refusalError"], error)


@unittest.skipUnless(POWERSHELL and OFFICE_BEHAVIOUR.is_file(), "Windows PowerShell Office Restage fixture unavailable")
class OfficeRestageBehaviourTests(unittest.TestCase):
    """Execute the real Restage function against isolated temp installs."""

    def run_scenario(self, scenario: str) -> dict:
        result = subprocess.run(
            [
                POWERSHELL,
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(OFFICE_BEHAVIOUR),
                "-Scenario",
                scenario,
            ],
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
        self.assertEqual(
            result.returncode,
            0,
            f"{scenario}: PowerShell failed\nstdout={result.stdout}\nstderr={result.stderr}",
        )
        lines = [line for line in result.stdout.splitlines() if line.strip()]
        self.assertTrue(lines, f"{scenario}: no JSON output")
        return json.loads(lines[-1])

    def test_stale_manifest_restage_verifies_new_tree_and_preserves_runtime(self):
        result = self.run_scenario("RestageSuccessStaleManifest")
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["state"], "restaged_not_started")
        self.assertEqual(result["staticBuildId"], result["newBuildId"])
        self.assertEqual(result["sourceBuildId"], result["newBuildId"])
        self.assertEqual(result["stagedBuildId"], result["newBuildId"])
        self.assertGreater(result["stageFileCount"], 0)
        self.assertEqual(result["sourceAfter"], result["expectedStaged"])
        self.assertNotEqual(result["approvedSource"], result["sourceBefore"])
        self.assertTrue(result["previousSourceRetained"])
        self.assertTrue(result["protectedPreserved"])
        self.assertTrue(result["pythonExePreserved"])
        self.assertTrue(result["argumentsPreserved"])
        self.assertEqual(result["installedAtAfter"], result["installedAtBefore"])
        self.assertTrue(result["restagedAt"])
        self.assertTrue(result["manifestConsistent"])

    def test_restage_refusals_do_not_touch_source_manifest_receipt_or_state(self):
        cases = {
            "TaskRunningRefused": "OFFICE_RESTAGE_TASK_RUNNING_STOP_FIRST",
            "TaskQueuedRefused": "OFFICE_RESTAGE_TASK_RUNNING_STOP_FIRST",
            "ProcessRunningRefused": "OFFICE_RESTAGE_PROCESSES_RUNNING_STOP_FIRST",
            "PortBusyRefused": "OFFICE_PORT_IN_USE_REFUSED",
            "TaskOwnershipRefused": "OFFICE_TASK_OWNERSHIP_DRIFT",
            "ReparseRefused": "OFFICE_SOURCE_REPARSE_REFUSED",
            "NestedPathRefused": "OFFICE_RESTAGE_PATH_NESTED_REFUSED",
            "DevicePathRefused": "OFFICE_SOURCE_REQUIRED",
        }
        for scenario, expected in cases.items():
            with self.subTest(scenario=scenario):
                result = self.run_scenario(scenario)
                self.assertTrue(result["ok"], result)
                self.assertIn(expected, result["error"])
                self.assertTrue(result["sourceUnchanged"], result)
                self.assertTrue(result["manifestUnchanged"], result)
                self.assertTrue(result["receiptUnchanged"], result)
                self.assertTrue(result["protectedUnchanged"], result)
                self.assertFalse(result["taskStarted"])
                if scenario == "DevicePathRefused":
                    self.assertTrue(result["canonicalSource"].startswith("C:\\"), result)
                    self.assertTrue(result["deviceSource"].startswith("//?/"), result)

    def test_copy_failure_stops_before_promotion_and_leaves_the_install_untouched(self):
        result = self.run_scenario("SourceCopyFailure")
        self.assertTrue(result["ok"], result)
        self.assertIn("OFFICE_STAGE_COPY_FAILED", result["error"])
        self.assertTrue(result["sourceUnchanged"], result)
        self.assertTrue(result["manifestUnchanged"], result)
        self.assertTrue(result["receiptUnchanged"], result)
        self.assertTrue(result["protectedUnchanged"], result)
        self.assertFalse(result["taskStarted"])

    def test_receipt_promotion_failure_rolls_back_source_manifest_and_receipt(self):
        result = self.run_scenario("ReceiptPromotionFailureRollback")
        self.assertTrue(result["ok"], result)
        self.assertIn("OFFICE_RESTAGE_FAILED_ROLLED_BACK", result["error"])
        self.assertTrue(result["sourceUnchanged"], result)
        self.assertTrue(result["manifestUnchanged"], result)
        self.assertTrue(result["receiptUnchanged"], result)
        self.assertTrue(result["protectedUnchanged"], result)
        self.assertTrue(result["failedSourceRetained"], result)
        self.assertFalse(result["taskStarted"])


if __name__ == "__main__":
    unittest.main()
