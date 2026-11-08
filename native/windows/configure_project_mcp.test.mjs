import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildMcpPlan,applyProjectMcp,rollbackProjectMcp,prepareProjectMcp,verifyProjectMcp,readRqlVersion } from './configure_project_mcp.mjs';
const root='C:\\Singularity\\Workspace';const rql='C:\\Singularity\\Bin\\rql.exe';const kanzo='C:\\Singularity\\Bin\\kanzo.exe';
const fixtureOpts=opts=>({...opts,allowFixture:true});
for(let variant=1;variant<=4;variant++)test(`option ${variant} correct MCP schema and no shell`,()=>{
 const p=buildMcpPlan({variant,workspace:root,rqlExe:rql,kanzoExe:kanzo});
 const m=variant<=2?p.configuration.mcpServers:p.configuration.mcp.servers;
 assert.deepEqual(Object.keys(m).sort(),variant===2?['kanzo']:['kanzo','repoql']);
 assert.equal(variant<=2?p.filename: p.filename,variant<=2?'.mcp.json':'opencode.json');
 if(variant!==2)assert.equal(variant<=2?m.repoql.args[0]:m.repoql.command[1],'mcp');
 assert.equal(variant<=2?m.kanzo.args[0]:m.kanzo.command[1],'mcp');
 assert.equal(p.runtimeVerified,false);
 assert.equal(JSON.stringify(p).includes('bash'),false);
});
test('foreign config preserved; foreign same-name MCP never overwritten',()=>{
 const original={permission:{edit:'ask'},mcp:{servers:{foreign:{type:'remote',url:'https://example.org/mcp'}}}};
 const p=buildMcpPlan({variant:4,workspace:root,rqlExe:rql,kanzoExe:kanzo,existing:original});
 assert.deepEqual(p.configuration.permission,original.permission);assert.deepEqual(p.configuration.mcp.servers.foreign,original.mcp.servers.foreign);
 assert.throws(()=>buildMcpPlan({variant:4,workspace:root,rqlExe:rql,kanzoExe:kanzo,existing:{mcp:{servers:{repoql:{type:'remote',url:'https://example.org'}}}}}),/FOREIGN_MCP_CONFLICT/);
});
test('unsafe path / exe rejected',()=>{
 for(const p of ['\\\\wsl$\\Ubuntu\\rql.exe','C:\\bad\\..\\rql.exe','C:\\bin\\cmd.exe']) assert.throws(()=>buildMcpPlan({variant:1,workspace:root,rqlExe:p,kanzoExe:kanzo}));
});
test('production mode still refuses an unverified fixture RepoQL binary',{skip:process.platform!=='win32'},()=>{
 const d=mkdtempSync(join(tmpdir(),'mcp-pin-')),ws=join(d,'ws'),bin=join(d,'bin');mkdirSync(ws);mkdirSync(bin);
 const a=join(bin,'rql.exe'),b=join(bin,'kanzo.exe');writeFileSync(a,'fixture');writeFileSync(b,'fixture');
 try{
  assert.throws(()=>prepareProjectMcp({variant:2,workspace:ws,rqlExe:a,kanzoExe:b}),/REPOQL_RELEASE_PIN_UNVERIFIED_RUN_CONNECTOR_MIGRATION/);
  assert.equal(existsSync(join(ws,'.mcp.json')),false);
  assert.equal(existsSync(join(ws,'.singularity-native-mcp-receipt.json')),false);
 }finally{rmSync(d,{recursive:true,force:true})}
});
for(let variant of [1,2,3,4])test(`option ${variant} isolated-file apply/rollback restores foreign settings`,()=>{
 const d=mkdtempSync(join(tmpdir(),'mcp-win-')),ws=join(d,'workspace'),bin=join(d,'bin');mkdirSync(ws);mkdirSync(bin);
 const a=join(bin,'rql.exe'),b=join(bin,'kanzo.exe');writeFileSync(a,'fixture');writeFileSync(b,'fixture');
 const cfg=join(ws,variant<=2?'.mcp.json':'opencode.json');const original=JSON.stringify(variant<=2?{mcpServers:{third:{command:'other'}}}:{mcp:{servers:{third:{type:'local',command:['other']}}}});
 writeFileSync(cfg,original);
 try {
  const opts=fixtureOpts({variant,workspace:ws,rqlExe:a,kanzoExe:b});
  const p=prepareProjectMcp(opts);assert.equal(p.registered.length,variant===2?1:2);
  assert.equal(applyProjectMcp(opts).applied,true);
  const configured=JSON.parse(readFileSync(cfg));const names=variant<=2?configured.mcpServers:configured.mcp.servers;
  assert.ok(names.third);assert.equal(Boolean(names.repoql),variant!==2);assert.ok(names.kanzo);
  assert.equal(rollbackProjectMcp({workspace:ws}).rolledBack,true);
  assert.equal(readFileSync(cfg,'utf8'),original);
 }finally{rmSync(d,{recursive:true,force:true})}
});
test('modified owned file refuses rollback',()=>{
 const d=mkdtempSync(join(tmpdir(),'mcp-win-')),ws=join(d,'workspace'),bin=join(d,'bin');mkdirSync(ws);mkdirSync(bin);
 const a=join(bin,'rql.exe'),b=join(bin,'kanzo.exe');writeFileSync(a,'fixture');writeFileSync(b,'fixture');
 try{applyProjectMcp(fixtureOpts({variant:1,workspace:ws,rqlExe:a,kanzoExe:b}));writeFileSync(join(ws,'.mcp.json'),'{}');assert.throws(()=>rollbackProjectMcp({workspace:ws}),/MCP_CONFIG_CHANGED_REFUSE_ROLLBACK/)}finally{rmSync(d,{recursive:true,force:true})}
});

