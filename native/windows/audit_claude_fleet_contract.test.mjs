import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectFleet} from './audit_claude_fleet_contract.mjs';
test('Claude Complete source inventory reports every agent, skill, model and memory boundary',()=>{
  const a=inspectFleet();
  assert.equal(a.agents.length,9);
  assert.equal(a.skillSources.length,10);
  assert.equal(a.repoqlPlugin.expectedSkills.length,17);
  assert.equal(a.repoqlPlugin.id,'repoql@repoql-plugins');
  assert.equal(a.repoqlPlugin.installedAndDiscoveredInNativeGui,false);
  assert.equal(a.agents.filter(x=>x.surface==='subagent').length,5);
  assert.equal(a.agents.filter(x=>x.surface==='main').length,4);
  assert.equal(a.agents.filter(x=>x.modelSetting==='INHERITS_CURRENT_CLAUDE_SESSION').length,9);
  assert.equal(a.agents.find(x=>x.name==='singularity-ghost'),undefined);
  assert.equal(a.docs.bothSinksIndependentlyReadBack,false);
  assert.equal(a.liveRoleProfilesVerified,false);
  assert.equal(a.releaseReady,false);
});
