import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash,createHmac} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {AGENT_MAP} from '../../adapters/claude-code/agent-map.mjs';
import {prepareConfiguration,applyConfiguration,rollbackConfiguration,verifyConfiguration,CLAUDE_SKILLS,renderClaudeSkill,REPOQL_CLAUDE_PLUGIN,REPOQL_PLUGIN_SKILLS,inspectRepoqlSkillAssets,resolveNodeExe,assertPortableNodePath} from './configure_claude_code_windows.mjs';

const cli=fileURLToPath(new URL('./configure_claude_code_windows.mjs',import.meta.url));
function fixture(variant=2) {
  const base=mkdtempSync(join(tmpdir(),'claude-native-m27-'));
  const source=join(base,'source'), home=join(base,'home');
  const nodeExe=join(base,'node.exe'),memoryConfig=join(base,'memory.json'),officeConfig=join(base,'office.json');
  mkdirSync(source);mkdirSync(home);
  const adapter=join(source,'adapters','claude-code');
  mkdirSync(join(adapter,'agents'),{recursive:true});
  for(const [name] of Object.entries(AGENT_MAP)) writeFileSync(join(adapter,'agents',name+'.md'),'# '+name+'\n');
  writeFileSync(join(adapter,'memory-hook.mjs'),'// source memory hook\n');
  writeFileSync(join(adapter,'doc-hook.mjs'),'// source doc hook\n');
  if(variant===2)writeFileSync(join(adapter,'office-hook.mjs'),'// source office hook\n');
  writeFileSync(join(adapter,'singularity-workflow.md'),'# Workflow test rule\n');
  const closure=['agent-map.mjs'].map(n=>'adapters/claude-code/'+n).concat([
    'memory-config-loader.mjs','native-memorycore-reader.mjs','memory-reconcile-core.mjs','doc-policy.mjs','document-learning-rust.mjs',
    'selflearn-candidates.mjs','doc-ingest-node.mjs',
  ].map(n=>'scripts/'+n));
  for(const name of closure) {
    const target=join(source,...name.split('/'));mkdirSync(join(target,'..'),{recursive:true});
    writeFileSync(target,'export const loaded = true;\n');
  }
  const files=['memory-hook.mjs','doc-hook.mjs',...(variant===2?['office-hook.mjs']:[])].map(n=>'adapters/claude-code/'+n)
    .concat(closure,['adapters/claude-code/singularity-workflow.md'], Object.keys(AGENT_MAP).map(n=>'adapters/claude-code/agents/'+n+'.md'));
  const skillList=CLAUDE_SKILLS.filter(n=>variant===2||n!=='claude-office-visual');
  for(const name of skillList){
    const target=join(source,'adapters','claude-code','skills',name,'SKILL.md');
    mkdirSync(join(source,'adapters','claude-code','skills',name),{recursive:true});
    writeFileSync(target,`---\nname: ${name}\ndescription: test\n---\n`);
    files.push('adapters/claude-code/skills/'+name+'/SKILL.md');
  }
  const checks=files.map(name=>({path:name,sha256:createHash('sha256').update(readFileSync(join(source,...name.split('/')))).digest('hex')}));
  writeFileSync(join(source,'NATIVE_WINDOWS_SOURCE_MANIFEST.json'),JSON.stringify({
    variant,gui:'claude-desktop-code',repoql:{requiredVersion:'1.7.18'},
    features:{office:variant===2},files:checks}));
  writeFileSync(nodeExe,'fake-executable-fixture');writeFileSync(memoryConfig,'private-do-not-log');writeFileSync(officeConfig,JSON.stringify({endpoint:'http://127.0.0.1:8000',ingestKey:'do-not-log-office-key'}));
  const config={source,home,nodeExe,memoryConfig,officeConfig,variant};
  return {base,source,home,config,claude:join(home,'.claude'),cleanup(){rmSync(base,{recursive:true,force:true})}};
}
function writeSettings(f,value){mkdirSync(f.claude,{recursive:true});writeFileSync(join(f.claude,'settings.json'),JSON.stringify(value,null,2)+'\n');}
function getSettings(f){return JSON.parse(readFileSync(join(f.claude,'settings.json'),'utf8'));}

test('optional staged Rust document writer is bound to its digest and journal', () => {
  const f=fixture();
  try {
    const dir=join(f.base,'bin'), writer=join(dir,'singularity-memorycore-writer.exe');
    mkdirSync(dir);
    writeFileSync(writer,'fixture native writer');
    const digest=createHash('sha256').update(readFileSync(writer)).digest('hex');
    assert.throws(()=>prepareConfiguration({...f.config,rustDocWriterSha256:'0'.repeat(64)}),
      /RUST_DOC_WRITER_PROVENANCE_MISMATCH/);
    const cfg={...f.config,rustDocWriterSha256:digest};
    applyConfiguration(cfg);
    assert.equal(getSettings(f).env.SINGULARITY_DOC_WRITE_RUST_BIN,writer);
    assert.equal(getSettings(f).env.SINGULARITY_DOC_WRITE_RUST_SHA256,digest);
    assert.equal(verifyConfiguration({home:f.home}).configured,true);
    writeFileSync(writer,'fixture native drift');
    assert.ok(verifyConfiguration({home:f.home}).issues.includes('RUST_DOC_WRITER_DRIFT'));
    rollbackConfiguration({home:f.home});
    assert.equal(existsSync(join(f.claude,'settings.json')),false);
  } finally {f.cleanup()}
});

test('complete Claude option writes four native hooks and 9 agents; reconfiguration requires explicit rollback',()=>{
  const f=fixture();try {
    const p=prepareConfiguration(f.config);
    assert.equal(p.agentWrites.filter(x=>x.create).length,9);
    const a=applyConfiguration(f.config);
    assert.equal(a.state,'CONFIGURED_UNVERIFIED');
    assert.equal(a.agentDefinitions,9);assert.equal(a.newlyCreatedAgents,9);
    assert.equal(a.skillsInstalled,10);
    for(const name of CLAUDE_SKILLS)assert.equal(existsSync(join(f.claude,'skills',name,'SKILL.md')),true);
    assert.equal(a.workflowRuleInstalled,true);
    assert.equal(existsSync(join(f.claude,'rules','singularity-workflow.md')),true);
    const settings=getSettings(f);
    const expectedHookCounts={SubagentStart:1,SubagentStop:2,SessionStart:2,Stop:3};
    for(const event of ['SubagentStart','SubagentStop','SessionStart','Stop']) {
      assert.equal(settings.hooks[event].reduce((n,g)=>n+g.hooks.length,0),expectedHookCounts[event]);
      assert.equal(settings.hooks[event][0].hooks[0].command,f.config.nodeExe);
    }
    const memoryKinds=(event)=>settings.hooks[event].flatMap(g=>g.hooks)
      .filter(h=>h.args?.[0]?.endsWith('memory-hook.mjs')).map(h=>h.args[1]);
    assert.deepEqual(memoryKinds('Stop'),['conversation-turn']);
    assert.deepEqual(memoryKinds('SessionEnd'),['session-end']);
    for(const [event,kind] of Object.entries({SessionStart:'session-start',UserPromptSubmit:'prompt',
      PreToolUse:'pre-tool',PostToolUse:'post-tool',Stop:'stop',SubagentStop:'subagent-stop',SessionEnd:'session-end'})) {
      assert.ok(settings.hooks[event].some(group=>group.hooks.some(h=>h.args?.[1]===kind && h.args?.[0].endsWith('office-hook.mjs'))));
    }
    assert.equal(settings.env.OFFICE_CONFIG,f.config.officeConfig);
    assert.equal(settings.env.SINGULARITY_MEMORY_CONFIG,f.config.memoryConfig);
    assert.throws(()=>applyConfiguration(f.config),/UNRESOLVED_INSTALL_JOURNAL/);
    assert.equal(rollbackConfiguration({home:f.home}).state,'CLAUDE_CONFIGURATION_ROLLED_BACK');
    assert.equal(existsSync(join(f.claude,'settings.json')),false);
    for(const name of Object.keys(AGENT_MAP)) assert.equal(existsSync(join(f.claude,'agents',name+'.md')),false);
    assert.equal(existsSync(join(f.claude,'rules','singularity-workflow.md')),false);
    for(const name of CLAUDE_SKILLS)assert.equal(existsSync(join(f.claude,'skills',name,'SKILL.md')),false);
  }finally{f.cleanup()}
});

test('preserves existing credentials and unrelated hooks through install and exact rollback',()=>{
  const f=fixture(2);try {
    const original={apiKey:'NEVER-PRINT-THIS',env:{UNRELATED:'keep'},hooks:{Stop:[{matcher:'custom',hooks:[{type:'command',command:'other-tool'}]}]}};
    writeSettings(f,original);
    applyConfiguration(f.config);
    const installed=getSettings(f);
    assert.equal(installed.apiKey,original.apiKey);
    assert.ok(installed.hooks.Stop.some(group=>group.hooks.some(h=>h.command==='other-tool')));
    rollbackConfiguration({home:f.home});
    assert.deepEqual(getSettings(f),original);
  }finally{f.cleanup()}
});

