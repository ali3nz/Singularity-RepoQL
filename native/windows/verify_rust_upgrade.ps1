# Unified, read-only native Rust upgrade gate.
# Source-only mode runs on an engineering checkout; -Native requires Windows,
# pinned dependencies and the compiled binaries. No installation, service
# registration, process restart, data migration or feature enablement occurs.
param([switch]$Native)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$PreviousPythonUtf8 = $env:PYTHONUTF8
try {
$env:PYTHONUTF8 = '1'

function Invoke-Checked([string]$Program, [string[]]$Arguments, [string]$Label) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE" }
}
foreach ($name in @('python', 'node')) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "$name is required" }
}
Push-Location $PSScriptRoot
try {
    Invoke-Checked 'python' @('-m','unittest','test_rust_readonly_bridge','test_memory_authority_preflight','test_rust_lock_release_gate','test_rust_upgrade_complete_parity','test_rust_source_bridge','test_rust_repoql_preflight','test_rust_parity_bridge','test_rust_capture_cli_bridge') 'Windows source bridge regressions'
} finally { Pop-Location }
Invoke-Checked 'python' @((Join-Path $Root 'native/windows/verify_source_release.py')) 'Windows static source feature and contract verification'
Invoke-Checked 'node' @((Join-Path $Root 'harness/kit/v46-memory-retrieval-truth-test.mjs')) 'Memory current-truth regression'
Invoke-Checked 'node' @('--test', (Join-Path $Root 'harness/kit/tests/native-memory-policy.test.mjs'), (Join-Path $Root 'harness/kit/tests/native-candidate-lifecycle.test.mjs'), (Join-Path $Root 'harness/kit/tests/native-conflict-signals.test.mjs'), (Join-Path $Root 'harness/kit/tests/native-doc-impact.test.mjs'), (Join-Path $Root 'harness/kit/tests/native-answerability.test.mjs')) 'Rust boundary regression'
$PolicyTests = Join-Path $Root 'native/windows/memory-parity-rust/tests'
$EvidenceTests = Join-Path $Root 'native/windows/release-evidence-rust/tests'
Invoke-Checked 'python' @((Join-Path $PolicyTests 'differential_v3.py'), '--repo', $Root) 'Memory reference oracle'
Invoke-Checked 'python' @((Join-Path $PolicyTests 'differential_v4.py'), '--repo', $Root) 'Candidate lifecycle reference oracle'
Invoke-Checked 'python' @((Join-Path $PolicyTests 'differential_capture.py'), '--repo', $Root) 'Lesson capture reference oracle'
Invoke-Checked 'python' @((Join-Path $PolicyTests 'differential_conflict.py'), '--repo', $Root) 'Memory conflict reference oracle'
Invoke-Checked 'python' @((Join-Path $PolicyTests 'differential_reconcile_synthesis.py'), '--repo', $Root) 'Memory reconciliation and synthesis reference oracle'
Invoke-Checked 'node' @('--test', (Join-Path $Root 'scripts/memory-reconcile-core.test.mjs'), (Join-Path $Root 'harness/kit/tests/native-synthesis-validation.test.mjs')) 'Rust memory reconciliation/synthesis boundary regressions'
Invoke-Checked 'node' @('--test', (Join-Path $Root 'harness/kit/tests/rust-compat-policy.test.mjs'), (Join-Path $Root 'harness/rust-authority/tests/run-health-reference.test.mjs')) 'Rust authority compat source and oracle tests'
Invoke-Checked 'node' @('--test', (Join-Path $Root 'memory/portable/task-recovery.test.mjs'), (Join-Path $Root 'memory/portable/task-recovery-rust-boundary.test.mjs')) 'Authorized task history Rust boundary'
Invoke-Checked 'python' @((Join-Path $PolicyTests 'differential_task_recovery.py'), '--repo', $Root) 'Task recovery reference oracle'
Invoke-Checked 'python' @((Join-Path $PolicyTests 'differential_answerability.py'), '--repo', $Root) 'MemOS answerability reference oracle'
Invoke-Checked 'python' @((Join-Path $PolicyTests 'differential_hook_capture.py'), '--repo', $Root) 'Claude hook capture reference oracle'
Invoke-Checked 'python' @((Join-Path $PolicyTests 'differential_windows_acceptance.py'), '--repo', $Root) 'Windows memory identity and doc reconciliation reference oracle'
Invoke-Checked 'node' @('--test', (Join-Path $Root 'adapters/claude-code/main-memory.test.mjs'), (Join-Path $Root 'adapters/claude-code/main-memory-rust-boundary.test.mjs')) 'Parent memory provider consent and native boundary'
Invoke-Checked 'python' @((Join-Path $PolicyTests 'differential_main_proxy.py'), '--repo', $Root) 'Parent session proxy routing reference oracle'
Invoke-Checked 'python' @((Join-Path $PolicyTests 'differential_promotion.py'), '--repo', $Root) 'Promotion governance reference oracle'
Invoke-Checked 'node' @('--test', (Join-Path $Root 'tests/doc-policy.test.mjs'), (Join-Path $Root 'tests/selflearn-candidates.test.mjs'), (Join-Path $Root 'tests/rust-document-learning-boundary.test.mjs')) 'Documentation and lesson validation Rust bridge'
Invoke-Checked 'python' @((Join-Path $PolicyTests 'differential_document_learning.py'), '--repo', $Root) 'Document learning reference oracle'
Invoke-Checked 'node' @('--test', (Join-Path $Root 'adapters/claude-code/doc-hook.test.mjs'), (Join-Path $Root 'native/windows/configure_claude_code_windows.test.mjs'), (Join-Path $Root 'scripts/bundle-classification.test.mjs')) 'Claude Code documentation and full source profile' 
Invoke-Checked 'python' @((Join-Path $Root 'tests/test-memory-promote.py')) 'Legacy MemoryCore promotion request contract'
Invoke-Checked 'python' @((Join-Path $Root 'tests/test-memory-promote-rust.py')) 'Promotion cursor safety boundary tests'
Invoke-Checked 'python' @((Join-Path $Root 'tests/test-memory-doc-ingest-rust.py')) 'Documentation ingestion native fail-closed and chunk boundary tests'
Invoke-Checked 'node' @('--test', (Join-Path $Root 'tests/doc-ingest-rust-boundary.test.mjs'), (Join-Path $Root 'tests/doc-ingest-chunk-parity.test.mjs')) 'Windows Node ingestion Rust boundary and Unicode parity'
Invoke-Checked 'python' @((Join-Path $PolicyTests 'differential_doc_ingest.py'), '--repo', $Root) 'Documentation ingestion/reference retrieval oracle'
Invoke-Checked 'python' @((Join-Path $Root 'tests/test-memory-doc-ingest.py')) 'Documentation MemoryCore stub integration'
$PreviousParityPython = $env:SINGULARITY_PARITY_PYTHON
try {
    $env:SINGULARITY_PARITY_PYTHON = (Get-Command 'python' -CommandType Application).Source
    Invoke-Checked 'node' @('--test', (Join-Path $Root 'tests/doc-ingest-parity.test.mjs')) 'Python and Node documentation integration'
} finally { $env:SINGULARITY_PARITY_PYTHON = $PreviousParityPython }
Invoke-Checked 'python' @((Join-Path $Root 'native/windows/test_rust_extracted_tree.py')) 'Source tree integrity reference fixture'
Invoke-Checked 'node' @('--test', (Join-Path $Root 'harness/kit/tests/native-memorycore-reader.test.mjs'), (Join-Path $Root 'scripts/native-memorycore-v3.test.mjs'), (Join-Path $Root 'scripts/native-memorycore-write.test.mjs'), (Join-Path $Root 'scripts/setup-agent-profiles.test.mjs')) 'Native MemoryCore read/write opt-in bridge'
Invoke-Checked 'python' @((Join-Path $Root 'native/windows/unified-gateway-rust/tests/differential_memorycore_reader.py')) 'Read-only MemoryCore HTTP reference scenarios'
Invoke-Checked 'python' @((Join-Path $Root 'native/windows/unified-gateway-rust/tests/differential_memorycore_writer.py')) 'Single-write HTTP reference scenarios'
Invoke-Checked 'python' @((Join-Path $Root 'native/windows/unified-gateway-rust/tests/differential_telemetry_model.py')) 'Dashboard accounting telemetry reference scenarios'
Invoke-Checked 'python' @((Join-Path $Root 'native/windows/unified-gateway-rust/tests/differential_agentchat_feed.py')) 'Agent Chat feed reference scenarios'
Invoke-Checked 'python' @((Join-Path $Root 'native/windows/unified-gateway-rust/tests/differential_native_readiness.py')) 'Native readiness reference scenarios'
Invoke-Checked 'python' @((Join-Path $Root 'tests/test-memory-doc-ledger-evidence-rust.py')) 'Documentation ledger evidence safety boundary'
Invoke-Checked 'python' @((Join-Path $Root 'native/windows/unified-gateway-rust/tests/differential_doc_ledger_evidence.py')) 'Documentation ledger evidence reference cases'
Invoke-Checked 'python' @((Join-Path $Root 'native/windows/unified-gateway-rust/tests/differential_memory_ledger_upgrade.py')) 'Memory ledger upgrade reference cases'
Push-Location (Join-Path $Root 'dashboard')
try { Invoke-Checked 'python' @('-m','unittest','test_rust_telemetry_model','test_native_telemetry_platform','test_agentchat_windows_file_identity','test_agentchat_recent_presence','test_agentchat_rust_bridge','test_native_readiness','test_native_readiness_rust_bridge') 'Dashboard telemetry and Agent Chat native boundary tests' } finally { Pop-Location }
Push-Location $PSScriptRoot
try { Invoke-Checked 'python' @('-m','unittest','test_source_variant_feature_exclusions','test_preflight_contract','test_claude_complete_release_audit') 'Full Claude Code source scope regression' } finally { Pop-Location }
Invoke-Checked 'node' @('--test', (Join-Path $Root 'native/windows/rust_acceptance_boundary.test.mjs'), (Join-Path $Root 'native/windows/claude_complete_memory_profiles.test.mjs'), (Join-Path $Root 'native/windows/claude_complete_doc_reconciliation.test.mjs'), (Join-Path $Root 'native/windows/claude_complete_doc_parity.test.mjs')) 'Windows acceptance Rust boundary' 
Invoke-Checked 'node' @('--test', (Join-Path $Root 'adapters/claude-code/memory-hook.test.mjs'), (Join-Path $Root 'adapters/claude-code/memory-hook-rust-boundary.test.mjs')) 'Claude hook native boundary regression'
Invoke-Checked 'python' @((Join-Path $Root 'native/windows/release-evidence-rust/tests/differential_upgrade_acceptance.py'), '--repo', $Root) 'Windows upgrade and acceptance reference oracle'
Push-Location $PSScriptRoot
try { Invoke-Checked 'python' @('-m','unittest','test_plan_option2_upgrade','test_claude_complete_acceptance_matrix','test_rust_release_policy','test_rust_release_source_contract') 'Rust upgrade and acceptance boundary' } finally { Pop-Location }
Invoke-Checked 'python' @((Join-Path $EvidenceTests 'differential.py'), '--repo', $Root) 'Release reference oracle'
Write-Host 'SOURCE_ONLY_REVIEW_PASSED; Rust compilation and native acceptance are NOT_RUN.'

