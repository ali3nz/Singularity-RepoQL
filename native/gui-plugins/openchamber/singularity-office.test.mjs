import test from 'node:test';
import assert from 'node:assert/strict';
import {officeEventFromOpenCode, officeToolFromOpenCode, forwardToRust, SingularityOfficeNative} from './singularity-office.mjs';

test('native GUI session metadata is allowlisted and no content is copied', () => {
  const source = {type:'session.created', properties:{info:{id:'ses_12345', title:'PRIVATE SECRET', message:'SECRET PROMPT'}}, data:{prompt:'TOKEN'}};
  const result = officeEventFromOpenCode(source, 'C:\\Private\\MyRepo');
  assert.deepEqual(result, {kind:'session-start',session_id:'ses_12345',project_name:'MyRepo'});
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|SECRET|TOKEN/);
  assert.equal(officeEventFromOpenCode({type:'message.updated',properties:{info:{id:'ses_12345'}}}), null);
  assert.equal(officeEventFromOpenCode({type:'session.created',properties:{info:{id:'../bad'}}}), null);
});

test('tool events carry identifiers only and do not transmit tool payloads', () => {
  const source = {sessionID:'ses_12345',tool:'read',callID:'call_1',args:{secret:'CREDENTIAL'},output:{content:'SECRET'}};
  const result = officeToolFromOpenCode(source,'pre-tool','C:\\w\\app');
  assert.equal(result.tool_name,'read');
  assert.equal(result.tool_use_id,'call_1');
  assert.doesNotMatch(JSON.stringify(result), /CREDENTIAL|SECRET/);
  assert.equal(officeToolFromOpenCode(source,'stop'),null);
});

test('transport invokes only a Windows executable with bounded sanitized payload', () => {
  let observed;
  const spawn = (exe,args,options) => {
    observed={exe,args,options};
    return {on(){},stdin:{on(){},end(buf){observed.body=JSON.parse(buf.toString())}},unref(){}};
  };
  assert.equal(forwardToRust({kind:'stop', session_id:'ses_test'},'C:\\apps\\bridge.exe',spawn),true);
  assert.deepEqual(observed.args,['office-opencode']);
  assert.equal(observed.options.windowsHide,true);
  assert.equal(forwardToRust({kind:'stop'},'node',spawn),false);
  assert.equal(forwardToRust({kind:'stop'},'bridge.exe',spawn),false);
  assert.equal(forwardToRust({kind:'stop'},'C:\\bad\\..\\bridge.exe',spawn),false);
  assert.equal(forwardToRust({huge:'x'.repeat(3000)},'C:\\bridge.exe',spawn),false);
});

test('plugin is inert if bridge is not explicitly configured', async () => {
  const saved = process.env.SINGULARITY_DESKTOP_BRIDGE;
  delete process.env.SINGULARITY_DESKTOP_BRIDGE;
  try {
    const hooks = await SingularityOfficeNative({directory:'C:\\src\\project'});
    await hooks.event({event:{type:'session.created',properties:{info:{id:'ses_test'}}}});
    await hooks['tool.execute.before']({sessionID:'ses_test',tool:'read'});
  } finally {
    if (saved === undefined) delete process.env.SINGULARITY_DESKTOP_BRIDGE;
    else process.env.SINGULARITY_DESKTOP_BRIDGE = saved;
  }
});
