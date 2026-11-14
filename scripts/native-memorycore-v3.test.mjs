import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeNativeCliFixture } from '../native/windows/native_cli_fixture.mjs';
import { loadMemoryConfig, callMemoryCore } from './memory-config-loader.mjs';

const saved = process.env.SINGULARITY_RUST_MEMORYCORE_READER_BIN;
const temp = mkdtempSync(join(tmpdir(), 'singularity-memorycore-v3-'));
const configFile = join(temp, 'memory.json');
writeFileSync(configFile, JSON.stringify({
  hostBaseUrl: 'http://127.0.0.1:8420', authPrefix: 'Bearer ',
  gatewayKey: 'fixture-secret-gateway', userKey: 'fixture-secret-user', serviceId: 'default',
}));
const cfg = loadMemoryConfig({ SINGULARITY_MEMORY_CONFIG: configFile });
const reference = {code:0, data:{messages:[{role:'assistant',content:'verified'}]}};
const fetchImpl = async (_url, init) => {
  assert.equal(init.redirect, 'error');
  return {ok:true,status:200,text:async()=>JSON.stringify(reference)};
};
function exe(value, label) {
  const path=join(temp, `${label}`);
  const script='#!/usr/bin/env node\nlet data="";process.stdin.on("data",x=>data+=x);\n'+
    'process.stdin.on("end",()=>{const req=JSON.parse(data);if(req.operation!=="v3Read")process.exit(2);\n'+
    `process.stdout.write(${JSON.stringify(JSON.stringify(value))});});\n`;
  return writeNativeCliFixture(path, script);
}
test.after(()=>{
  if(saved == null) delete process.env.SINGULARITY_RUST_MEMORYCORE_READER_BIN;
  else process.env.SINGULARITY_RUST_MEMORYCORE_READER_BIN=saved;
  rmSync(temp,{recursive:true,force:true});
});

test('Windows v3 default retrieval remains unchanged without Rust', async()=>{
  delete process.env.SINGULARITY_RUST_MEMORYCORE_READER_BIN;
  assert.deepEqual(await callMemoryCore('/v3/conversation/query', {session_id:'s'}, cfg, fetchImpl), reference);
});
test('v3 reference-equal Rust result may be used for a read', async()=>{
  process.env.SINGULARITY_RUST_MEMORYCORE_READER_BIN=exe({ok:true,payload:reference},'correct');
  assert.deepEqual(await callMemoryCore('/v3/conversation/query', {session_id:'s'}, cfg, fetchImpl), reference);
});
test('v3 forged memory content is rejected', async()=>{
  const malicious={code:0,data:{messages:[{role:'assistant',content:'forged'}]}};
  process.env.SINGULARITY_RUST_MEMORYCORE_READER_BIN=exe({ok:true,payload:malicious},'forged');
  await assert.rejects(callMemoryCore('/v3/conversation/query',{session_id:'s'},cfg,fetchImpl),/PARITY_FAILED/);
});
test('v3 memory writes never delegate to Rust', async()=>{
  process.env.SINGULARITY_RUST_MEMORYCORE_READER_BIN=exe({ok:true,payload:{code:0,unexpected:true}},'write');
  assert.deepEqual(await callMemoryCore('/v3/conversation/add', {messages:[{role:'assistant',content:'test'}]}, cfg, fetchImpl),reference);
});
test('v3 native executable failure blocks a selected read', async()=>{
  process.env.SINGULARITY_RUST_MEMORYCORE_READER_BIN=join(temp,'missing.exe');
  await assert.rejects(callMemoryCore('/v3/atomic/search',{query:'a'},cfg,fetchImpl),/EXECUTABLE_INVALID/);
});

test('selected Rust read refuses an off-host origin before network access', async()=>{
  process.env.SINGULARITY_RUST_MEMORYCORE_READER_BIN=exe({ok:true,payload:reference},'remote');
  let called=false;
  await assert.rejects(callMemoryCore('/v3/atomic/search',{query:'secret'},
    {...cfg,baseUrl:'http://127.0.0.1.attacker.invalid:8420'},async()=>{called=true;return fetchImpl();}),
    /NON_LOCAL_ORIGIN/);
  assert.equal(called,false);
});

test('native v3 count endpoints are read-only and parity-checked', async()=>{
  process.env.SINGULARITY_RUST_MEMORYCORE_READER_BIN=exe({ok:true,payload:reference},'count');
  assert.deepEqual(await callMemoryCore('/v3/conversation/count',{team_id:'t'},cfg,fetchImpl),reference);
  assert.deepEqual(await callMemoryCore('/v3/atomic/count',{team_id:'t'},cfg,fetchImpl),reference);
});
