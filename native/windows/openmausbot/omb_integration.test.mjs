import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {installRules,verifyRules,rollbackRules,planRules} from './install_shared_rules.mjs';
import {runtimeOptions} from './claude_mcp_launcher.mjs';
import {buildMcpPlan,applyProjectMcp,rollbackProjectMcp,verifyProjectMcp} from '../configure_project_mcp.mjs';
const setup=()=>{const d=mkdtempSync(join(tmpdir(),'singularity-omb-'));mkdirSync(join(d,'data','bots'),{recursive:true});return d};
const fixture=(d)=>({dataDir:join(d,'data')});
test('shared bot ancestor rules install, verify and rollback without touching foreign file',()=>{
 const d=setup();try{const f=fixture(d),p=planRules(f);assert.equal(p.state,'absent');
  assert.equal(installRules(f,true).changed,true);assert.equal(verifyRules(f).verified,true);
  assert.equal(installRules(f,true).changed,false);assert.equal(rollbackRules(f,true).rolledBack,true);
  assert.equal(existsSync(p.target),false);
 }finally{rmSync(d,{recursive:true,force:true})}
});
test('foreign AGENTS.md not overwritten',()=>{
 const d=setup();try{const f=fixture(d),p=planRules(f);writeFileSync(p.target,'original owner instructions');
  assert.throws(()=>installRules(f,true),/EXISTING_AGENTS_FILE_PRESERVED/);
  assert.equal(readFileSync(p.target,'utf8'),'original owner instructions');
  assert.equal(existsSync(p.stamp),false);
 }finally{rmSync(d,{recursive:true,force:true})}
});
test('modified owned file stops removal',()=>{
 const d=setup();try{const f=fixture(d),p=planRules(f);installRules(f,true);writeFileSync(p.target,'changed');
  assert.throws(()=>rollbackRules(f,true),/RULES_NOT_INSTALLED_OR_CHANGED/);
  assert.equal(readFileSync(p.target,'utf8'),'changed');
 }finally{rmSync(d,{recursive:true,force:true})}
});
test('symlink bot workspace is refused',()=>{
 const d=setup();try{rmSync(join(d,'data','bots'),{recursive:true});symlinkSync(d,join(d,'data','bots'),process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(()=>planRules(fixture(d)),/OPENMAUSBOT_BOTS_DIR_NOT_INSTALLED|REPARSE_PATH_REFUSED/);
 }finally{rmSync(d,{recursive:true,force:true})}
});
test('official MCP launcher consumes private token only in subprocess environment',()=>{
 const d=mkdtempSync(join(tmpdir(),'omb-launcher-'));try{
  const exe=join(d,'Programs','OpenMausBot.exe'),script=join(d,'Programs','resources','server','mcp-server.js');
  const tok=join(d,'Singularity','OpenMausBot','mcp-session.token');
  mkdirSync(join(d,'Programs','resources','server'),{recursive:true});mkdirSync(join(d,'Singularity','OpenMausBot'),{recursive:true});
  writeFileSync(exe,'fixture');writeFileSync(script,'fixture');writeFileSync(tok,'omb_sess_'+'a'.repeat(40));
  const r=runtimeOptions({LOCALAPPDATA:d,SINGULARITY_OMB_EXE:exe,SINGULARITY_OMB_PORT:'8799'});
  assert.deepEqual(r.args,[script]);assert.equal(r.env.OPENMAUSBOT_URL,'http://127.0.0.1:8799');
  assert.ok(r.env.OPENMAUSBOT_TOKEN.startsWith('omb_sess_'));assert.ok(!JSON.stringify(r.args).includes('omb_sess_'));
  assert.throws(()=>runtimeOptions({LOCALAPPDATA:d,SINGULARITY_OMB_EXE:exe,SINGULARITY_OMB_PORT:'99999'}),/OMB_PORT_INVALID/);
  writeFileSync(tok,'wrong');assert.throws(()=>runtimeOptions({LOCALAPPDATA:d,SINGULARITY_OMB_EXE:exe}),/OMB_TOKEN_INVALID/);
 }finally{rmSync(d,{recursive:true,force:true})}
});
test('Option 2 MCP adds OpenMausBot without secret or duplicate RepoQL, then rolls back',()=>{
 const d=mkdtempSync(join(tmpdir(),'omb-mcp-'));try{
  const ws=join(d,'ws'),bin=join(d,'bin');mkdirSync(ws);mkdirSync(bin);
  const rqlExe=join(bin,'rql.exe'),kanzoExe=join(bin,'kanzo.exe'),ombExe=join(bin,'OpenMausBot.exe'),nodeExe=join(bin,'node.exe');
  for(const f of [rqlExe,kanzoExe,ombExe,nodeExe])writeFileSync(f,'fixture');
  const opts={variant:2,workspace:ws,rqlExe,kanzoExe,ombExe,nodeExe,allowFixture:true};
  const p=buildMcpPlan({...opts,existing:{mcpServers:{foreign:{command:'foreign'}}}});
  assert.deepEqual(p.registered,['kanzo','openmausbot']);
  assert.ok(!('repoql' in p.configuration.mcpServers));
  assert.equal(JSON.stringify(p.configuration).includes('omb_sess_'),false);
  assert.equal(applyProjectMcp(opts).applied,true);
  assert.deepEqual(verifyProjectMcp({variant:2,workspace:ws}).registered,['kanzo','openmausbot']);
  assert.equal(rollbackProjectMcp({workspace:ws}).rolledBack,true);
 }finally{rmSync(d,{recursive:true,force:true})}
});
test('never register missing or foreign OpenMausBot without explicit opt-in',()=>{
 const opts={variant:2,workspace:'C:\\work',rqlExe:'C:\\rql.exe',kanzoExe:'C:\\kanzo.exe',allowFixture:true};
 const p=buildMcpPlan(opts);assert.deepEqual(p.registered,['kanzo']);
 assert.throws(()=>buildMcpPlan({...opts,ombExe:'C:\\Programs\\OpenMausBot.exe'}),/OPENMAUSBOT_REQUIRES_BOTH_EXECUTABLES/);
 assert.throws(()=>buildMcpPlan({...opts,nodeExe:'C:\\node.exe',ombExe:'C:\\Programs\\OpenMausBot.exe',existing:{mcpServers:{openmausbot:{type:'stdio',command:'foreign'}}}}),/FOREIGN_MCP_CONFLICT_openmausbot/);
});
