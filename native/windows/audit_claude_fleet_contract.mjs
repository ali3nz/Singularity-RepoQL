#!/usr/bin/env node
/** Source-only contract inventory. Never reads credentials or claims a runtime is ready. */
import {readFileSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {AGENT_MAP} from '../../adapters/claude-code/agent-map.mjs';
import {CLAUDE_SKILLS,REPOQL_CLAUDE_PLUGIN,REPOQL_PLUGIN_SKILLS} from './configure_claude_code_windows.mjs';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const read=path=>readFileSync(join(ROOT,path),'utf8');
function declaredModel(text){
  const fm=/^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1]||'';
  return /^model:\s*([^\r\n]+)/m.exec(fm)?.[1]?.trim()||null;
}
export function inspectFleet(){
  const agents=Object.entries(AGENT_MAP).sort(([a],[b])=>a.localeCompare(b)).map(([name,x])=>{
    const content=read('adapters/claude-code/agents/'+name+'.md');
    const model=declaredModel(content);
    return {name,role:x.memoryAgentId,surface:x.surface,
      modelSetting:model===null?'INHERITS_CURRENT_CLAUDE_SESSION':model,
      memoryRoute:x.surface==='subagent'?'MAPPED_ROLE_TENCENT_HOOK': 'MAIN_SESSION_PROXY_SEPARATE'};
  });
  const skillSources=CLAUDE_SKILLS.map(name=>{
    const content=read('openchamber/skills/'+name+'/SKILL.md');
    return {name,sourcePresent:content.startsWith('---'),conditionalCapability:
      name==='consult-dispatch'||name==='issue-closeout'||name==='claude-office-visual'};
  });
  return {schema:'singularity-claude-fleet-contract/v1',sourceOnly:true,
    releaseReady:false,agents,skillSources,variant2ExpectedSkills:10,
    repoqlPlugin:{id:REPOQL_CLAUDE_PLUGIN.id,marketplaceSource:REPOQL_CLAUDE_PLUGIN.source,
      requestedByNativeClaudeConfig:true,autoBinaryBootstrapDisabled:true,
      expectedSkillsAsOf:'2026-10-29',expectedSkills:[...REPOQL_PLUGIN_SKILLS],
      installedAndDiscoveredInNativeGui:false},
    modelDefaultsVerifiedFromRuntime:false,
    liveRoleProfilesVerified:false,
    sharedConversationScope:false,
    sharedDocumentationScope:'singularity-docs/shared/docs-keeper',
    ghostRetired:true,
    docs:{tencentSourceConfigured:true,tencentLiveVerified:false,
      repoqlWatchesAttachedWorkspaceOnly:true,repoqlDocRootsVerified:false,
      bothSinksIndependentlyReadBack:false},
    blockers:['NO_NATIVE_GUI_SKILL_DISCOVERY','NO_LIVE_AGENT_PROFILES','NO_VERIFIED_MAIN_SESSION_MEMORY',
      'NO_REPOQL_DOC_READBACK','NO_NATIVE_REPOQL_PLUGIN_SKILL_DISCOVERY','NO_COMPLETE_GHOST_OFFICE_BACKENDS']};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  process.stdout.write(JSON.stringify(inspectFleet(),null,2)+'\n');
}