test('foreign post-install user edits survive rollback and original matching env keys survive',()=>{
  const f=fixture();try {
    writeSettings(f,{env:{SINGULARITY_REPO_ROOT:f.source,OTHER:'x'},other:'original'});
    applyConfiguration(f.config);
    const settings=getSettings(f);settings.userAdded='after-install';
    writeSettings(f,settings);
    rollbackConfiguration({home:f.home});
    const final=getSettings(f);
    assert.equal(final.userAdded,'after-install');
    assert.equal(final.env.SINGULARITY_REPO_ROOT,f.source);
    assert.equal(final.env.SINGULARITY_MEMORY_CONFIG,undefined);
    assert.equal(final.hooks,undefined);
  }finally{f.cleanup()}
});

test('rejects conflicting agent without changing settings or other agents',()=>{
  const f=fixture();try {
    mkdirSync(join(f.claude,'agents'),{recursive:true});
    writeFileSync(join(f.claude,'agents','singularity-board.md'),'foreign user agent');
    assert.throws(()=>applyConfiguration(f.config),/FOREIGN_AGENT_CONFLICT/);
    assert.equal(existsSync(join(f.claude,'settings.json')),false);
    assert.equal(readFileSync(join(f.claude,'agents','singularity-board.md'),'utf8'),'foreign user agent');
  }finally{f.cleanup()}
});

test('rejects invalid config, wrong version, absent credentials and stale environment',()=>{
  const f=fixture();try {
    rmSync(f.config.memoryConfig);
    assert.throws(()=>prepareConfiguration(f.config),/REQUIRED_LOCAL_RUNTIME_NOT_PRESENT/);
    writeFileSync(f.config.memoryConfig,'fixture');
    writeSettings(f,{env:{SINGULARITY_MEMORY_CONFIG:'/wrong/config'}});
    assert.throws(()=>prepareConfiguration(f.config),/EXISTING_MEMORY_ENV_CONFLICT/);
    writeSettings(f,{});
    const manifestPath=join(f.source,'NATIVE_WINDOWS_SOURCE_MANIFEST.json');
    const m=JSON.parse(readFileSync(manifestPath));m.repoql.requiredVersion='1.7.15';
    writeFileSync(manifestPath,JSON.stringify(m));
    assert.throws(()=>prepareConfiguration(f.config),/WRONG_OR_UNVERIFIED_SOURCE_VARIANT/);
  }finally{f.cleanup()}
});

test('refuses to follow a symbolic agent target, settings or agent directory',(t)=>{
  const f=fixture();try {
    mkdirSync(join(f.claude,'agents'),{recursive:true});
    const foreign=join(f.base,'foreign.txt');writeFileSync(foreign,'secret');
    try { symlinkSync(foreign,join(f.claude,'agents','singularity-board.md')); }
    catch(e) { if (process.platform==='win32' && ['EPERM','EACCES'].includes(e?.code)) {t.skip('Windows symlink privilege unavailable');return;} throw e; }
    assert.throws(()=>prepareConfiguration(f.config),/REPARSE_OR_NON_DIRECTORY_PATH/);
    assert.equal(readFileSync(foreign,'utf8'),'secret');
  }finally{f.cleanup()}
});

test('modified owned agent forces rollback refusal and leaves backup for inspection',()=>{
  const f=fixture();try {
    applyConfiguration(f.config);
    const agent=join(f.claude,'agents','singularity-board.md');
    writeFileSync(agent,'user edited');
    assert.throws(()=>rollbackConfiguration({home:f.home}),/OWNED_AGENT_CHANGED_REFUSE_ROLLBACK/);
    assert.equal(readFileSync(agent,'utf8'),'user edited');
    assert.equal(existsSync(join(f.claude,'.singularity-native-claude-journal.json')),true);
  }finally{f.cleanup()}
});

test('recovers interrupted prepared journal without deleting pre-existing agents',()=>{
  const f=fixture();try {
    const p=prepareConfiguration(f.config);
    mkdirSync(p.claude,{recursive:true});mkdirSync(p.agentsDir,{recursive:true});
    // Simulate abrupt termination after creating one agent and durable journal.
    const a=p.agentWrites[0];writeFileSync(a.target,readFileSync(a.src));
    writeFileSync(p.receiptPath,JSON.stringify({schema:'singularity-claude-native-config/v1',state:'PREPARED',variant:2,
      source:p.source,settingsPath:p.settingsPath,backup:null,beforeSha256:null,afterSha256:p.nextSettingsHash,
      agents:p.agentWrites.map(x=>({path:x.target,sha256:x.sha256})),env:p.newEnv,scriptPath:p.scriptPath}));
    rollbackConfiguration({home:f.home});
    assert.equal(existsSync(a.target),false);
  }finally{f.cleanup()}
});

test('non-Windows CLI refuses actual writes even when --apply supplied and never prints tokens',()=>{
  if(process.platform==='win32')return;
  const f=fixture();try {
    const result=spawnSync(process.execPath,[cli,'--mode','apply','--apply','--variant','2','--source',f.source,'--home',f.home,'--node-exe',f.config.nodeExe,'--memory-config',f.config.memoryConfig,'--office-config',f.config.officeConfig],{encoding:'utf8'});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/WINDOWS_EXPLICIT_APPLY_REQUIRED/);
    assert.doesNotMatch(result.stderr,/private-do-not-log/);
    assert.equal(existsSync(join(f.claude,'settings.json')),false);
  }finally{f.cleanup()}
});


test('foreign matcher on Stop is not reused for an always-on Singularity hook',()=>{
  const f=fixture();try {
    writeSettings(f,{hooks:{Stop:[{matcher:'only-special-context',hooks:[{type:'command',command:'foreign-tool'}]}]}});
    applyConfiguration(f.config);
    const stop=getSettings(f).hooks.Stop;
    assert.equal(stop.length,4);
    assert.equal(stop[0].hooks.length,1);
    assert.equal(stop[0].matcher,'only-special-context');
    assert.equal(stop[1].matcher,undefined);
    assert.equal(stop[1].hooks[0].args[1],'stop');
    assert.equal(stop[2].hooks[0].args[1],'conversation-turn');
  }finally{f.cleanup()}
});

test('malformed settings are rejected without leaking their partial content through CLI',()=>{
  const f=fixture();try {
    mkdirSync(f.claude,{recursive:true});
    const hidden='VERY-PRIVATE-CREDENTIAL-VALUE';
    writeFileSync(join(f.claude,'settings.json'),'{"key":"'+hidden+'" this is invalid');
    const result=spawnSync(process.execPath,[cli,'--mode','plan','--variant','2','--source',f.source,'--home',f.home,'--node-exe',f.config.nodeExe,'--memory-config',f.config.memoryConfig,'--office-config',f.config.officeConfig],{encoding:'utf8'});
    assert.notEqual(result.status,0);
    assert.doesNotMatch(result.stderr, /VERY-PRIVATE-CREDENTIAL-VALUE/);
    assert.doesNotMatch(result.stdout, /VERY-PRIVATE-CREDENTIAL-VALUE/);
  }finally{f.cleanup()}
});


test('modified agent source is rejected when hash differs from staged release manifest',()=>{
  const f=fixture();try {
    writeFileSync(join(f.source,'adapters','claude-code','agents','singularity-board.md'),'tampered');
    assert.throws(()=>prepareConfiguration(f.config),/SOURCE_HASH_PROVENANCE_MISMATCH/);
    assert.equal(existsSync(join(f.claude,'settings.json')),false);
  }finally{f.cleanup()}
});


test('read-only verification detects settings and agent drift and does not claim runtime parity',()=>{
  const f=fixture();try {
    applyConfiguration(f.config);
    let status=verifyConfiguration({home:f.home});
    assert.equal(status.configured,true);
    assert.equal(status.runtimeVerified,false);
    assert.equal(status.officeRuntimeVerified,false);
    const settings=getSettings(f);settings.hooks.Stop=[];writeSettings(f,settings);
    status=verifyConfiguration({home:f.home});
    assert.equal(status.configured,false);
    assert.ok(status.issues.includes('HOOK_STOP_DRIFT'));
    const agent=join(f.claude,'agents','singularity-board.md');
    writeFileSync(agent,'replaced externally');
    status=verifyConfiguration({home:f.home});
    assert.ok(status.issues.includes('AGENT_DEFINITION_DRIFT'));
  }finally{f.cleanup()}
});


test('native installer refuses malformed user hook events and groups without overwriting data',()=>{
  const f=fixture();try {
    const cases=[{hooks:{Stop:{custom:'must survive'}}},
      {hooks:{SessionStart:[{matcher:'startup',hooks:'not-an-array'}]}}];
    for (const original of cases) {
      writeSettings(f,original);
      const before=readFileSync(join(f.claude,'settings.json'),'utf8');
      assert.throws(()=>applyConfiguration(f.config),/INVALID_HOOK_(EVENT|GROUP)_STRUCTURE/);
      assert.equal(readFileSync(join(f.claude,'settings.json'),'utf8'),before);
      assert.equal(existsSync(join(f.claude,'.singularity-native-claude-journal.json')),false);
    }
  }finally{f.cleanup()}
});

