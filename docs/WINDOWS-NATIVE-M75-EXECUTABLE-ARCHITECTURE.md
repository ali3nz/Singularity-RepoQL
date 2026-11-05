# Milestone 75 — Windows PE architecture check at staging boundary

The `stage-native.ps1` binary preflight previously verified DOS MZ and PE signatures only. Those signatures do not establish the AMD64 architecture expected by the Windows acceptance build. The stage now checks PE COFF machine `0x8664` and PE32+ optional header magic `0x020B`, in addition to existing signature checks. This applies to bridge, supervisor when supplied, RepoQL host, and GUI executable paths checked by the stager.

The focused source contract tests (7) pass. This is a **file format check only**, not publisher authentication, certificate validation, binary capability validation, runtime execution or security certification. Real x64 Windows binaries and Code-tab acceptance have not been exercised. No full regression suite. RELEASE BLOCKED.