test('RepoQL exact version parsed; ambiguous output rejected',()=>{ assert.equal(readRqlVersion('rql 1.7.18'),'1.7.18');assert.equal(readRqlVersion('1.7.18\n'),'1.7.18');assert.equal(readRqlVersion('v1.7.18'),'1.7.18');assert.equal(readRqlVersion('rql 1.7.18\n1.7.17'),null);assert.equal(readRqlVersion('RepoQL version 1.7.18'),'1.7.18');assert.equal(readRqlVersion('rql 1.7.18\nrql 1.7.19'),null);assert.equal(readRqlVersion('library xyz 1.7.18'),null); });

test('option 2 refuses an existing project RepoQL registration rather than silently duplicating its plugin',()=>{
 const existing={mcpServers:{repoql:{type:'stdio',command:rql,args:['mcp']}}};
 assert.throws(()=>buildMcpPlan({variant:2,workspace:root,rqlExe:rql,kanzoExe:kanzo,existing}),/REPOQL_PLUGIN_PROJECT_MCP_OVERLAP/);
});
test('option 2 project MCP plans Kanzo only while preserving independent RepoQL release prerequisites',()=>{
 const p=buildMcpPlan({variant:2,workspace:root,rqlExe:rql,kanzoExe:kanzo});
 assert.deepEqual(p.registered,['kanzo']);
 assert.ok(p.requires.includes('official-repoql-plugin-mcp-and-skills'));
 assert.ok(p.requires.includes('native-rql-exe-version-1.7.18'));
 assert.equal(p.configuration.mcpServers.repoql,undefined);
});

test('Option 2 read-only MCP verification requires owned receipt and unchanged Kanzo config',()=>{
 const d=mkdtempSync(join(tmpdir(),'mcp-verify-')),ws=join(d,'workspace'),bin=join(d,'bin');mkdirSync(ws);mkdirSync(bin);
 const rql=join(bin,'rql.exe'),kanzo=join(bin,'kanzo.exe');writeFileSync(rql,'fixture');writeFileSync(kanzo,'fixture');
 const opts=fixtureOpts({variant:2,workspace:ws,rqlExe:rql,kanzoExe:kanzo});
 try {
   assert.throws(()=>verifyProjectMcp({variant:2,workspace:ws}),/MCP_INSTALL_RECEIPT_MISSING/);
   assert.equal(applyProjectMcp(opts).applied,true);
   const result=verifyProjectMcp({variant:2,workspace:ws});
   assert.equal(result.installedConfigVerified,true);assert.equal(result.releaseReady,false);
   writeFileSync(join(ws,'.mcp.json'),'{}');
   assert.throws(()=>verifyProjectMcp({variant:2,workspace:ws}),/MCP_CONFIG_CHANGED_AFTER_INSTALL/);
 } finally {rmSync(d,{recursive:true,force:true})}
});

