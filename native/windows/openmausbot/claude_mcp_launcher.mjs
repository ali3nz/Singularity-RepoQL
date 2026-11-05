#!/usr/bin/env node
/** Thin Windows-only Claude Code -> official OpenMausBot stdio MCP launcher.
 * No token in .mcp.json, command arguments, logs or stdout. The local user
 * pairs via OMB's supported CLI and owns a private token file. No shell.
 */
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, resolve, isAbsolute, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const fail=x=>{throw new Error(x)};
export function runtimeOptions(env=process.env){
  const local=env.LOCALAPPDATA;
  if(!local||!isAbsolute(local))fail('LOCALAPPDATA_UNAVAILABLE');
  const exe=env.SINGULARITY_OMB_EXE;
  if(!exe||!isAbsolute(exe)||!/^OpenMausBot\.exe$/i.test(basename(exe)))fail('OPENMAUSBOT_DESKTOP_EXE_REQUIRED');
  if(!existsSync(exe)||!lstatSync(exe).isFile()||lstatSync(exe).isSymbolicLink())fail('OPENMAUSBOT_DESKTOP_EXE_MISSING');
  const script=join(dirname(exe),'resources','server','mcp-server.js');
  if(!existsSync(script)||!lstatSync(script).isFile()||lstatSync(script).isSymbolicLink())fail('OPENMAUSBOT_MCP_SCRIPT_MISSING');
  const port=String(env.SINGULARITY_OMB_PORT||'8799');
  if(!/^\d{4,5}$/.test(port)||Number(port)<1024||Number(port)>65535)fail('OMB_PORT_INVALID');
  const tokenFile=join(local,'Singularity','OpenMausBot','mcp-session.token');
  if(!existsSync(tokenFile)||!lstatSync(tokenFile).isFile()||lstatSync(tokenFile).isSymbolicLink())fail('PRIVATE_OMB_SESSION_MISSING');
  const st=lstatSync(tokenFile);if(st.size>4096)fail('OMB_TOKEN_INVALID');
  const token=readFileSync(tokenFile,'utf8').trim();
  if(!/^omb_sess_[A-Za-z0-9_-]{12,2048}$/.test(token))fail('OMB_TOKEN_INVALID');
  return {command:exe,args:[script],env:{...env,ELECTRON_RUN_AS_NODE:'1',OPENMAUSBOT_URL:`http://127.0.0.1:${port}`,OPENMAUSBOT_TOKEN:token}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.platform!=='win32')fail('WINDOWS_ONLY');
    const opt=runtimeOptions();
    const proc=spawn(opt.command,opt.args,{env:opt.env,stdio:['pipe','pipe','inherit'],shell:false,windowsHide:true});
    process.stdin.pipe(proc.stdin);proc.stdout.pipe(process.stdout);
    proc.on('error',()=>{process.stderr.write('OMB_MCP_START_FAILED\n');process.exitCode=1});
    proc.on('exit',code=>{process.exitCode=code??1});
  }catch(e){process.stderr.write('OMB_MCP_UNAVAILABLE: '+e.message+'\n');process.exitCode=2}
}