test('native installer rejects previously owned hooks hidden behind foreign matcher',()=>{
  const f=fixture();try {
    const script=join(f.source,'adapters','claude-code','doc-hook.mjs');
    const original={hooks:{Stop:[{matcher:'specific-only',hooks:[{
      type:'command',command:f.config.nodeExe,args:[script,'stop']
    }]}]}};
    writeSettings(f,original);
    assert.throws(()=>applyConfiguration(f.config),/MATCHER_BOUND_SINGULARITY_HOOK/);
    assert.deepEqual(getSettings(f),original);
    assert.equal(existsSync(join(f.claude,'.singularity-native-claude-journal.json')),false);
  }finally{f.cleanup()}
});

test('native installer requires executable and MemoryCore configuration paths to be regular files',()=>{
  const f=fixture();try {
    const node=f.config.nodeExe, memory=f.config.memoryConfig;
    const directoryNode=join(f.home,'node.exe');mkdirSync(directoryNode);
    assert.throws(()=>prepareConfiguration({...f.config,nodeExe:directoryNode}),/REQUIRED_LOCAL_RUNTIME_NOT_PRESENT/);
    assert.throws(()=>prepareConfiguration({...f.config,memoryConfig:f.home}),/REQUIRED_LOCAL_RUNTIME_NOT_PRESENT/);
    assert.ok(existsSync(node));assert.ok(existsSync(memory));
    assert.equal(existsSync(join(f.claude,'settings.json')),false);
  }finally{f.cleanup()}
});


test('native installer refuses arbitrary executables even when present as regular files',()=>{
  const f=fixture();try {
    const other=join(f.base,'unrelated.exe');writeFileSync(other,'fixture');
    assert.throws(()=>prepareConfiguration({...f.config,nodeExe:other}),/NODE_EXE_NAME_REQUIRED/);
    assert.equal(existsSync(join(f.claude,'settings.json')),false);
  }finally{f.cleanup()}
});


test('rollback refuses to delete a pre-existing matching hook when user settings changed',()=>{
  const f=fixture(2);try {
    const script=join(f.source,'adapters','claude-code','memory-hook.mjs');
    const old={type:'command',command:f.config.nodeExe,args:[script,'subagent-start']};
    const original={hooks:{SubagentStart:[{hooks:[old]}]},custom:'before-install'};
    writeSettings(f,original);
    const result=applyConfiguration(f.config);
    assert.equal(result.state,'CONFIGURED_UNVERIFIED');
    const updated=getSettings(f);
    updated.userAddedAfterInstall='must survive';
    writeSettings(f,updated);
    const beforeRollback=readFileSync(join(f.claude,'settings.json'),'utf8');
    assert.throws(()=>rollbackConfiguration({home:f.home}),/PREEXISTING_HOOKS_REQUIRE_MANUAL_MERGE/);
    assert.equal(readFileSync(join(f.claude,'settings.json'),'utf8'),beforeRollback);
    assert.equal(existsSync(join(f.claude,'.singularity-native-claude-journal.json')),true);
    assert.equal(getSettings(f).hooks.SubagentStart[0].hooks[0].command,f.config.nodeExe);
  }finally{f.cleanup()}
});


test('rollback refuses to discard recovery receipt if previously-existing settings disappear',()=>{
  const f=fixture();try {
    const original={secret:'never log this',other:'retain'};
    writeSettings(f,original);
    applyConfiguration(f.config);
    rmSync(join(f.claude,'settings.json'));
    assert.throws(()=>rollbackConfiguration({home:f.home}),/USER_SETTINGS_MISSING_MANUAL_RECOVERY_REQUIRED/);
    assert.equal(existsSync(join(f.claude,'.singularity-native-claude-journal.json')),true);
    assert.equal(existsSync(join(f.claude,'agents','singularity-board.md')),true);
    const j=JSON.parse(readFileSync(join(f.claude,'.singularity-native-claude-journal.json')));
    assert.deepEqual(JSON.parse(readFileSync(j.backup)),original);
  } finally {f.cleanup()}
});

test('verification refuses to consider absent agents or modified hook argument vectors as installed',()=>{
  const f=fixture();try {
    applyConfiguration(f.config);
    assert.equal(verifyConfiguration({home:f.home}).configured,true);
    rmSync(join(f.claude,'agents','singularity-board.md'));
    let status=verifyConfiguration({home:f.home});
    assert.equal(status.configured,false);
    assert.ok(status.issues.includes('AGENT_DEFINITION_DRIFT'));
    writeFileSync(join(f.claude,'agents','singularity-board.md'),
      readFileSync(join(f.source,'adapters','claude-code','agents','singularity-board.md')));
    const settings=getSettings(f);
    settings.hooks.Stop[0].hooks[0].args.push('--unexpected');
    writeSettings(f,settings);
    status=verifyConfiguration({home:f.home});
    assert.equal(status.configured,false);
    assert.ok(status.issues.includes('HOOK_STOP_DRIFT'));
  } finally {f.cleanup()}
});

test('verification requires ordinary Node and MemoryCore files, not directories',()=>{
  const f=fixture();try {
    applyConfiguration(f.config);
    rmSync(f.config.memoryConfig);mkdirSync(f.config.memoryConfig);
    rmSync(f.config.nodeExe);mkdirSync(f.config.nodeExe);
    const status=verifyConfiguration({home:f.home});
    assert.equal(status.configured,false);
    assert.ok(status.issues.includes('MEMORY_CONFIG_MISSING_OR_UNSAFE'));
    assert.ok(status.issues.includes('NODE_RUNTIME_MISSING_OR_UNSAFE'));
  } finally {f.cleanup()}
});


test('native installer rejects a missing imported memory/documentation dependency before writing settings',()=>{
  const f=fixture();try {
    rmSync(join(f.source,'scripts','doc-ingest-node.mjs'));
    assert.throws(()=>applyConfiguration(f.config),/SOURCE_HASH_PROVENANCE_MISMATCH/);
    assert.equal(existsSync(join(f.claude,'settings.json')),false);
    assert.equal(existsSync(join(f.claude,'.singularity-native-claude-journal.json')),false);
  } finally {f.cleanup()}
});

test('native Claude workflow rule is verified; tampering blocks rollback',()=>{
  const f=fixture(2);try {
    applyConfiguration(f.config);
    const rule=join(f.claude,'rules','singularity-workflow.md');
    assert.equal(verifyConfiguration({home:f.home}).configured,true);
    writeFileSync(rule,'operator modified rules');
    assert.ok(verifyConfiguration({home:f.home}).issues.includes('WORKFLOW_RULE_DRIFT'));
    assert.throws(()=>rollbackConfiguration({home:f.home}),/OWNED_WORKFLOW_RULE_CHANGED_REFUSE_ROLLBACK/);
    assert.equal(readFileSync(rule,'utf8'),'operator modified rules');
  }finally{f.cleanup()}
});

test('Claude skills are installed with exact source bytes, verify drift, and refuse a foreign skill',()=>{
  const f=fixture();try{
    applyConfiguration(f.config);
    assert.equal(verifyConfiguration({home:f.home}).skillsExpected,10);
    const skill=join(f.claude,'skills','board','SKILL.md');
    writeFileSync(skill,'user-edited skill');
    assert.ok(verifyConfiguration({home:f.home}).issues.includes('SKILL_DEFINITION_DRIFT'));
    assert.throws(()=>rollbackConfiguration({home:f.home}),/OWNED_SKILL_CHANGED_REFUSE_ROLLBACK/);
    assert.equal(readFileSync(skill,'utf8'),'user-edited skill');
  }finally{f.cleanup()}
});
test('Claude lean excludes Office skill, and foreign skill names block installation',()=>{
  const f=fixture(1);try{
    const p=prepareConfiguration(f.config);assert.equal(p.skillWrites.length,9);
    assert.equal(applyConfiguration(f.config).skillsInstalled,9);
    assert.equal(existsSync(join(f.claude,'skills','claude-office-visual','SKILL.md')),false);
    rollbackConfiguration({home:f.home});
    const foreign=join(f.claude,'skills','board');mkdirSync(foreign,{recursive:true});
    writeFileSync(join(foreign,'SKILL.md'),'foreign skill');
    assert.throws(()=>prepareConfiguration(f.config),/FOREIGN_SKILL_CONFLICT/);
  }finally{f.cleanup()}
});