test('interrupted MCP apply with original project file unchanged recovers owned backup and temp',()=>{
 const d=mkdtempSync(join(tmpdir(),'mcp-interrupt-')),ws=join(d,'ws'),bin=join(d,'bin');mkdirSync(ws);mkdirSync(bin);
 const a=join(bin,'rql.exe'),b=join(bin,'kanzo.exe');writeFileSync(a,'fixture');writeFileSync(b,'fixture');
 const file=join(ws,'.mcp.json'),original=JSON.stringify({mcpServers:{third:{command:'other'}}});writeFileSync(file,original);
 try{
  applyProjectMcp(fixtureOpts({variant:2,workspace:ws,rqlExe:a,kanzoExe:b}));
  const receiptFile=join(ws,'.singularity-native-mcp-receipt.json'),receipt=JSON.parse(readFileSync(receiptFile,'utf8'));
  const applied=readFileSync(file);writeFileSync(file,original);writeFileSync(receipt.pendingTmp,applied);
  assert.equal(rollbackProjectMcp({workspace:ws}).interruptedApplyRecovered,true);
  assert.equal(readFileSync(file,'utf8'),original);assert.equal(existsSync(receiptFile),false);
  assert.equal(existsSync(receipt.pendingTmp),false);assert.equal(existsSync(receipt.backup),false);
 }finally{rmSync(d,{recursive:true,force:true})}
});
test('interrupted first MCP apply with originally absent project file can be recovered',()=>{
 const d=mkdtempSync(join(tmpdir(),'mcp-first-')),ws=join(d,'ws'),bin=join(d,'bin');mkdirSync(ws);mkdirSync(bin);
 const a=join(bin,'rql.exe'),b=join(bin,'kanzo.exe');writeFileSync(a,'fixture');writeFileSync(b,'fixture');
 try{
  applyProjectMcp(fixtureOpts({variant:2,workspace:ws,rqlExe:a,kanzoExe:b}));
  const file=join(ws,'.mcp.json'),r=JSON.parse(readFileSync(join(ws,'.singularity-native-mcp-receipt.json'),'utf8'));
  const applied=readFileSync(file);writeFileSync(r.pendingTmp,applied);
  rmSync(file);assert.equal(rollbackProjectMcp({workspace:ws}).interruptedApplyRecovered,true);
  assert.equal(existsSync(file),false);assert.equal(existsSync(r.pendingTmp),false);
 }finally{rmSync(d,{recursive:true,force:true})}
});
test('tampered MCP pending temp refuses rollback without altering the active project file',()=>{
 const d=mkdtempSync(join(tmpdir(),'mcp-tamper-')),ws=join(d,'ws'),bin=join(d,'bin');mkdirSync(ws);mkdirSync(bin);
 const a=join(bin,'rql.exe'),b=join(bin,'kanzo.exe');writeFileSync(a,'fixture');writeFileSync(b,'fixture');
 try{
  applyProjectMcp(fixtureOpts({variant:2,workspace:ws,rqlExe:a,kanzoExe:b}));
  const f=join(ws,'.mcp.json'),before=readFileSync(f),r=JSON.parse(readFileSync(join(ws,'.singularity-native-mcp-receipt.json')));
  writeFileSync(r.pendingTmp,'{}');
  assert.throws(()=>rollbackProjectMcp({workspace:ws}),/MCP_PENDING_TEMP_DRIFT/);
  assert.equal(Buffer.compare(before,readFileSync(f)),0);
  assert.throws(()=>verifyProjectMcp({variant:2,workspace:ws}),/MCP_PENDING_TEMP_DRIFT/);
 }finally{rmSync(d,{recursive:true,force:true})}
});

test('resumes rollback after journaled matching restore temporary file',()=>{
 const d=mkdtempSync(join(tmpdir(),'mcp-restore-')),ws=join(d,'ws'),bin=join(d,'bin');mkdirSync(ws);mkdirSync(bin);
 const a=join(bin,'rql.exe'),b=join(bin,'kanzo.exe');writeFileSync(a,'fixture');writeFileSync(b,'fixture');
 const file=join(ws,'.mcp.json'),original='{"mcpServers":{"foreign":{"command":"other"}}}';writeFileSync(file,original);
 try{
  applyProjectMcp(fixtureOpts({variant:2,workspace:ws,rqlExe:a,kanzoExe:b}));
  const receiptFile=join(ws,'.singularity-native-mcp-receipt.json'),r=JSON.parse(readFileSync(receiptFile));
  r.restoreTmp=file+'.restore-11111111-1111-4111-8111-111111111111';
  writeFileSync(receiptFile,JSON.stringify(r));writeFileSync(r.restoreTmp,original);
  assert.throws(()=>verifyProjectMcp({variant:2,workspace:ws}),/MCP_ROLLBACK_IN_PROGRESS/);
  assert.equal(rollbackProjectMcp({workspace:ws}).rolledBack,true);
  assert.equal(readFileSync(file,'utf8'),original);
  assert.equal(existsSync(r.restoreTmp),false);
 }finally{rmSync(d,{recursive:true,force:true})}
});
test('changed rollback restore temporary file is not removed or used',()=>{
 const d=mkdtempSync(join(tmpdir(),'mcp-restore-bad-')),ws=join(d,'ws'),bin=join(d,'bin');mkdirSync(ws);mkdirSync(bin);
 const a=join(bin,'rql.exe'),b=join(bin,'kanzo.exe');writeFileSync(a,'fixture');writeFileSync(b,'fixture');
 const file=join(ws,'.mcp.json');writeFileSync(file,'{}');
 try{
  applyProjectMcp(fixtureOpts({variant:2,workspace:ws,rqlExe:a,kanzoExe:b}));
  const receiptFile=join(ws,'.singularity-native-mcp-receipt.json'),r=JSON.parse(readFileSync(receiptFile));
  r.restoreTmp=file+'.restore-11111111-1111-4111-8111-111111111111';
  writeFileSync(receiptFile,JSON.stringify(r));writeFileSync(r.restoreTmp,'not-the-original');
  const installed=readFileSync(file);
  assert.throws(()=>rollbackProjectMcp({workspace:ws}),/MCP_RESTORE_TEMP_DRIFT/);
  assert.equal(Buffer.compare(installed,readFileSync(file)),0);
  assert.equal(existsSync(r.restoreTmp),true);
 }finally{rmSync(d,{recursive:true,force:true})}
});

