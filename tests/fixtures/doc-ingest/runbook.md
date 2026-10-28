# Deploy runbook (fixture)

Ordinary prose before the first heading.

## Prepare

- Check the node version.
- Ensure the memory config exists.

```bash
## this heading lives inside a fence and must not split the chunk
node scripts/doc-ingest-node.mjs status --all
```

## Execute

Run the deploy, then verify the service answers.

### Rollback

Restore the previous revision and re-run the verification.
