# Singularity dashboard (portable projection)

This directory is a **portable copy of the operator's live RepoQL dashboard**,
included in the Singularity product so a user can run the same read-only control
surface against their own RepoQL installation. It is an optional adjunct to the
product, not an installation option and not a replacement for the operator's
deployed instance.

- Setup, configuration and the security model: [docs/DASHBOARD-SETUP.md](../docs/DASHBOARD-SETUP.md)
- Source provenance and licence notes: [PROVENANCE.md](PROVENANCE.md), [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)
- Configuration template: `config.example.json`, `.env.example`
- Container template: `docker-compose.yml`

Run the portability test from the repository root:

```sh
node --test tests/dashboard-portable.test.mjs
```