test('skill frontmatter is normalized and Office skill deploy guidance refuses Docker',()=>{
  const source=join(fileURLToPath(new URL('../..',import.meta.url)),'adapters','claude-code','skills','claude-office-visual','SKILL.md');
  const installed=renderClaudeSkill('claude-office-visual',readFileSync(source)).toString('utf8');
  assert.match(installed,/^name: claude-office-visual$/m);
  assert.match(installed,/verified native Windows Claude Office service/);
  assert.doesNotMatch(installed,/Deploy the way the project's office compose file/);
});


test('Option 2 declaratively requests official RepoQL plugin and disables rql auto-bootstrap',()=>{
  const f=fixture(2);try {
    const plan=prepareConfiguration(f.config);
    assert.deepEqual(plan.repoqlPluginOwned,{marketplaceCreated:true,pluginEnableCreated:true});
    const applied=applyConfiguration(f.config);
    assert.equal(applied.repoqlPluginRequested,true);
    assert.equal(applied.repoqlPluginSkillsVerified,false);
    const settings=getSettings(f);
    assert.deepEqual(settings.extraKnownMarketplaces['repoql-plugins'],{
      source:{source:'github',repo:'RepoQL/RepoQL'},autoUpdate:false,
    });
    assert.equal(settings.enabledPlugins[REPOQL_CLAUDE_PLUGIN.id],true);
    assert.equal(settings.env.REPOQL_NO_BOOTSTRAP,'1');
    const offline=verifyConfiguration({home:f.home});
    assert.equal(offline.configured,true);
    assert.equal(offline.repoqlPluginSkillAssets.skillAssetsPresent,false);
    assert.equal(offline.repoqlPluginSkillAssets.present,0);
    assert.equal(offline.repoqlPluginSkillAssets.expected,17);
    rollbackConfiguration({home:f.home});
    assert.equal(existsSync(join(f.claude,'settings.json')),false);
  }finally{f.cleanup()}
});

test('does not overwrite disabled plugin, foreign marketplace or enabled binary bootstrap',()=>{
  for(const prior of [
    {enabledPlugins:{'repoql@repoql-plugins':false}},
    {extraKnownMarketplaces:{'repoql-plugins':{source:{source:'github',repo:'other/repo'}}}},
    {extraKnownMarketplaces:{'repoql-plugins':{source:{source:'github',repo:'RepoQL/RepoQL'},autoUpdate:true}}},
    {env:{REPOQL_NO_BOOTSTRAP:'0'}},
    {env:{REPOQL_NO_BOOTSTRAP:''}},
    {env:{SINGULARITY_MEMORY_CONFIG:''}},
    {env:{SINGULARITY_REPO_ROOT:null}},
  ]) {
    const f=fixture();try {
      writeSettings(f,prior);
      assert.throws(()=>applyConfiguration(f.config),/REPOQL_(MARKETPLACE_CONFLICT|PLUGIN_DISABLED_CONFLICT)|EXISTING_MEMORY_ENV_CONFLICT/);
      assert.deepEqual(getSettings(f),prior);
      assert.equal(existsSync(join(f.claude,'.singularity-native-claude-journal.json')),false);
    }finally{f.cleanup()}
  }
});

test('preserves a compatible preexisting official marketplace, unrelated plugins and user changes',()=>{
  const f=fixture();try {
    const prior={other:'preserved',enabledPlugins:{'foreign@ownmarket':false,'repoql@repoql-plugins':true},
      extraKnownMarketplaces:{'repoql-plugins':{source:{source:'github',repo:'RepoQL/RepoQL'}},
        'ownmarket':{source:{source:'github',repo:'acme/plugins'}}}};
    writeSettings(f,prior);
    const plan=prepareConfiguration(f.config);
    assert.deepEqual(plan.repoqlPluginOwned,{marketplaceCreated:false,pluginEnableCreated:false});
    applyConfiguration(f.config);
    assert.deepEqual(getSettings(f).extraKnownMarketplaces['repoql-plugins'],prior.extraKnownMarketplaces['repoql-plugins']);
    const updated=getSettings(f);updated.userNewSetting='post-install';
    writeSettings(f,updated);
    rollbackConfiguration({home:f.home});
    assert.deepEqual(getSettings(f),{...prior,userNewSetting:'post-install'});
  }finally{f.cleanup()}
});

test('only installer-created official plugin settings are removed on user-edited rollback',()=>{
  const f=fixture();try {
    writeSettings(f,{other:'base'});
    applyConfiguration(f.config);
    const settings=getSettings(f);
    settings.after='preserve';settings.enabledPlugins['another@market']=true;
    settings.extraKnownMarketplaces.another={source:{source:'github',repo:'another/market'}};
    writeSettings(f,settings);
    rollbackConfiguration({home:f.home});
    const result=getSettings(f);
    assert.equal(result.after,'preserve');
    assert.equal(result.other,'base');
    assert.deepEqual(result.enabledPlugins,{'another@market':true});
    assert.deepEqual(result.extraKnownMarketplaces.another,{source:{source:'github',repo:'another/market'}});
    assert.equal(result.env,undefined);
  }finally{f.cleanup()}
});

test('changed installer-owned plugin entry forces safe rollback refusal',()=>{
  const f=fixture();try {
    applyConfiguration(f.config);
    const settings=getSettings(f);settings.enabledPlugins['repoql@repoql-plugins']=false;
    writeSettings(f,settings);
    assert.throws(()=>rollbackConfiguration({home:f.home}),/REPOQL_PLUGIN_SETTINGS_CHANGED_REFUSE_ROLLBACK/);
    assert.equal(existsSync(join(f.claude,'.singularity-native-claude-journal.json')),true);
  }finally{f.cleanup()}
});

test('RepoQL skill cache audit requires each of 17 upstream skill files under owned Claude cache',()=>{
  const f=fixture();try {
    applyConfiguration(f.config);
    const plugin=join(f.claude,'plugins','cache','repoql-plugins','repoql','1.7.12');
    mkdirSync(join(plugin,'.claude-plugin'),{recursive:true});
    writeFileSync(join(plugin,'.claude-plugin','plugin.json'),JSON.stringify({name:'repoql',version:'1.7.12'}));
    for(const name of REPOQL_PLUGIN_SKILLS){
      const dir=join(plugin,'skills',name);mkdirSync(dir,{recursive:true});
      writeFileSync(join(dir,'SKILL.md'),'---\nname: '+name+'\ndescription: reviewed\n---\n\n# '+name);
    }
    const registry=join(f.claude,'plugins','installed_plugins.json');
    writeFileSync(registry,JSON.stringify({version:2,plugins:{'repoql@repoql-plugins':[
      {scope:'user',installPath:plugin,version:'1.7.12'}]}}));
    let assets=inspectRepoqlSkillAssets({home:f.home});
    assert.equal(assets.skillAssetsPresent,true);
    assert.equal(assets.cacheValidated,true);
    assert.equal(assets.pluginVersion,'1.7.12');
    assert.equal(assets.present,17);
    assert.deepEqual(assets.unexpected,[]);
    assert.equal(verifyConfiguration({home:f.home}).repoqlPluginSkillsVerified,false); // GUI still unverified
    rmSync(join(plugin,'skills','flow','SKILL.md'));
    assets=inspectRepoqlSkillAssets({home:f.home});
    assert.equal(assets.skillAssetsPresent,false);
    assert.deepEqual(assets.missing,['flow']);
    assert.ok(assets.issues.includes('PLUGIN_SKILLS_MISSING_OR_INVALID'));
    writeFileSync(join(plugin,'skills','flow','SKILL.md'),'---\nname: wrong-skill\n---\n');
    assets=inspectRepoqlSkillAssets({home:f.home});
    assert.deepEqual(assets.invalid,['flow']);
    writeFileSync(join(plugin,'skills','flow','SKILL.md'),'---\nname: flow\n---\n');
    mkdirSync(join(plugin,'skills','new-upstream-skill'));
    writeFileSync(join(plugin,'skills','new-upstream-skill','SKILL.md'),'---\nname: new-upstream-skill\n---\n');
    assets=inspectRepoqlSkillAssets({home:f.home});
    assert.equal(assets.skillAssetsPresent,false);
    assert.deepEqual(assets.unexpected,['new-upstream-skill']);
    assert.ok(assets.issues.includes('PLUGIN_SKILL_INVENTORY_DRIFT'));
    rmSync(join(plugin,'skills','new-upstream-skill'),{recursive:true});
    writeFileSync(join(plugin,'.claude-plugin','plugin.json'),JSON.stringify({name:'foreign'}));
    assets=inspectRepoqlSkillAssets({home:f.home});
    assert.equal(assets.skillAssetsPresent,false);
    assert.ok(assets.issues.includes('PLUGIN_MANIFEST_MISSING_OR_INVALID'));
    writeFileSync(join(plugin,'.claude-plugin','plugin.json'),JSON.stringify({name:'repoql'}));
    const foreign=join(f.base,'outside-claude');mkdirSync(foreign,{recursive:true});
    writeFileSync(registry,JSON.stringify({version:2,plugins:{'repoql@repoql-plugins':[{scope:'user',installPath:foreign}]}}));
    assert.equal(inspectRepoqlSkillAssets({home:f.home}).pluginRegistered,false);
    const wrong=join(f.claude,'plugins','cache','other-marketplace','repoql','1.0');
    mkdirSync(wrong,{recursive:true});
    writeFileSync(registry,JSON.stringify({version:2,plugins:{'repoql@repoql-plugins':[{scope:'user',installPath:wrong}]}}));
    assert.equal(inspectRepoqlSkillAssets({home:f.home}).pluginRegistered,false);
  }finally{f.cleanup()}
});

test('Option 2 refuses absent or malformed Office config without touching existing settings',()=>{
  const f=fixture(2);try {
    const original={env:{KEEP:'unchanged'},hooks:{Stop:[{hooks:[{type:'command',command:'foreign'}]}]}};
    writeSettings(f,original);
    assert.throws(()=>prepareConfiguration({...f.config,officeConfig:undefined}),/OFFICE_CONFIG_FILE_REQUIRED/);
    for(const value of ['not-json','{}',JSON.stringify({endpoint:'https://user:pass@example.com/a',ingestKey:'SECRET'})]) {
      writeFileSync(f.config.officeConfig,value);
      assert.throws(()=>prepareConfiguration(f.config),/OFFICE_CONFIG_INVALID/);
      assert.deepEqual(getSettings(f),original);
    }
    assert.equal(existsSync(join(f.claude,'.singularity-native-claude-journal.json')),false);
  }finally{f.cleanup()}
});

test('Option 2 preserves all unrelated hooks, verifies Office events and guards altered Office hooks',()=>{
  const f=fixture(2);try {
    const other={type:'command',command:'unrelated',args:['--keep']};
    writeSettings(f,{hooks:{SessionStart:[{matcher:'custom',hooks:[other]}],UserPromptSubmit:[{hooks:[other]}]}});
    applyConfiguration(f.config);
    let status=verifyConfiguration({home:f.home});
    assert.equal(status.configured,true);assert.equal(status.hookEventsExpected,13);
    assert.equal(status.officeEventHooksConfigured,true);assert.equal(status.officeEventHooksVerified,false);
    const settings=getSettings(f);
    assert.deepEqual(settings.hooks.SessionStart[0].hooks,[other]);
    assert.ok(settings.hooks.UserPromptSubmit.some(g=>g.hooks.some(h=>h.command==='unrelated')));
    const hook=settings.hooks.PreToolUse[0].hooks[0];
    hook.args.push('wrong');
    writeSettings(f,settings);
    status=verifyConfiguration({home:f.home});
    assert.equal(status.configured,false);
    assert.ok(status.issues.includes('OFFICE_HOOK_PRETOOLUSE_DRIFT'));
    assert.throws(()=>rollbackConfiguration({home:f.home}),/OFFICE_HOOK_CHANGED_REFUSE_ROLLBACK|PREEXISTING_HOOKS_REQUIRE_MANUAL_MERGE|SETTINGS_CHANGED/);
  }finally{f.cleanup()}
});

test('rollback after user edits removes installer-owned Office hooks but preserves foreign hooks',()=>{
  const f=fixture(2);try {
    writeSettings(f,{hooks:{Stop:[{hooks:[{type:'command',command:'foreign-stop'}]}]},other:'before'});
    applyConfiguration(f.config);
    const settings=getSettings(f);
    settings.other='after';
    settings.hooks.SessionEnd.push({hooks:[{type:'command',command:'user-session-end'}]});
    writeSettings(f,settings);
    rollbackConfiguration({home:f.home});
    const restored=getSettings(f);
    assert.equal(restored.other,'after');
    assert.equal(restored.env,undefined);
    assert.deepEqual(restored.hooks.Stop,[{hooks:[{type:'command',command:'foreign-stop'}]}]);
    assert.deepEqual(restored.hooks.SessionEnd,[{hooks:[{type:'command',command:'user-session-end'}]}]);
  }finally{f.cleanup()}
});

test('preexisting matching Office hook cannot be silently removed during user-edited rollback',()=>{
  const f=fixture(2);try {
    const script=join(f.source,'adapters','claude-code','office-hook.mjs');
    const original={hooks:{SessionEnd:[{hooks:[{type:'command',command:f.config.nodeExe,args:[script,'session-end']}]}]}};
    writeSettings(f,original);
    applyConfiguration(f.config);
    const changed=getSettings(f);changed.after='operator';writeSettings(f,changed);
    assert.throws(()=>rollbackConfiguration({home:f.home}),/PREEXISTING_HOOKS_REQUIRE_MANUAL_MERGE/);
    assert.equal(getSettings(f).after,'operator');
  }finally{f.cleanup()}
});

test('Option 1 has no Office config dependency or Office events',()=>{
  const f=fixture(1);try {
    assert.equal(prepareConfiguration(f.config).variant,1);
    applyConfiguration(f.config);
    const status=verifyConfiguration({home:f.home});
    assert.equal(status.configured,true);
    assert.equal(status.hookEventsExpected,6);
    assert.equal(getSettings(f).env.OFFICE_CONFIG,undefined);
    assert.equal(getSettings(f).hooks.UserPromptSubmit,undefined);
  }finally{f.cleanup()}
});


test('Option 2 verification detects a corrupted Office config while preserving its existing bytes',()=>{
  const f=fixture(2);try {
    applyConfiguration(f.config);
    writeFileSync(f.config.officeConfig,'INVALID-SENSITIVE-DATA');
    const status=verifyConfiguration({home:f.home});
    assert.equal(status.configured,false);
    assert.ok(status.issues.includes('OFFICE_CONFIG_DRIFT'));
    assert.equal(readFileSync(f.config.officeConfig,'utf8'),'INVALID-SENSITIVE-DATA');
  }finally{f.cleanup()}
});

test('Claude settings rollback cleans only hash-verified journal-owned pending temp',()=>{
 const f=fixture();try{
  writeSettings(f,{apiKey:'sensitive-foreign-key'});
  const old=readFileSync(join(f.claude,'settings.json'));
  applyConfiguration(f.config);
  const settings=join(f.claude,'settings.json'),receipt=join(f.claude,'.singularity-native-claude-journal.json');
  const r=JSON.parse(readFileSync(receipt)),after=readFileSync(settings);
  writeFileSync(r.pendingSettingsTmp,after);writeFileSync(settings,old);
  rollbackConfiguration({home:f.home});
  assert.equal(Buffer.compare(readFileSync(settings),old),0);
  assert.equal(existsSync(r.pendingSettingsTmp),false);
  assert.equal(existsSync(receipt),false);
 }finally{f.cleanup()}
});
test('Claude rollback recovers PREPARED journal before backup was created',()=>{
 const f=fixture();try{
  writeSettings(f,{apiKey:'foreign-keep'});
  const settings=join(f.claude,'settings.json'),before=readFileSync(settings);
  applyConfiguration(f.config);
  const receipt=join(f.claude,'.singularity-native-claude-journal.json');
  const r=JSON.parse(readFileSync(receipt));r.state='PREPARED';
  writeFileSync(receipt,JSON.stringify(r));writeFileSync(settings,before);
  rmSync(r.backup);
  assert.equal(rollbackConfiguration({home:f.home}).state,'CLAUDE_CONFIGURATION_ROLLED_BACK');
  assert.equal(Buffer.compare(readFileSync(settings),before),0);
  assert.equal(existsSync(receipt),false);
 }finally{f.cleanup()}
});
test('Claude rollback refuses changed temporary settings and retains receipt',()=>{
 const f=fixture();try{
  applyConfiguration(f.config);
  const receipt=join(f.claude,'.singularity-native-claude-journal.json');
  const r=JSON.parse(readFileSync(receipt));writeFileSync(r.pendingSettingsTmp,'not-what-was-written');
  assert.throws(()=>rollbackConfiguration({home:f.home}),/JOURNAL_PENDING_SETTINGS_CHANGED/);
  assert.equal(existsSync(receipt),true);
  assert.throws(()=>verifyConfiguration({home:f.home}),/JOURNAL_PENDING_SETTINGS_CHANGED/);
 }finally{f.cleanup()}
});

test('resumes cleanup after user-edited settings were already merged during interrupted rollback',()=>{
 const f=fixture();try{
  writeSettings(f,{apiKey:'do-not-print-original',env:{OTHER:'x'}});
  applyConfiguration(f.config);
  const settings=join(f.claude,'settings.json'),receipt=join(f.claude,'.singularity-native-claude-journal.json');
  const journal=JSON.parse(readFileSync(receipt)),backupBytes=readFileSync(journal.backup);
  const edited=getSettings(f);edited.userAdded='preserved';writeSettings(f,edited);
  const editedBytes=readFileSync(settings);
  rollbackConfiguration({home:f.home});
  const cleanBytes=readFileSync(settings);
  journal.rollbackMerge={beforeSha:createHash('sha256').update(editedBytes).digest('hex'),
    afterSha:createHash('sha256').update(cleanBytes).digest('hex'),
    tmp:settings+'.merge-11111111-1111-4111-8111-111111111111'};
  writeFileSync(receipt,JSON.stringify(journal));writeFileSync(journal.backup,backupBytes);
  assert.equal(rollbackConfiguration({home:f.home}).state,'CLAUDE_CONFIGURATION_ROLLED_BACK');
  assert.equal(readFileSync(settings,'utf8'),cleanBytes.toString('utf8'));
  assert.equal(getSettings(f).userAdded,'preserved');
 }finally{f.cleanup()}
});
test('resumes interrupted Claude rollback merge from receipt-owned temp and refuses drift',()=>{
 const f=fixture();try{
  writeSettings(f,{apiKey:'secret-original'});applyConfiguration(f.config);
  const settings=join(f.claude,'settings.json'),receipt=join(f.claude,'.singularity-native-claude-journal.json');
  const journal=JSON.parse(readFileSync(receipt)),backup=readFileSync(journal.backup);
  const edited=getSettings(f);edited.userAdded='keep-this';writeSettings(f,edited);const editedBytes=readFileSync(settings);
  rollbackConfiguration({home:f.home});const cleaned=readFileSync(settings);
  // Recreate the exact post-crash state: owned agent files already cleaned is
  // harmless; pending merged settings exist while original edited bytes remain.
  const pending=settings+'.merge-11111111-1111-4111-8111-111111111111';
  journal.rollbackMerge={beforeSha:createHash('sha256').update(editedBytes).digest('hex'),
    afterSha:createHash('sha256').update(cleaned).digest('hex'),tmp:pending};
  writeFileSync(journal.backup,backup);writeFileSync(receipt,JSON.stringify(journal));
  writeFileSync(settings,editedBytes);writeFileSync(pending,'malicious-drift');
  assert.throws(()=>rollbackConfiguration({home:f.home}),/CLAUDE_ROLLBACK_MERGE_TEMP_CHANGED/);
  writeFileSync(pending,cleaned);
  assert.equal(rollbackConfiguration({home:f.home}).state,'CLAUDE_CONFIGURATION_ROLLED_BACK');
  assert.equal(readFileSync(settings,'utf8'),cleaned.toString('utf8'));
  assert.equal(existsSync(pending),false);
 }finally{f.cleanup()}
});

test('resumes unchanged-settings rollback from a receipt-owned restore temporary file',()=>{
 const f=fixture();try{
  writeSettings(f,{apiKey:'private-original',misc:{kept:true}});
  applyConfiguration(f.config);
  const settings=join(f.claude,'settings.json'),receipt=join(f.claude,'.singularity-native-claude-journal.json');
  const journal=JSON.parse(readFileSync(receipt)),installed=readFileSync(settings),backup=readFileSync(journal.backup);
  const restore=settings+'.restore-11111111-1111-4111-8111-111111111111';
  journal.rollbackRestore={fromSha:journal.afterSha256,toSha:journal.beforeSha256,tmp:restore};
  writeFileSync(receipt,JSON.stringify(journal));writeFileSync(restore,backup);
  assert.equal(rollbackConfiguration({home:f.home}).state,'CLAUDE_CONFIGURATION_ROLLED_BACK');
  assert.equal(Buffer.compare(readFileSync(settings),backup),0);
  assert.equal(existsSync(restore),false);
  assert.equal(existsSync(receipt),false);
  assert.notEqual(Buffer.compare(installed,backup),0);
 }finally{f.cleanup()}
});

test('node hooks resolve the bootstrap runtime, then PATH, and reject machine-local tools copies',{skip:process.platform!=='win32'?'win32 node.exe PATH resolution is Windows-only; the LOCALAPPDATA branch is covered separately':false},()=>{
 const base=mkdtempSync(join(tmpdir(),'claude-native-node-'));
 try{
  const runtime=join(base,'Singularity','runtime','node-v24.22.2');mkdirSync(runtime,{recursive:true});
  const runtimeNode=join(runtime,'node.exe');writeFileSync(runtimeNode,'fixture');
  const pins=join(base,'runtime-pins.json');writeFileSync(pins,JSON.stringify({node:{version:'24.22.2'}}));
  assert.equal(resolveNodeExe({localAppData:base,pinsPath:pins,pathEnv:''}),runtimeNode);
  assert.throws(()=>assertPortableNodePath('C:\\Users\\example\\tools\\node22\\node.exe'),/HARDCODED_NODE_TOOL_PATH/);
  assert.doesNotThrow(()=>assertPortableNodePath(runtimeNode));
  const pathDir=join(base,'path-node');mkdirSync(pathDir);const pathNode=join(pathDir,'node.exe');writeFileSync(pathNode,'fixture');
  assert.equal(resolveNodeExe({localAppData:join(base,'empty'),pinsPath:pins,pathEnv:pathDir}),pathNode);
  assert.throws(()=>resolveNodeExe({localAppData:join(base,'empty'),pinsPath:pins,pathEnv:''}),/NODE_RUNTIME_NOT_FOUND/);
  const f=fixture(2);try{
   const settings=JSON.parse(prepareConfiguration({...f.config,nodeExe:runtimeNode}).nextSettings);
   const commands=Object.values(settings.hooks||{}).flatMap(groups=>groups.flatMap(group=>group.hooks.map(h=>h.command)));
   assert.ok(commands.length>0);
   for(const command of commands){
    assert.equal(command,runtimeNode);
    assert.ok(!/^[A-Za-z]:\\Users\\[^\\]+\\tools\\/i.test(command),command);
   }
   assert.throws(()=>prepareConfiguration({...f.config,nodeExe:'C:\\Users\\example\\tools\\node22\\node.exe'}),/HARDCODED_NODE_TOOL_PATH/);
  }finally{f.cleanup()}
 }finally{rmSync(base,{recursive:true,force:true})}
});

test('CLI plan resolves Node from LOCALAPPDATA when --node-exe is omitted',()=>{
 const f=fixture(2),base=mkdtempSync(join(tmpdir(),'claude-native-cli-node-'));
 try{
  const runtime=join(base,'Singularity','runtime','node-v24.22.2');mkdirSync(runtime,{recursive:true});
  writeFileSync(join(runtime,'node.exe'),'fixture');
  const result=spawnSync(process.execPath,[cli,'--mode','plan','--variant','2','--source',f.source,'--home',f.home,'--memory-config',f.config.memoryConfig,'--office-config',f.config.officeConfig],{encoding:'utf8',env:{...process.env,LOCALAPPDATA:base,PATH:''}});
  assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(result.stdout).state,'CLAUDE_CONFIGURATION_PLAN_ONLY');
 }finally{f.cleanup();rmSync(base,{recursive:true,force:true})}
});

