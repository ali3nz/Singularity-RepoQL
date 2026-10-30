# Milestone 51: externally pinned artifact digest check

The candidate manifest and ZIP checksum checks are useful **integrity checks**, but a malicious party who can rewrite both could make a self-consistent, untrusted bundle. `native/windows/verify_option2_expected_digest.py` makes the operator supply an independently reviewed bundle SHA-256 and a 40-character Git commit, plus an optional independently reviewed nested Option 2 source ZIP hash.

The tool rejects wrong digests, commit drift, wrong source and malformed expected inputs before emitting an acceptance receipt. It still says `publisher_signature_verified: false` and `production_release_ready: false`. **An attacker could supply a malicious bundle and matching hash if the expected value is not authenticated through an independent trusted channel.** This is not code signing.

On Windows, after independently checking the reviewed release/CI identity, run:

```powershell
python native/windows/verify_option2_expected_digest.py --bundle C:\Private\candidate.zip --expected-sha256 <reviewed64hex> --expected-commit <reviewed40hex> --expected-source-sha256 <reviewedSource64hex>
```

The Windows CI workflow will create a SHA256 sidecar and perform a **self-consistency** check with the same-run SHA/commit, not an independent publisher trust check. Operators must independently compare the expected hash with a trusted distribution source. The result is appropriate for investigating mismatched artifacts, not certifying runtime, GUI, plugin or memory behavior.

Five focused Python tests passed, using synthetic PE fixtures, with no actual Windows execution. Comprehensive test suites remain deferred as directed. Release BLOCKED.
