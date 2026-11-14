#!/usr/bin/env node
// Differential oracle for Rust's pure post-authorization task snapshot formatter.
// No live Kanzo or MemoryCore network calls. The harness supplies synthetic,
// bounded responses and verifies authorization through a synthetic callback.
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recoverBoundTask } from './task-recovery.mjs';
let body = '';
for await (const chunk of process.stdin) body += chunk;
const request = JSON.parse(body);
const tmp = mkdtempSync(join(tmpdir(), 'task-recovery-oracle-'));
try {
  const ledgerPath = join(tmp, 'ledger.json');
  writeFileSync(ledgerPath, JSON.stringify(request.ledger));
  // Never dispatch native code while producing the reference value.
  delete process.env.SINGULARITY_RUST_MEMORY_POLICY_BIN;
  const result = await recoverBoundTask({
    ledgerPath, taskId: request.taskId, agent: request.agent,
    identity: request.identity, query: request.query,
    verifyTask: async () => request.authorizationVerified === true,
    core: async endpoint => endpoint.includes('/atomic/') ? request.l1Response : request.l0Response,
    maxUnits: request.maxUnits, l1Limit: request.l1Limit, l0Limit: request.l0Limit,
  });
  process.stdout.write(JSON.stringify(result));
} finally {
  rmSync(tmp, { force: true, recursive: true });
}
