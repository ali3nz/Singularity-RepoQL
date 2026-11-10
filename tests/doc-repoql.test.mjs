import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {confinedDocument, documentHash, verifyRepoqlDocument, verifyRepoqlReadback} from '../scripts/doc-repoql.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'singularity-doc-repoql-'));
  mkdirSync(join(root, 'docs'));
  const document = 'docs/feature.md';
  const text = '# Feature\n\nCurrent source-backed instructions.\n';
  writeFileSync(join(root, document), text);
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return {root, document, text, expectedHash: documentHash(text)};
}

test('RepoQL requires discovery and exact current source readback', async t => {
  const f = fixture(t);
  const commands = [];
  const result = await verifyRepoqlDocument({...f, invoke: async args => {
    commands.push(args[0]);
    return JSON.stringify(args[0] === 'explore' ? {matches: [{uri: 'file:///docs/feature.md'}]} :
      [{uri: 'file:///docs/feature.md', representation: 'Content', content: f.text.replace(/\n/g, '\r\n')}]);
  }});
  assert.equal(result.status, 'REPOQL_VERIFIED', result.reason);
  assert.equal(result.sourceSha256, f.expectedHash);
  assert.deepEqual(commands, ['explore', 'read']);
});

test('stale, duplicated and wrong-path RepoQL records refuse verification', t => {
  const f = fixture(t);
  for (const records of [
    [{uri: 'file:///docs/feature.md', content: 'stale'}],
    [{uri: 'file:///docs/feature.md', content: f.text}, {uri: 'file:///docs/feature.md', content: f.text}],
    [{uri: 'file:///docs/other.md', content: f.text}],
  ]) assert.throws(() => verifyRepoqlReadback(records.map(record => ({...record, representation: 'Content'})), f));
});

test('RepoQL outage and undiscoverable documents remain blocked', async t => {
  const f = fixture(t);
  for (const invoke of [async () => {throw new Error('controlled transport outage');},
    async () => JSON.stringify({matches: []})]) {
    const result = await verifyRepoqlDocument({...f, invoke});
    assert.equal(result.status, 'DOC_BLOCKED');
    assert.equal(result.retryable, true);
  }
});

test('canonical document confinement rejects traversal and ambiguous URI paths', t => {
  const f = fixture(t);
  assert.throws(() => confinedDocument(f.root, '../outside.md'));
  assert.throws(() => verifyRepoqlReadback([{uri: 'file:///docs/%2e%2e/feature.md', representation: 'Content', content: f.text}], f));
});

test('RepoQL explore and read use the exact scoped argv', async t => {
  const f = fixture(t);
  const calls = [];
  const result = await verifyRepoqlDocument({...f, query: 'feature docs', invoke: async (args, directory) => {
    calls.push({args, directory});
    return JSON.stringify(args[0] === 'explore' ? {matches: [{uri: 'file:///docs/feature.md'}]} :
      [{uri: 'file:///docs/feature.md', representation: 'Content', content: f.text}]);
  }});
  assert.equal(result.status, 'REPOQL_VERIFIED', result.reason);
  assert.deepEqual(calls.map(c => c.args), [
    ['explore', 'feature docs', '--uri-glob', 'docs/**', '--json', '--token-budget', '2000'],
    ['read', 'file:///docs/feature.md', '--json', '--token-budget', '16000'],
  ]);
  assert.ok(calls.every(c => c.directory === f.root));
});