test('Option 2 supports the product-owned headless OpenMausBot CLI without desktop pairing',()=>{
 const cli=join(tmpdir(),'singularity-owned-omb','cli.js');
 const p=buildMcpPlan(fixtureOpts({variant:2,workspace:root,rqlExe:rql,kanzoExe:kanzo,
   ombCli:cli,ombPort:18211,nodeExe:join(tmpdir(),'node.exe')}));
 assert.deepEqual(p.registered,['kanzo','openmausbot']);
 assert.deepEqual(p.configuration.mcpServers.openmausbot,{
   type:'stdio',command:join(tmpdir(),'node.exe'),args:[cli,'mcp'],env:{OMB_PORT:'18211'},
 });
 assert.equal(JSON.stringify(p).includes('OPENMAUSBOT_TOKEN'),false);
 assert.equal(p.configuration.mcpServers.repoql,undefined);
 assert.throws(()=>buildMcpPlan(fixtureOpts({variant:2,workspace:root,rqlExe:rql,kanzoExe:kanzo,
   ombCli:cli,ombPort:18211,nodeExe:join(tmpdir(),'node.exe'),ombExe:'C:\\Programs\\OpenMausBot.exe'})),/OPENMAUSBOT_AMBIGUOUS_RUNTIME/);
 for(const port of [0,1023,65535,99999,18211.5])assert.throws(()=>buildMcpPlan(fixtureOpts({variant:2,workspace:root,rqlExe:rql,kanzoExe:kanzo,
   ombCli:cli,ombPort:port,nodeExe:join(tmpdir(),'node.exe')})),/OPENMAUSBOT_HEADLESS_PORT_INVALID/);
});

test('Headless OpenMausBot config preserves foreign entries and rolls back from an owned receipt',()=>{
 const d=mkdtempSync(join(tmpdir(),'singularity-headless-mcp-')),ws=join(d,'workspace'),bin=join(d,'bin');
 mkdirSync(ws);mkdirSync(bin);
 const a=join(bin,'rql.exe'),b=join(bin,'kanzo.exe'),node=join(bin,'node.exe'),cli=join(bin,'cli.js');
 for(const f of [a,b,node,cli])writeFileSync(f,'fixture');
 const file=join(ws,'.mcp.json');const original=JSON.stringify({mcpServers:{foreign:{command:'other'}}});writeFileSync(file,original);
 try{
   const opts=fixtureOpts({variant:2,workspace:ws,rqlExe:a,kanzoExe:b,ombCli:cli,ombPort:18211,nodeExe:node});
   assert.equal(applyProjectMcp(opts).applied,true);
   const r=verifyProjectMcp({variant:2,workspace:ws});
   assert.ok(r.registered.includes('openmausbot'));
   const receipt=JSON.parse(readFileSync(join(ws,'.singularity-native-mcp-receipt.json'),'utf8'));
   assert.equal(receipt.ombMode,'headless');assert.equal(receipt.ombPort,18211);
   assert.deepEqual(JSON.parse(readFileSync(file,'utf8')).mcpServers.foreign,{command:'other'});
   assert.equal(rollbackProjectMcp({workspace:ws}).rolledBack,true);
   assert.equal(readFileSync(file,'utf8'),original);
 }finally{rmSync(d,{recursive:true,force:true})}
});