test('resumes unchanged-settings rollback after restore rename and refuses a tampered temp',()=>{
 const f=fixture();try{
  writeSettings(f,{apiKey:'secret-original'});
  applyConfiguration(f.config);
  const settings=join(f.claude,'settings.json'),receipt=join(f.claude,'.singularity-native-claude-journal.json');
  const journal=JSON.parse(readFileSync(receipt)),backup=readFileSync(journal.backup);
  const restore=settings+'.restore-11111111-1111-4111-8111-111111111111';
  journal.rollbackRestore={fromSha:journal.afterSha256,toSha:journal.beforeSha256,tmp:restore};
  writeFileSync(receipt,JSON.stringify(journal));
  writeFileSync(restore,'tampered-config-with-credential');
  assert.throws(()=>rollbackConfiguration({home:f.home}),/CLAUDE_ROLLBACK_RESTORE_TEMP_CHANGED/);
  assert.equal(existsSync(receipt),true);
  rmSync(restore);writeFileSync(settings,backup);
  assert.equal(rollbackConfiguration({home:f.home}).state,'CLAUDE_CONFIGURATION_ROLLED_BACK');
  assert.equal(existsSync(receipt),false);
  assert.equal(Buffer.compare(readFileSync(settings),backup),0);
 }finally{f.cleanup()}
});