if (-not $Native) { return }
if (-not $IsWindows) { throw '-Native requires native Windows, not WSL or Linux' }
if (-not (Get-Command 'cargo' -ErrorAction SilentlyContinue)) { throw 'Cargo is required' }
# Do not accept an incomplete lock check even if cargo could resolve and
# download new versions itself. This is an intentional fail-closed boundary.
Invoke-Checked 'python' @((Join-Path $Root 'native/windows/check_rust_lock_provenance.py'), '--source-root', $Root) 'All-crate lock provenance'
$Crates = @(
    'harness/rust-authority',
    'native/desktop-bridge',
    'native/windows/rust-supervisor',
    'native/windows/unified-gateway-rust',
    'native/windows/memory-parity-rust',
    'native/windows/rc-stack-rust',
    'native/windows/source-packager-rust',
    'native/windows/release-evidence-rust'
)
foreach ($crate in $Crates) {
    $Manifest = Join-Path $Root (Join-Path $crate 'Cargo.toml')
    $Features = @()
    if ($crate -eq 'native/desktop-bridge') {
        # Exercise the bridge shipped by Claude Code Full, not its lean default.
        $Features = @('--no-default-features','--features','office')
    }
    Invoke-Checked 'cargo' @('fmt', '--manifest-path', $Manifest, '--all', '--', '--check') "Formatting $crate"
    Invoke-Checked 'cargo' (@('test','--manifest-path',$Manifest,'--locked','--all-targets') + $Features) "Tests $crate"
    Invoke-Checked 'cargo' (@('clippy','--manifest-path',$Manifest,'--locked','--all-targets') + $Features + @('--','-D','warnings')) "Clippy $crate"
    Invoke-Checked 'cargo' (@('build','--manifest-path',$Manifest,'--locked','--release') + $Features) "Release build $crate"
}
# This fixture runs only an isolated synthetic child. It registers no task,
# touches no installed service and does not use the real OpenMausBot payload.
$OpenMausSupervisor = Join-Path $Root 'native/windows/rust-supervisor/target/release/singularity-windows-supervisorw.exe'
& (Join-Path $PSScriptRoot 'test_openmausbot_rust_job.ps1') -SupervisorExe $OpenMausSupervisor
$SetupFrontend = Join-Path $Root 'native/windows/rust-supervisor/target/release/singularity-windows-setup.exe'
& (Join-Path $PSScriptRoot 'test_rust_setup_request.ps1') -SetupExe $SetupFrontend
# Verify production call sites through the real compiled Rust CLI, not a
# JavaScript fixture. These scripts make no changes to installed services.
$MemoryBinary = Join-Path $Root 'native/windows/memory-parity-rust/target/release/singularity-memory-parity.exe'
$EvidenceBinary = Join-Path $Root 'native/windows/release-evidence-rust/target/release/singularity-release-evidence.exe'
$CaptureBinary = Join-Path $Root 'native/windows/memory-parity-rust/target/release/singularity-memory-turn-capture.exe'
$AuthorityBinary = Join-Path $Root 'harness/rust-authority/target/release/orchestra-observer.exe'
$SourcePackagerBinary = Join-Path $Root 'native/windows/source-packager-rust/target/release/singularity-source-packager.exe'
foreach ($binary in @($MemoryBinary, $EvidenceBinary, $CaptureBinary, $AuthorityBinary, $SourcePackagerBinary)) {
    if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw "Missing compiled binary: $binary" }
}
foreach ($suite in @('differential.py','differential_v2.py','differential_v3.py','differential_v4.py','differential_conflict.py','differential_reconcile_synthesis.py','differential_task_recovery.py','differential_answerability.py','differential_hook_capture.py','differential_windows_acceptance.py','differential_main_proxy.py','differential_promotion.py','differential_document_learning.py','differential_doc_ingest.py')) {
    Invoke-Checked 'python' @((Join-Path $PolicyTests $suite),'--repo',$Root,'--rust-cli',$MemoryBinary) "Actual Rust memory differential $suite"
}
# Exercise both real host adapters against the compiled document policy and
# disposable HTTP/ledger fixtures. Restore the caller's environment on error.
$PreviousDocBinary = $env:SINGULARITY_DOC_RUST_BIN
$PreviousDocCommitBinary = $env:SINGULARITY_DOC_LEDGER_COMMIT_RUST_BIN
$PreviousParityPython = $env:SINGULARITY_PARITY_PYTHON
try {
    $env:SINGULARITY_DOC_RUST_BIN = $MemoryBinary
    $env:SINGULARITY_DOC_LEDGER_COMMIT_RUST_BIN = Join-Path $Root 'native/windows/unified-gateway-rust/target/release/singularity-doc-ledger-commit.exe'
    $env:SINGULARITY_PARITY_PYTHON = (Get-Command 'python' -CommandType Application).Source
    Invoke-Checked 'python' @((Join-Path $Root 'tests/test-memory-doc-ingest.py')) 'Compiled Python documentation integration'
    Invoke-Checked 'node' @('--test', (Join-Path $Root 'tests/doc-ingest-parity.test.mjs')) 'Compiled Python and Node documentation integration'
} finally {
    $env:SINGULARITY_DOC_RUST_BIN = $PreviousDocBinary
    $env:SINGULARITY_DOC_LEDGER_COMMIT_RUST_BIN = $PreviousDocCommitBinary
    $env:SINGULARITY_PARITY_PYTHON = $PreviousParityPython
}
Invoke-Checked 'node' @((Join-Path $Root 'harness/rust-authority/scripts/compare-fixtures.mjs'),$AuthorityBinary) 'Compiled Rust orchestration compatibility differential'
Invoke-Checked 'python' @((Join-Path $Root 'native/windows/test_rust_extracted_tree.py'),'--rust-cli',$SourcePackagerBinary) 'Compiled Rust extracted source integrity fixtures'
Invoke-Checked 'python' @((Join-Path $EvidenceTests 'differential.py'),'--repo',$Root,'--rust-cli',$EvidenceBinary) 'Actual Rust release evidence differential'
Invoke-Checked 'python' @((Join-Path $EvidenceTests 'differential_doc_impact.py'),'--repo',$Root,'--rust-cli',$EvidenceBinary) 'Actual Rust documentation impact differential'
Invoke-Checked 'python' @((Join-Path $EvidenceTests 'differential_upgrade_acceptance.py'),'--repo',$Root,'--rust-cli',$EvidenceBinary) 'Actual Rust upgrade and acceptance differential'
Invoke-Checked 'python' @((Join-Path $PolicyTests 'differential_capture.py'),'--repo',$Root,'--rust-cli',$CaptureBinary) 'Actual Rust lesson capture differential'
# Test the Python-to-Rust preflight replacement with a temporary synthetic
# configuration; no live authority folders or host settings are touched.
$Temp = Join-Path ([System.IO.Path]::GetTempPath()) ('singularity-native-rust-' + [guid]::NewGuid().ToString('N'))
try {
    $ConfigDir = Join-Path $Temp 'harness/kit'
    [void](New-Item -ItemType Directory -Path $ConfigDir -Force)
    [System.IO.File]::WriteAllText((Join-Path $ConfigDir 'config.json'), '{"memoryProvenance":{"retrievalFilter":"DISABLED"}}')
    $OldFilter = $env:ORCH_MEMORY_RETRIEVAL_FILTER
    try {
        $env:ORCH_MEMORY_RETRIEVAL_FILTER = 'DISABLED'
        Invoke-Checked 'python' @((Join-Path $Root 'native/windows/memory_authority_preflight.py'),'--root',$Temp,'--rust-binary',$MemoryBinary) 'Compiled Rust preflight call site'
    } finally { $env:ORCH_MEMORY_RETRIEVAL_FILTER = $OldFilter }
} finally {
    if (Test-Path -LiteralPath $Temp) { Remove-Item -LiteralPath $Temp -Recurse -Force }
}
# Every opt-in native projection must pass its own compiled differential.
# No source-reference-only result may substitute for native Windows parity.
$GatewayBase = Join-Path $Root 'native/windows/unified-gateway-rust/target/release'
$GatewayTests = Join-Path $Root 'native/windows/unified-gateway-rust/tests'
$GatewayDifferentials = @(
    @{ Binary = 'singularity-agentchat-feed'; Suite = 'differential_agentchat_feed.py' }
    @{ Binary = 'singularity-claude-agent-fields'; Suite = 'differential_claude_agent_fields.py' }
    @{ Binary = 'singularity-claude-mcp-inventory'; Suite = 'differential_claude_mcp_inventory.py' }
    @{ Binary = 'singularity-dashboard-graph'; Suite = 'differential_dashboard_graph.py' }
    @{ Binary = 'singularity-dashboard-link-page'; Suite = 'differential_dashboard_link_page.py' }
    @{ Binary = 'singularity-dashboard-service-errors'; Suite = 'differential_dashboard_service_errors.py' }
    @{ Binary = 'singularity-dashboard-indexing-errors'; Suite = 'differential_dashboard_indexing_errors.py' }
    @{ Binary = 'singularity-dashboard-routes'; Suite = 'differential_dashboard_routes.py' }
    @{ Binary = 'singularity-dashboard-listener'; Suite = 'differential_dashboard_listener.py' }
    @{ Binary = 'singularity-doc-ledger-commit'; Suite = 'differential_doc_ledger_commit.py' }
    @{ Binary = 'singularity-doc-ledger-evidence'; Suite = 'differential_doc_ledger_evidence.py' }
    @{ Binary = 'singularity-harness-agent-seats'; Suite = 'differential_harness_agent_seats.py' }
    @{ Binary = 'singularity-harness-percentiles'; Suite = 'differential_harness_percentiles.py' }
    @{ Binary = 'singularity-harness-usage'; Suite = 'differential_harness_usage.py' }
    @{ Binary = 'singularity-memory-ledger-upgrade'; Suite = 'differential_memory_ledger_upgrade.py' }
    @{ Binary = 'singularity-memorycore-reader'; Suite = 'differential_memorycore_reader.py' }
    @{ Binary = 'singularity-memorycore-writer'; Suite = 'differential_memorycore_writer.py' }
    @{ Binary = 'singularity-memorycore-writer'; Suite = 'differential_doc_native_write.py' }
    @{ Binary = 'singularity-native-cpu-history'; Suite = 'differential_native_cpu_history.py' }
    @{ Binary = 'singularity-native-gui-usage'; Suite = 'differential_native_gui_usage.py' }
    @{ Binary = 'singularity-native-readiness'; Suite = 'differential_native_readiness.py' }
    @{ Binary = 'singularity-openmaus-inventory'; Suite = 'differential_openmaus_inventory.py' }
    @{ Binary = 'singularity-repoql-connectors'; Suite = 'differential_repoql_connectors.py' }
    @{ Binary = 'singularity-repoql-query-usage'; Suite = 'differential_repoql_query_usage.py' }
    @{ Binary = 'singularity-repository-summary'; Suite = 'differential_repository_summary.py' }
    @{ Binary = 'singularity-telemetry-model'; Suite = 'differential_telemetry_model.py' }
    @{ Binary = 'singularity-unified-proxy'; Suite = 'differential_unified_proxy.py' }
)
foreach ($case in $GatewayDifferentials) {
    $binary = Join-Path $GatewayBase ($case.Binary + '.exe')
    if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { throw "Missing compiled gateway binary: $binary" }
    $test = Join-Path $GatewayTests $case.Suite
    if (-not (Test-Path -LiteralPath $test -PathType Leaf)) { throw "Missing gateway differential: $test" }
    Invoke-Checked 'python' @($test, '--rust-cli', $binary) "Native gateway compiled parity $($case.Binary)"
}
Write-Host 'NATIVE_RUST_SOURCE_PARITY_PASSED'
Write-Host 'This is NOT live Windows memory, Kanzo, Tencent, UI, upgrade or rollback acceptance.'

} finally {
    if ($null -eq $PreviousPythonUtf8) {
        Remove-Item Env:PYTHONUTF8 -ErrorAction SilentlyContinue
    } else {
        $env:PYTHONUTF8 = $PreviousPythonUtf8
    }
}
