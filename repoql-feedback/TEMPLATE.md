<!--
RepoQL feedback — one report per issue.
Copy this file, fill every section, delete the guidance comments.
Do not include secret values, personal data, or private hostnames.
-->

# <one-line summary: what is wrong, in the form "X does Y when Z">

## Classification

<!-- Pick one. If two apply, file two reports. -->
- [ ] Defect — RepoQL did something wrong
- [ ] Limitation — RepoQL cannot do what it reasonably should
- [ ] Confusing behavior — correct, but harder to understand than it should be

**Area:** <mcp-tool | cli | indexer | query | concepts | connector | docs | other>
**Severity:** <blocks work | degrades work | cosmetic>
**Reproducible:** <always | intermittent | once, not since>

## Version and environment

| Field | Value |
| --- | --- |
| RepoQL version (`rql --version`) | |
| Host version reported by `rql command "host status"` | |
| Client / MCP surface version | |
| Install method | <package | container | binary | source> |
| Operating system and architecture | |
| Client (agent runtime, editor, CLI) | |
| Index state at the time | <ready | building — N% | none> |

<!-- Version skew between client and host is a diagnosis, not a detail: state it
     explicitly when the two differ, and quote the warning exactly. -->

## Exact command or call

```text
<the command exactly as issued, or the tool name plus a redacted argument object>
```

## Expected

<!-- What you expected, and why that was reasonable: the documentation line, the
     schema description, or the sibling command that behaves differently. -->

## Actual

```text
<the observed output, redacted>
```

## Reproduction

1. <smallest first step — a clean or synthetic index is preferred>
2.
3.

**Scope of repro:** <fresh index | existing index | specific workspace size>
**Reliability:** <every time | N of M attempts | once>

## Evidence

- <redacted output, log excerpt, or screenshot path inside the repo or an evidence
  archive — never a link to a private system>

## Attribution — why this is RepoQL and not the harness

<!-- This section is required. A report without it is treated as unclassified.
     State, in your own words:
       - what RepoQL did, observed directly;
       - what the client/harness did around it, and why that is not the cause;
       - what you ruled out (credentials, permissions, host capacity, network). -->

- **Observed RepoQL behavior:**
- **What the surrounding harness did (and why it is not the cause):**
- **Ruled out:**
- **Still unknown:**

## Workaround

<!-- What you did instead, and what it cost you. "None" is a valid and useful
     answer. -->

## Redaction check

- [ ] No credential, token, key, or password values
- [ ] No personal or customer data
- [ ] No private hostname, internal address, or identifying path
- [ ] Redactions keep the shape of the original value visible