test('refuses post-restore user settings drift while keeping journal and backup',()=>{
 const f=fixture();try{
  writeSettings(f,{apiKey:'original-secret'});
  applyConfiguration(f.config);
  const settings=join(f.claude,'settings.json'),receipt=join(f.claude,'.singularity-native-claude-journal.json');
  const journal=JSON.parse(readFileSync(receipt));
  const restore=settings+'.restore-11111111-1111-4111-8111-111111111111';
  journal.rollbackRestore={fromSha:journal.afterSha256,toSha:journal.beforeSha256,tmp:restore};
  writeFileSync(receipt,JSON.stringify(journal));
  const foreign={apiKey:'original-secret',laterSetting:'keep-foreign-change'};
  writeSettings(f,foreign);
  assert.throws(()=>rollbackConfiguration({home:f.home}),/CLAUDE_ROLLBACK_RESTORE_SETTINGS_CHANGED/);
  assert.deepEqual(getSettings(f),foreign);
  assert.equal(existsSync(journal.backup),true);
  assert.equal(existsSync(receipt),true);
 }finally{f.cleanup()}
});

test('parent conversation capture is bound to Stop and SessionEnd and removed on user-edited rollback',()=>{
 const f=fixture(2);try{
  writeSettings(f,{hooks:{Stop:[{hooks:[{type:'command',command:'user-stop'}]}],SessionEnd:[{hooks:[{type:'command',command:'user-end'}]}]}});
  applyConfiguration(f.config);
  const installed=getSettings(f);
  const kinds=(event)=>installed.hooks[event].flatMap(g=>g.hooks)
    .filter(h=>h.args?.[0]?.endsWith('memory-hook.mjs')).map(h=>h.args[1]);
  assert.deepEqual(kinds('Stop'),['conversation-turn']);
  assert.deepEqual(kinds('SessionEnd'),['session-end']);
  const status=verifyConfiguration({home:f.home});
  assert.equal(status.configured,true);
  installed.userAdded='keep-after-install';writeSettings(f,installed);
  rollbackConfiguration({home:f.home});
  const final=getSettings(f);
  assert.equal(final.userAdded,'keep-after-install');
  const ownedMemory=(event)=>(final.hooks?.[event]||[]).some(g=>g.hooks.some(h=>h.args?.[0]?.endsWith('memory-hook.mjs')));
  assert.equal(ownedMemory('Stop'),false,'parent conversation hook removed from Stop');
  assert.equal(ownedMemory('SessionEnd'),false,'parent conversation hook removed from SessionEnd');
  assert.ok(final.hooks.Stop.some(g=>g.hooks.some(h=>h.command==='user-stop')),'user Stop hook preserved');
  assert.ok(final.hooks.SessionEnd.some(g=>g.hooks.some(h=>h.command==='user-end')),'user SessionEnd hook preserved');
 }finally{f.cleanup()}
});

