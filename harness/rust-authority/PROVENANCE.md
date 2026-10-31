# Support-artifact provenance

The source tree in this directory is the pass-13 Rust migration candidate. The
portable support artifacts below were restored from the verified private
pass-13 source package used for the migration. That package is not part of the
public tree, and its host-local path is intentionally omitted from this public
export. Original package digests and public-export digests are both recorded
here so the adaptation is inspectable.

The artifacts contain fixture data, verifier scripts and telemetry adapters
only: no host configuration, credentials or fleet inventory.

| Restored path | Original SHA-256 | Public export SHA-256 |
|---|---|---|
| `scripts/compare-fixtures.mjs` | `647d4859172a48f1abf8be5a146f0f31cbba9e7333e7e7b7d867763b0b4d5c83` | `647d4859172a48f1abf8be5a146f0f31cbba9e7333e7e7b7d867763b0b4d5c83` |
| `scripts/migration-coverage.mjs` | `bed952d48c4d51b44b454f9eb5f70ee8ea5af82b409757c17a5a7758d0c7f023` | `bed952d48c4d51b44b454f9eb5f70ee8ea5af82b409757c17a5a7758d0c7f023` |
| `scripts/source-telemetry-preview.mjs` | `989ad3ecfaea78cd712163765e520d608583d7c6aa2c24e673fc4095df94fe5d` | `989ad3ecfaea78cd712163765e520d608583d7c6aa2c24e673fc4095df94fe5d` |
| `fixtures/compat.json` | `f20158d5e0f71fc088093fd3a88fae99bc4a6aebf93d45e94f14b548e58d3698` | `d7f7e31bf866431533b502138fd7dd81b8c896a41b8ab7e78036e1d199f1669c` |
| `fixtures/final-compat.json` | `49d669afb4a8198152b7e0e1d320b42d7127195c048208b3c2bb73df900dcbe9` | `49d669afb4a8198152b7e0e1d320b42d7127195c048208b3c2bb73df900dcbe9` |
| `fixtures/resource-lease.json` | `b79540210aab54f16d9e1995c30954dcb0d10c6338ce5f7c305ae3c915eda34d` | `b79540210aab54f16d9e1995c30954dcb0d10c6338ce5f7c305ae3c915eda34d` |
| `adapter/source-telemetry.mjs` | `ea5f97bfaac8dfc5ead9fc4b305b98a699d30fd1b7c0ee8b72c31c2d977a6bbb` | `ea5f97bfaac8dfc5ead9fc4b305b98a699d30fd1b7c0ee8b72c31c2d977a6bbb` |
| `adapter/telemetry-transport.mjs` | `db55bf5b761c96bae879dfced1a5e267d557133e648e4c81f33d37e547417a2c` | `db55bf5b761c96bae879dfced1a5e267d557133e648e4c81f33d37e547417a2c` |
| `adapter/worker-shadow.mjs` | `fadb1c28ecd43f3517f34b3a468f6b9fed55dd98dc7eb6df5e52cd2b23ddebf3` | `fadb1c28ecd43f3517f34b3a468f6b9fed55dd98dc7eb6df5e52cd2b23ddebf3` |
| `docs/source-inventory.json` | `a1b091bb7dd7e69b40fedd727e805242b3555782c1719f0c7cbb1b7c04c8e4cd` | `a1b091bb7dd7e69b40fedd727e805242b3555782c1719f0c7cbb1b7c04c8e4cd` |
| `docs/reference-modules.json` | `69624c1ac7c23d16c9fb743dfca97a0e7a07cae0036ce3c819ee07fdb566f262` | `69624c1ac7c23d16c9fb743dfca97a0e7a07cae0036ce3c819ee07fdb566f262` |

## Public-export adaptation of `fixtures/compat.json`

The pre-sanitization fixture carried 28 expected doc-impact strings and 7
expected router-denial strings with internal ticket labels. The public export
replaces those labels with neutral wording that describes the behaviour: the
doc-impact heading names the classification itself, and the router denial
states the authority boundary without a ticket reference. The in-repo
JavaScript authority and the Rust authority emit the same neutral strings, so
the compatibility oracle still compares like with like. The error
classification and rendered heading are otherwise unchanged.

Four sample references containing a bare run identifier were renamed to
`.repoql/concepts/example-concept.md` so the public fixture carries no internal
run number. This is a sample changed-file path under the same
`.repoql/concepts/` classification rule; the request shape, mapping outcome and
`review-required` disposition are unchanged.

The fixture `source` header now records that it was generated offline from the
pass-13 JavaScript authority and aligned to the public behavioural labels; it
no longer claims to be an unmodified original export.

The fixture still contains 804 cases. It includes the retired
`engine_state.claude_allowed` probe; the Rust compatibility CLI reproduces the
frozen ESO_LIVE_DEBUG coordinator/remediation rule so the full oracle stays
closed. No case, request, classification or failure assertion was removed. The source-contract tests compare against the
in-repo `harness/kit` authority by default; set `ORCHESTRA_REFERENCE_KIT` to a
pinned external extraction to test a historical source.
