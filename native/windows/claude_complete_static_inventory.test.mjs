import {test} from 'node:test';
import assert from 'node:assert/strict';
import {inventory} from './claude_complete_static_inventory.mjs';
const HOME='/home/example',WORKSPACE='/work/repo';
const valid={home:HOME,workspace:WORKSPACE,
 verifyClaude:()=>({configured:true,variant:2,agentsExpected:9,skillsExpected:10,hookEventsExpected:13,issues:[]}),
 inspectRepoql:()=>({skillAssetsPresent:true,expected:17,present:17,issues:[]}),
 verifyMcp:()=>({installedConfigVerified:true,variant:2,registered:['kanzo','openmausbot']})};
test('all static files and owned registrations verified never implies live acceptance',()=>{
 const r=inventory(valid);assert.equal(r.staticInstallationComplete,true);assert.equal(r.releaseReady,false);
 assert.equal(r.nativeClaudeGuiLoadedVerified,false);assert.equal(r.officialRepoqlPlugin.presentSkills,17);
 assert.doesNotMatch(JSON.stringify(r),/home\/example|work\/repo/);
});
test('OpenMausBot is a required registration for static completion',()=>{
 const r=inventory({...valid,verifyMcp:()=>({installedConfigVerified:true,variant:2,registered:['kanzo']})});
 assert.equal(r.staticInstallationComplete,false);
 assert.ok(r.openMausBotProjectMcp.issues.includes('OPENMAUSBOT_REGISTRATION_INCOMPLETE'));
});
test('missing RepoQL cache never counts as 17 loaded skills',()=>{
 const r=inventory({...valid,inspectRepoql:()=>({skillAssetsPresent:false,expected:17,present:10,issues:['PLUGIN_SKILLS_MISSING_OR_INVALID']})});
 assert.equal(r.staticInstallationComplete,false);assert.equal(r.officialRepoqlPlugin.presentSkills,10);
});
test('wrong variant and wrong ownership fail even if hooks and MCP exist',()=>{
 const r=inventory({...valid,verifyClaude:()=>({configured:true,variant:1,agentsExpected:9,skillsExpected:10,hookEventsExpected:11}),
 verifyMcp:()=>({installedConfigVerified:true,variant:2,registered:['repoql','kanzo']})});
 assert.equal(r.staticInstallationComplete,false);
 assert.ok(r.kanzoProjectMcp.issues.includes('KANZO_REGISTRATION_INCOMPLETE'));
});
test('failed inspectors do not leak exceptions or make release-ready',()=>{
 const r=inventory({...valid,verifyClaude:()=>{throw Error('private user config path')},
  inspectRepoql:()=>{throw Error('plugin secret')},verifyMcp:()=>{throw Error('client credentials')}});
 assert.equal(r.staticInstallationComplete,false);assert.doesNotMatch(JSON.stringify(r),/secret|private/);
});
test('requires explicit absolute home and workspace',()=>{
 assert.throws(()=>inventory({...valid,home:'relative'}),/ABSOLUTE/);
 assert.throws(()=>inventory({...valid,workspace:''}),/ABSOLUTE/);
});