test('verification detects missing parent conversation capture hooks',()=>{
 const f=fixture(1);try{
  applyConfiguration(f.config);
  let settings=getSettings(f);
  settings.hooks.Stop=settings.hooks.Stop.filter(g=>!g.hooks.some(h=>h.args?.[1]==='conversation-turn'));
  writeSettings(f,settings);
  let status=verifyConfiguration({home:f.home});
  assert.equal(status.configured,false);
  assert.ok(status.issues.includes('HOOK_STOP_CONVERSATION_TURN_DRIFT'));
  assert.equal(status.issues.includes('HOOK_STOP_DRIFT'),false,'doc closeout hook is still intact');
  settings=getSettings(f);
  delete settings.hooks.SessionEnd;
  writeSettings(f,settings);
  status=verifyConfiguration({home:f.home});
  assert.ok(status.issues.includes('HOOK_SESSIONEND_DRIFT'));
 }finally{f.cleanup()}
});

// fleet#993 parent-memory-proxy suite: the parent-session memory routing is part
// of the supported Configure flow, so its default, opt-out, refusal, idempotence
// and rollback ownership each need to be exercised against the real settings.
const PROXY_URL='http://127.0.0.1:8096/claude-code/default';
const JOURNAL='.singularity-native-claude-journal.json';
const PROXY_RECEIPT_FILE='.singularity-parent-memory-proxy-receipt.json';
function readJournal(f){return JSON.parse(readFileSync(join(f.claude,JOURNAL),'utf8'));}
// Mirrors configure_parent_memory_proxy.mjs: salted HMAC-SHA256(salt, token) in the
// APPLIED receipt, so a consumer can prove the token on disk is still the one the
// helper installed without either side storing or logging it.
function bindingFor(salt,token){return createHmac('sha256',Buffer.from(salt,'hex')).update(token,'utf8').digest('hex');}
function writeProxyReceipt(f,token,{bind=true,salt='ab'.repeat(16),settingsPath=join(f.claude,'settings.json'),afterSha=null}={}){
  const rec={schema:'singularity-option2-parent-proxy/v1',state:'APPLIED',settings:settingsPath,
    afterSha:afterSha ?? createHash('sha256').update(readFileSync(join(f.claude,'settings.json'))).digest('hex')};
  if(bind){rec.credentialSalt=salt;rec.credentialBinding=bindingFor(salt,token);}
  writeFileSync(join(f.claude,PROXY_RECEIPT_FILE),JSON.stringify(rec));
  return rec;
}

test('variant 2 refuses the parent proxy without credential provenance and mutates nothing',()=>{
  const f=fixture();try{
    // An unrelated provider credential must never be reinterpreted as proxy auth.
    writeSettings(f,{env:{ANTHROPIC_AUTH_TOKEN:'unrelated-provider-token'}});
    const p=prepareConfiguration(f.config);
    assert.equal(p.parentProxy.enabled,true);
    assert.equal(p.parentProxy.configured,false);
    assert.equal(p.parentProxy.mode,'refused-auth-provenance');
    assert.equal(p.parentProxy.authPresent,true);
    assert.equal(p.parentProxy.authProvenanceVerified,false);
    assert.match(p.parentProxy.reasons.join(' '),/PARENT_PROXY_AUTH_PROVENANCE_REQUIRED/);
    assert.match(p.parentProxy.action,/configure_parent_memory_proxy\.mjs/);
    assert.deepEqual(p.parentProxy.envWritten,{});
    const a=applyConfiguration(f.config);
    assert.equal(a.parentProxyConfigured,false);
    assert.equal(a.parentProxyAuthRequired,true);
    assert.equal(a.parentProxyVerified,false);
    const settings=getSettings(f);
    assert.equal(settings.env.ANTHROPIC_BASE_URL,undefined);
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN,'unrelated-provider-token');
    assert.equal(readJournal(f).parentMemory,undefined);
  }finally{f.cleanup();}
});

test('helper-owned credential provenance is adopted without writing a credential',()=>{
  const f=fixture();try{
    writeSettings(f,{env:{ANTHROPIC_BASE_URL:PROXY_URL,ANTHROPIC_AUTH_TOKEN:'helper-owned-token',ANTHROPIC_MODEL:'helper-model'}});
    writeProxyReceipt(f,'helper-owned-token');
    const p=prepareConfiguration(f.config);
    assert.equal(p.parentProxy.configured,true);
    assert.equal(p.parentProxy.mode,'verified-existing');
    assert.equal(p.parentProxy.alreadyOwned,true);
    assert.equal(p.parentProxy.authPresent,true);
    assert.equal(p.parentProxy.authProvenanceVerified,true);
    assert.equal(p.parentProxy.provenanceBasis,'credential-binding');
    assert.deepEqual(p.parentProxy.envWritten,{});
    const a=applyConfiguration(f.config);
    assert.equal(a.parentProxyConfigured,true);
    assert.equal(a.parentProxyAuthProvenanceVerified,true);
    assert.equal(a.parentProxyAuthRequired,false);
    assert.equal(a.parentProxyVerified,false);
    assert.equal(a.liveMemoryRecallVerified,false);
    const settings=getSettings(f);
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN,'helper-owned-token');
    assert.equal(settings.env.ANTHROPIC_BASE_URL,PROXY_URL);
    // The credential value never reaches the journal.
    assert.equal(JSON.stringify(readJournal(f)).includes('helper-owned-token'),false);
  }finally{f.cleanup();}
});

test('explicit parent-memory-proxy opt-out leaves provider routing untouched',()=>{
  const f=fixture();try{
    writeSettings(f,{env:{KEEP:'yes'}});
    const config={...f.config,parentMemoryProxy:false};
    const p=prepareConfiguration(config);
    assert.equal(p.parentProxy.enabled,false);
    assert.equal(p.parentProxy.configured,false);
    assert.deepEqual(p.parentProxy.envWritten,{});
    const a=applyConfiguration(config);
    assert.equal(a.parentProxyConfigured,false);
    assert.equal(getSettings(f).env.ANTHROPIC_BASE_URL,undefined);
    assert.equal(readJournal(f).parentMemory,undefined);
  }finally{f.cleanup();}
});

test('a foreign provider configuration is refused without rewriting it',()=>{
  const f=fixture();try{
    writeSettings(f,{env:{ANTHROPIC_BASE_URL:'https://api.anthropic.com',ANTHROPIC_API_KEY:'user-owned-key'}});
    const p=prepareConfiguration(f.config);
    assert.equal(p.parentProxy.configured,false);
    assert.equal(p.parentProxy.mode,'refused-conflict');
    assert.match(p.parentProxy.reasons.join(' '),/another endpoint/);
    const a=applyConfiguration(f.config);
    assert.equal(a.parentProxyConfigured,false);
    assert.equal(a.parentProxyRefused,true);
    const settings=getSettings(f);
    assert.equal(settings.env.ANTHROPIC_BASE_URL,'https://api.anthropic.com');
    assert.equal(settings.env.ANTHROPIC_API_KEY,'user-owned-key');
    assert.equal(readJournal(f).parentMemory,undefined);
  }finally{f.cleanup();}
});

test('repeating Configure against a helper-owned parent proxy is idempotent',()=>{
  const f=fixture();try{
    writeSettings(f,{env:{ANTHROPIC_BASE_URL:PROXY_URL,ANTHROPIC_AUTH_TOKEN:'helper-owned-token'}});
    writeProxyReceipt(f,'helper-owned-token');
    const p1=prepareConfiguration(f.config);
    assert.equal(p1.parentProxy.alreadyOwned,true);
    assert.equal(p1.parentProxy.mode,'verified-existing');
    assert.equal(p1.parentProxy.authProvenanceVerified,true);
    assert.deepEqual(p1.parentProxy.envWritten,{});
    const p2=prepareConfiguration(f.config);
    assert.equal(p2.nextSettingsHash,p1.nextSettingsHash);
    assert.deepEqual(p2.parentProxy,p1.parentProxy);
  }finally{f.cleanup();}
});

