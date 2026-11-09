#!/usr/bin/env node
/** Read-only, source-level Claude Code Complete installation inventory.
 * Files and receipts are NOT proof of native Claude Desktop Code-tab loading.
 */
import {openSync,writeFileSync,closeSync} from 'node:fs';
import {resolve,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyConfiguration,inspectRepoqlSkillAssets} from './configure_claude_code_windows.mjs';
import {verifyProjectMcp} from './configure_project_mcp.mjs';
function issueCodes(value){return Array.isArray(value)?[...new Set(value.map(x=>String(x)).filter(x=>/^[A-Z0-9_]{3,96}$/.test(x)))]:[]}
export function inventory({home,workspace,verifyClaude=verifyConfiguration,inspectRepoql=inspectRepoqlSkillAssets,
  verifyMcp=verifyProjectMcp}={}){
  if(!home||!workspace||typeof home!=='string'||typeof workspace!=='string'||
    !isAbsolute(home)||!isAbsolute(workspace))throw Error('ABSOLUTE_HOME_AND_WORKSPACE_REQUIRED');
  const receipt={schema:'singularity-option2-static-installed-inventory/v1',option:2,
    claudeConfiguration:{ownedConfigurationVerified:false,agentsExpected:9,skillsExpected:10,
      ownedHooksExpected:11,issues:[]},
    officialRepoqlPlugin:{assetsPresent:false,expectedSkills:17,presentSkills:0,issues:[]},
    kanzoProjectMcp:{ownedRegistrationVerified:false,issues:[]},
    openMausBotProjectMcp:{ownedRegistrationVerified:false,issues:[]},
    staticInstallationComplete:false,nativeClaudeGuiLoadedVerified:false,
    repoqlPluginToolsInvoked:false,tencentMemoryPersistenceVerified:false,
    officeGhostRuntimeVerified:false,releaseReady:false};
  try{
    const c=verifyClaude({home});
    receipt.claudeConfiguration.issues=issueCodes(c?.issues);
    receipt.claudeConfiguration.ownedConfigurationVerified=c?.configured===true && c?.variant===2 &&
      c?.agentsExpected===9&&c?.skillsExpected===10&&c?.hookEventsExpected===13;
    if(!receipt.claudeConfiguration.ownedConfigurationVerified && !receipt.claudeConfiguration.issues.length)
      receipt.claudeConfiguration.issues.push('CLAUDE_CONFIG_INCOMPLETE');
  }catch{receipt.claudeConfiguration.issues.push('CLAUDE_CONFIG_VERIFICATION_FAILED')}
  try{
    const p=inspectRepoql({home});
    receipt.officialRepoqlPlugin.assetsPresent=p?.skillAssetsPresent===true &&p?.expected===17&&p?.present===17;
    receipt.officialRepoqlPlugin.presentSkills=Number.isInteger(p?.present)&&p.present>=0&&p.present<=17?p.present:0;
    receipt.officialRepoqlPlugin.issues=issueCodes(p?.issues);
    if(!receipt.officialRepoqlPlugin.assetsPresent&&!receipt.officialRepoqlPlugin.issues.length)
      receipt.officialRepoqlPlugin.issues.push('REPOQL_PLUGIN_ASSETS_INCOMPLETE');
  }catch{receipt.officialRepoqlPlugin.issues.push('REPOQL_PLUGIN_ASSET_INSPECTION_FAILED')}
  try{
    const m=verifyMcp({variant:2,workspace});
    // Stricter than the name: this means "kanzo registered AND nothing foreign
    // registered". It gates staticInstallationComplete below, so do not loosen it
    // into a bare includes('kanzo') check.
    receipt.kanzoProjectMcp.ownedRegistrationVerified=m?.installedConfigVerified===true &&m?.variant===2&&
      Array.isArray(m.registered)&&m.registered.includes('kanzo')&&
      m.registered.every(name=>['kanzo','openmausbot'].includes(name));
    if(!receipt.kanzoProjectMcp.ownedRegistrationVerified)
      receipt.kanzoProjectMcp.issues.push('KANZO_REGISTRATION_INCOMPLETE');
    receipt.openMausBotProjectMcp.ownedRegistrationVerified=m?.installedConfigVerified===true &&
      m?.variant===2 && Array.isArray(m.registered) && m.registered.includes('openmausbot');
    if(!receipt.openMausBotProjectMcp.ownedRegistrationVerified)
      receipt.openMausBotProjectMcp.issues.push('OPENMAUSBOT_REGISTRATION_INCOMPLETE');
  }catch{receipt.kanzoProjectMcp.issues.push('KANZO_REGISTRATION_VERIFICATION_FAILED');
    receipt.openMausBotProjectMcp.issues.push('OPENMAUSBOT_REGISTRATION_VERIFICATION_FAILED')}
  receipt.staticInstallationComplete=receipt.claudeConfiguration.ownedConfigurationVerified &&
    receipt.officialRepoqlPlugin.assetsPresent&&receipt.kanzoProjectMcp.ownedRegistrationVerified &&
    receipt.openMausBotProjectMcp.ownedRegistrationVerified;
  return receipt;
}
function parse(argv){let home,workspace,output,strict=false;const seen=new Set();
 for(let i=0;i<argv.length;i++){
  const x=argv[i];if(seen.has(x))throw Error('DUPLICATE_ARGUMENT');seen.add(x);
  if(x==='--strict'){strict=true;continue}
  if(!['--home','--workspace','--output'].includes(x)||!argv[i+1]||argv[i+1].startsWith('--'))throw Error('INVALID_ARGUMENT');
  const v=argv[++i];if(x==='--home')home=v;else if(x==='--workspace')workspace=v;else output=v;
 }return {home,workspace,output,strict};}
function main(argv){
 const {home,workspace,output,strict}=parse(argv); const result=inventory({home,workspace});
 const content=JSON.stringify(result,null,2)+'\n';
 if(output){const fd=openSync(output,'wx',0o600);try{writeFileSync(fd,content,'utf8')}finally{closeSync(fd)}}
 else process.stdout.write(content);
 return strict&&!result.staticInstallationComplete?1:0;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{process.exitCode=main(process.argv.slice(2))}
 catch{process.stderr.write('STATIC_INVENTORY_REFUSED\n');process.exitCode=2}
}
