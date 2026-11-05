// Self-test of the differential verifier, using a fake response generator.
// This deliberately does NOT establish Rust parity or execute Rust code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const fixtures = resolve(root, 'fixtures/compat.json');
const comparator = resolve(root, 'scripts/compare-fixtures.mjs');

function checkResponse(mode) {
  const folder = mkdtempSync(join(tmpdir(), 'orchestra-diff-selftest-'));
  const previousCwd = process.cwd();
  try {
    // The verifier accepts an executable path. Use the current Node binary as
    // that executable and an extensionless CommonJS entry script as the fake
    // response generator: native Windows cannot execute a shebang script, but
    // `node compat-lines` works on every platform without a shell or chmod.
    writeFileSync(join(folder, 'compat-lines'), `
const { readFileSync } = require('node:fs');
const cases = JSON.parse(readFileSync(${JSON.stringify(fixtures)}, 'utf8')).cases;
const lines = readFileSync(0, 'utf8').split(String.fromCharCode(10)).map(line => line.endsWith(String.fromCharCode(13)) ? line.slice(0, -1) : line).filter((line, index, all) => line !== '' || index !== all.length - 1);
let index = 0;
for (const line of lines) {
  const received = JSON.parse(line);
  if (JSON.stringify(received) !== JSON.stringify(cases[index]?.request)) process.exit(7);
  const expected = cases[index].expected;
  if (${JSON.stringify(mode)} === 'truncate' && index === cases.length - 1) break;
  console.log(JSON.stringify(${JSON.stringify(mode)} === 'mutate' && index === 0 ? {deliberateMismatch: true} : expected));
  index++;
}
`);
    process.chdir(folder);
    const result = spawnSync(process.execPath, [comparator, process.execPath], { encoding: 'utf8', maxBuffer: 5 * 1024 * 1024, timeout: 10000 });
    if (result.error) throw result.error;
    return result;
  } finally {
    process.chdir(previousCwd);
    rmSync(folder, {recursive:true,force:true});
  }
}

test('verifier accepts exact expected results from a mock process', () => {
  const result = checkResponse('match');
  assert.equal(result.status, 0, result.stderr);
  const count = JSON.parse(readFileSync(fixtures, 'utf8')).cases.length;
  assert.ok(result.stdout.includes(`${count}/${count} JS/Rust golden cases matched`), result.stdout);
});
test('verifier rejects a deliberately mutated result', () => {
  const result = checkResponse('mutate');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /MISMATCH/);
});
test('verifier rejects missing result rows', () => {
  const result = checkResponse('truncate');
  assert.notEqual(result.status, 0);
});