test('settings written after the helper ran do not invalidate the adopted proxy credential',()=>{
  // Any later settings write - Configure's own hooks, the operator's editor, a
  // Claude Code update - changes the file the helper's receipt digest describes.
  // The credential is still the helper's and still routes to our proxy, so the
  // next Configure must accept it instead of demanding a credential it already has.
  const f=fixture();try{
    writeSettings(f,{env:{ANTHROPIC_BASE_URL:PROXY_URL,ANTHROPIC_AUTH_TOKEN:'helper-owned-token'}});
    writeProxyReceipt(f,'helper-owned-token');
    // An unrelated component writes settings afterwards.
    const drifted=getSettings(f);
    drifted.hooks={...(drifted.hooks||{}),Stop:[{hooks:[{type:'command',command:'node',args:['other-tool.mjs']}]}]};
    writeSettings(f,drifted);
    const p=prepareConfiguration(f.config);
    assert.equal(p.parentProxy.mode,'verified-existing');
    assert.equal(p.parentProxy.configured,true);
    assert.equal(p.parentProxy.authProvenanceVerified,true);
    assert.equal(p.parentProxy.provenanceBasis,'credential-binding');
    assert.equal(p.parentProxy.authPresent,true);
    const a=applyConfiguration(f.config);
    assert.equal(a.parentProxyConfigured,true);
    assert.equal(a.parentProxyAuthRequired,false);
    const settings=getSettings(f);
    assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN,'helper-owned-token');
    assert.equal(settings.env.ANTHROPIC_BASE_URL,PROXY_URL);
  }finally{f.cleanup();}
});

test('a receipt that does not name this settings file still refuses without provenance',()=>{
  const f=fixture();try{
    writeSettings(f,{env:{ANTHROPIC_BASE_URL:PROXY_URL,ANTHROPIC_AUTH_TOKEN:'helper-owned-token'}});
    const salt='ab'.repeat(16);
    writeFileSync(join(f.claude,PROXY_RECEIPT_FILE),JSON.stringify({
      schema:'singularity-option2-parent-proxy/v1',state:'APPLIED',
      settings:join(f.home,'somewhere-else','settings.json'),
      afterSha:'0'.repeat(64),credentialSalt:salt,
      credentialBinding:bindingFor(salt,'helper-owned-token')}));
    const p=prepareConfiguration(f.config);
    assert.equal(p.parentProxy.mode,'refused-auth-provenance');
    assert.equal(p.parentProxy.authProvenanceVerified,false);
    assert.match(p.parentProxy.reasons.join(' '),/PARENT_PROXY_RECEIPT_ABSENT/);
    assert.deepEqual(p.parentProxy.envWritten,{});
  }finally{f.cleanup();}
});

test('a replaced token with an otherwise genuine helper receipt is refused, not adopted',()=>{
  // The proxy URL, model and helper receipt all survive; only the credential was
  // swapped for a placeholder or another provider's token. Assuming "the route is
  // ours, so the token must be ours" is exactly what the binding forbids.
  const f=fixture();try{
    writeSettings(f,{env:{ANTHROPIC_BASE_URL:PROXY_URL,ANTHROPIC_AUTH_TOKEN:'helper-installed-token',ANTHROPIC_MODEL:'helper-model'}});
    writeProxyReceipt(f,'helper-installed-token');
    const replaced=getSettings(f);
    replaced.env.ANTHROPIC_AUTH_TOKEN='sk-placeholder-not-the-helper-token';
    writeSettings(f,replaced);
    const p=prepareConfiguration(f.config);
    assert.equal(p.parentProxy.mode,'refused-auth-provenance');
    assert.equal(p.parentProxy.configured,false);
    assert.equal(p.parentProxy.authPresent,true);
    assert.equal(p.parentProxy.authProvenanceVerified,false);
    assert.equal(p.parentProxy.provenanceBasis,null);
    assert.match(p.parentProxy.reasons.join(' '),/PARENT_PROXY_CREDENTIAL_BINDING_MISMATCH/);
    assert.match(p.parentProxy.action,/configure_parent_memory_proxy\.mjs/);
    assert.deepEqual(p.parentProxy.envWritten,{});
    const a=applyConfiguration(f.config);
    assert.equal(a.parentProxyConfigured,false);
    assert.equal(a.parentProxyAuthProvenanceVerified,false);
    assert.equal(a.parentProxyAuthProvenanceBasis,null);
    assert.equal(a.parentProxyAuthRequired,true);
    assert.equal(a.parentProxyVerified,false);
    // Routing and the operator's replaced token are left exactly as found.
    const s=getSettings(f);
    assert.equal(s.env.ANTHROPIC_AUTH_TOKEN,'sk-placeholder-not-the-helper-token');
    assert.equal(s.env.ANTHROPIC_BASE_URL,PROXY_URL);
    assert.equal(s.env.ANTHROPIC_MODEL,'helper-model');
    assert.equal(readJournal(f).parentMemory,undefined);
    // Neither the token, the salt nor the binding reaches the report or the journal.
    const written=JSON.stringify(a)+JSON.stringify(readJournal(f));
    assert.equal(written.includes('sk-placeholder-not-the-helper-token'),false);
    assert.equal(written.includes('helper-installed-token'),false);
    assert.equal(written.includes(bindingFor('ab'.repeat(16),'helper-installed-token')),false);
  }finally{f.cleanup();}
});

test('hook-only settings edits still adopt the bound credential on the next Configure',()=>{
  // Configure itself, Claude Code and the operator write hooks after the helper
  // ran. Those edits leave the credential untouched, so they must not turn the
  // operator's own installed token into a refusal.
  const f=fixture();try{
    writeSettings(f,{env:{ANTHROPIC_BASE_URL:PROXY_URL,ANTHROPIC_AUTH_TOKEN:'helper-owned-token'}});
    writeProxyReceipt(f,'helper-owned-token');
    const drift=getSettings(f);
    drift.hooks={...(drift.hooks||{}),Stop:[{hooks:[{type:'command',command:'node',args:['after-configure.mjs']}]}]};
    writeSettings(f,drift);
    const p=prepareConfiguration(f.config);
    assert.equal(p.parentProxy.mode,'verified-existing');
    assert.equal(p.parentProxy.configured,true);
    assert.equal(p.parentProxy.authProvenanceVerified,true);
    assert.equal(p.parentProxy.provenanceBasis,'credential-binding');
    assert.deepEqual(p.parentProxy.envWritten,{});
    const a=applyConfiguration(f.config);
    assert.equal(a.parentProxyConfigured,true);
    assert.equal(a.parentProxyAuthRequired,false);
    assert.equal(a.parentProxyAuthProvenanceBasis,'credential-binding');
    const s=getSettings(f);
    assert.equal(s.env.ANTHROPIC_AUTH_TOKEN,'helper-owned-token');
    assert.equal(s.env.ANTHROPIC_BASE_URL,PROXY_URL);
  }finally{f.cleanup();}
});

test('an unbound legacy receipt is trusted only while settings are byte-identical',()=>{
  const f=fixture();try{
    writeSettings(f,{env:{ANTHROPIC_BASE_URL:PROXY_URL,ANTHROPIC_AUTH_TOKEN:'helper-owned-token'}});
    writeProxyReceipt(f,'helper-owned-token',{bind:false});
    const p=prepareConfiguration(f.config);
    assert.equal(p.parentProxy.mode,'verified-existing');
    assert.equal(p.parentProxy.authProvenanceVerified,true);
    // The weaker basis is reported, never presented as a binding.
    assert.equal(p.parentProxy.provenanceBasis,'legacy-receipt-exact-digest');
    const drift=getSettings(f);
    drift.hooks={...(drift.hooks||{}),Stop:[{hooks:[{type:'command',command:'node',args:['other.mjs']}]}]};
    writeSettings(f,drift);
    const q=prepareConfiguration(f.config);
    assert.equal(q.parentProxy.mode,'refused-auth-provenance');
    assert.equal(q.parentProxy.authProvenanceVerified,false);
    assert.equal(q.parentProxy.provenanceBasis,null);
    assert.match(q.parentProxy.reasons.join(' '),/PARENT_PROXY_RECEIPT_UNBOUND_AND_SETTINGS_DRIFTED/);
  }finally{f.cleanup();}
});

test('rollback removes only the parent-proxy keys Configure wrote and preserves later user edits',()=>{
  const f=fixture();try{
    writeSettings(f,{env:{KEEP:'yes'}});
    applyConfiguration(f.config);
    const edited=getSettings(f);
    edited.userNewSetting='post-install';
    edited.env.ANTHROPIC_BASE_URL='https://api.anthropic.com';
    writeSettings(f,edited);
    const r=rollbackConfiguration(f.config);
    assert.equal(r.state,'CLAUDE_CONFIGURATION_ROLLED_BACK');
    const s=getSettings(f);
    assert.equal(s.userNewSetting,'post-install');
    assert.equal(s.env.ANTHROPIC_BASE_URL,'https://api.anthropic.com');
    assert.equal(s.env.KEEP,'yes');
    assert.equal(s.env.SINGULARITY_REPO_ROOT,undefined);
  }finally{f.cleanup();}
});

test('rollback removes an unedited proxy key and restores the pre-install env exactly',()=>{
  const f=fixture();try{
    writeSettings(f,{env:{KEEP:'yes'}});
    applyConfiguration(f.config);
    const r=rollbackConfiguration(f.config);
    assert.equal(r.state,'CLAUDE_CONFIGURATION_ROLLED_BACK');
    assert.deepEqual(getSettings(f),{env:{KEEP:'yes'}});
  }finally{f.cleanup();}
});
