# Milestone 45: Prepared-bundle integrity and acceptance evidence

This is **Claude Code Complete** only. The implementation and tests are **source-only**.
It is not a signed installer, an installed service, a Windows build receipt or a
live Claude Desktop Code-tab acceptance receipt. `release_ready` stays false.

## Why this matters

The prior preparation workflow validated the outer bundle while extracting a
source tree and two Windows executables. It did not provide a separate way to
check whether those prepared files had been changed before staging. Milestone
45 adds `verify_prepared_option2_candidate.py`, included as a **fifth**
byte-identical bootstrap file in the outer Windows acceptance ZIP. This tool
reopens the original bundle and re-verifies every extracted source file, native
binary, source manifest, and preparation receipt. It rejects extra or missing
files, changed bytes, symlinks/junctions/reparse points, and directory escape.
It neither modifies the prepared tree nor executes any candidate binary.

Do not treat a valid archive hash as a publisher signature. Windows operators
must independently check the source commit and the provenance of actual Rust
binaries before trusting or staging any executable. Verification is subject to
normal filesystem time-of-check/time-of-use races; keep preview folders private
and revalidate at the moment of any approved staging action.

## Windows procedure

After the previously documented guarded preparation step, run the verifier from
the **same outer acceptance ZIP** (already extracted to a fresh directory).
Do not fetch this bootstrap helper separately from a different revision.

```powershell
python .\bootstrap\verify_prepared_option2_candidate.py `
  --bundle C:\Path\To\claude-code-complete-option2-WINDOWS-ACCEPTANCE-NOT-INSTALLER.zip `
  --prepared "$env:LOCALAPPDATA\Singularity\WindowsNativePreview\option2-test-001"
```

Expected status: `PREPARED_CONTENT_VERIFIED_NOT_INSTALLED`. A successful run
reports **two** verified source-bundle binaries, without asserting binary
publisher identity, binary execution, installed services, or GUI behavior.

## Acceptance evidence matrix

`native/windows/claude_complete_acceptance_matrix.py` gives Codex and human
reviewers a deterministic list of **17 distinct runtime acceptance gates**.
It starts with every gate `NOT_RUN` and always returns `release_ready:false`.
After authorized Windows testing, an operator may place *redacted* JSON gate
receipts and their separate evidence files in a private local directory:

```json
{
  "schema": "singularity-claude-complete-gate-evidence/v1",
  "gate": "native_claude_desktop_code_tab",
  "result": "PASS",
  "source_commit": "0123456789abcdef0123456789abcdef01234567",
  "evidence_name": "redacted-code-tab-evidence.log",
  "evidence_sha256": "<actual lowercase SHA-256 hex of that evidence file>"
}
```

This example is **not a passing receipt** and must not be copied as proof.
The evidence file must exist, be a regular local file, and match the supplied
hash. A missing gate remains `NOT_RUN`; malformed or altered evidence fails
closed. Mixed source revisions are flagged. No private evidence content or
paths are copied into the generated JSON matrix.

```powershell
# A blank matrix is a useful machine-readable TODO, not a release certificate.
python native\windows\claude_complete_acceptance_matrix.py `
  --output .acceptance\acceptance-gates-NOT-RUN.json

# Later, on the Windows machine, after gathering private evidence:
python native\windows\claude_complete_acceptance_matrix.py `
  --evidence-dir C:\Private\SingularityAcceptance\redacted-evidence `
  --output C:\Private\SingularityAcceptance\acceptance-report.json
```

**Important:** Even 17 reported PASS results are classified as
`REPORTED_PASS_UNREVIEWED`, not independently certified. Automated release
approval is deliberately unavailable until a reviewer independently assesses
actual native GUI, service, profile, indexing, Office/Ghost and lifecycle
behavior, including Windows build provenance and trusted software signatures.
Do not upload secrets, raw memory contents or credential-containing logs.

## Offline verification and remaining gaps

Run from the complete source tree:

```text
python -m unittest discover -s native/windows -p test_verify_prepared_option2_candidate.py
python -m unittest discover -s native/windows -p test_claude_complete_acceptance_matrix.py
python -m unittest discover -s native/windows -p test_option2_acceptance_bundle.py
```

The Windows CI candidate job now executes preparation and verification via
bootstrap helpers extracted from the actual generated outer ZIP, plus an
all-`NOT_RUN` acceptance matrix. Windows CI execution, real native Rust binary
compilation, genuine installer/service lifecycle, Claude Desktop Code tab,
RepoQL 1.7.18 plugin ownership, Tencent fresh-session recall, Ghost isolation
and Office event roundtrip all **remain unverified on this Linux host**.
