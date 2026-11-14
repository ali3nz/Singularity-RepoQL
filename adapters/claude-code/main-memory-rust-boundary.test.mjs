import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {writeNativeCliFixture} from '../../native/windows/native_cli_fixture.mjs';
import * as mainMemoryModule from './main-memory.mjs';
const {ensureMainMemoryIntegration, classifyMainMemoryState, mainMemoryPolicyFacts} = mainMemoryModule;

const SWITCH='SINGULARITY_RUST_MEMORY_POLICY_BIN';
const BASE='http://127.0.0.1:8096/claude-code/default';
function withFake(response, action) {
  const dir=mkdtempSync(join(tmpdir(),'main-proxy-native-'));
  const input=join(dir,'captured.json');
  const bin=writeNativeCliFixture(join(dir,'native-mock'),`#!/usr/bin/env node\nconst fs=require('node:fs');\nfs.writeFileSync(${JSON.stringify(input)},fs.readFileSync(0,'utf8'));\nprocess.stdout.write(${JSON.stringify(JSON.stringify(response))});\n`);
  const previous=process.env[SWITCH];
  process.env[SWITCH]=bin;
  try {
    const result=action();
    return {result,payload:existsSync(input) ? JSON.parse(readFileSync(input,'utf8')) : null};
  } finally {
    if (previous===undefined) delete process.env[SWITCH];
    else process.env[SWITCH]=previous;
    rmSync(dir,{recursive:true,force:true});
  }
}

test('trusted parent proxy state is checked and no provider values cross native stdin',()=>{
  const token='synthetic-NO-SECRET-TRANSFER-827363';
  const settings={env:{ANTHROPIC_BASE_URL:BASE,ANTHROPIC_AUTH_TOKEN:token,OTHER:'private-context'}};
  const expected=classifyMainMemoryState(settings,BASE);
  const {result,payload}=withFake({ok:true,value:expected},()=>classifyMainMemoryState(settings,BASE));
  assert.deepEqual(result,expected);
  assert.equal(payload.facts.ownsEndpoint,true);
  assert.equal(payload.facts.endpointPresent,true);
  assert.equal(JSON.stringify(payload).includes(token),false);
  assert.equal(JSON.stringify(payload).includes(BASE),false);
  assert.equal(JSON.stringify(payload).includes('private-context'),false);
});

test('conflicted settings cannot get a forged CONFIGURED or VERIFIED result',()=>{
  const settings={env:{ANTHROPIC_BASE_URL:BASE,ANTHROPIC_API_KEY:'synthetic'}};
  assert.equal(classifyMainMemoryState(settings,BASE).state,'CONFLICTED');
  assert.throws(()=>withFake({ok:true,value:{state:'VERIFIED',detail:'looks safe'}},()=>classifyMainMemoryState(settings,BASE)),/NATIVE_MAIN_MEMORY_POLICY_DIVERGENCE/);
  assert.throws(()=>withFake({ok:false,code:'REJECTED'},()=>classifyMainMemoryState(settings,BASE)),/NATIVE_POLICY_REJECTED/);
});

test('provider replacement refuses without consent, checks plan, and never sends secret tokens',()=>{
  const token='synthetic-secret-4512177';
  const base={env:{ANTHROPIC_BASE_URL:'https://other.provider.invalid',ANTHROPIC_API_KEY:'synthetic-existing'}};
  const opts={baseUrl:BASE,token,model:'a-model'};
  const expected=ensureMainMemoryIntegration(base,opts);
  const {result,payload}=withFake({ok:true,value:{mode:expected.mode,changed:expected.changed,reasons:expected.reasons}},()=>ensureMainMemoryIntegration(base,opts));
  assert.equal(result.mode,'refused-conflict');
  assert.equal(result.settings.env.ANTHROPIC_BASE_URL,base.env.ANTHROPIC_BASE_URL);
  assert.equal(payload.replaceProvider,false);
  assert.equal(JSON.stringify(payload).includes(token),false);
  assert.equal(JSON.stringify(payload).includes('other.provider.invalid'),false);
  assert.equal(JSON.stringify(payload).includes(BASE),false);
});

test('explicit consent can choose a checked native plan but not a forged write',()=>{
  const existing={env:{ANTHROPIC_BASE_URL:'https://other.provider.invalid'},permissions:{allow:['pwd']}};
  const opts={baseUrl:BASE,token:'synthetic',replaceProvider:true};
  const expected=ensureMainMemoryIntegration(existing,opts);
  const {result}=withFake({ok:true,value:{mode:expected.mode,changed:expected.changed,reasons:expected.reasons}},()=>ensureMainMemoryIntegration(existing,opts));
  assert.deepEqual(result,expected);
  assert.throws(()=>withFake({ok:true,value:{mode:'merged',changed:false,reasons:[]}},()=>ensureMainMemoryIntegration(existing,opts)),/NATIVE_MAIN_MEMORY_POLICY_DIVERGENCE/);
});

test('an existing owned config remains idempotent under native checking',()=>{
  const input={env:{ANTHROPIC_BASE_URL:BASE,ANTHROPIC_AUTH_TOKEN:'already'}};
  const opts={baseUrl:BASE,token:'already'};
  const expected=ensureMainMemoryIntegration(input,opts);
  const {result,payload}=withFake({ok:true,value:{mode:expected.mode,changed:expected.changed,reasons:expected.reasons}},()=>ensureMainMemoryIntegration(input,opts));
  assert.equal(result.mode,'verified-existing');
  assert.equal(result.changed,false);
  assert.equal(payload.writeToken,false);
});

test('probe success is never manufactured by the offline Rust decision',()=>{
  const cfg={env:{ANTHROPIC_BASE_URL:BASE}};
  // Authenticated network probe results are still the current trusted owner.
  const {result:verified,payload}=withFake({ok:true,value:{state:'DISABLED',detail:'not a probe'}},
    ()=>classifyMainMemoryState(cfg,BASE,{ok:true,level:'full',detail:'HTTP 200'}));
  assert.equal(payload,null);
  assert.equal(verified.state,'VERIFIED');
  assert.equal(mainMemoryPolicyFacts(cfg,BASE).ownsEndpoint,true);
});


test('uninstall rollback policy is checked without sending prior provider credentials',()=>{
  const secret='synthetic-client-token-518223';
  const settings={env:{ANTHROPIC_BASE_URL:BASE,ANTHROPIC_AUTH_TOKEN:'local-edited',ANTHROPIC_MODEL:'owned'}};
  const record={mainMemory:{envWritten:{ANTHROPIC_BASE_URL:BASE,ANTHROPIC_AUTH_TOKEN:secret,ANTHROPIC_MODEL:'owned'}}};
  const prev={ANTHROPIC_BASE_URL:'https://previous.provider.invalid',ANTHROPIC_AUTH_TOKEN:'previous-secret'};
  const expected={changedKeys:['ANTHROPIC_BASE_URL','ANTHROPIC_MODEL'],operations:[
    {key:'ANTHROPIC_BASE_URL',action:'restore'},{key:'ANTHROPIC_MODEL',action:'remove'}]};
  const {result,payload}=withFake({ok:true,value:expected},()=>{
    const {removeMainMemoryIntegration}=mainMemoryModule;
    return removeMainMemoryIntegration(settings,record,prev);
  });
  assert.deepEqual(result.changedKeys,expected.changedKeys);
  assert.equal(result.settings.env.ANTHROPIC_BASE_URL,prev.ANTHROPIC_BASE_URL);
  assert.equal(result.settings.env.ANTHROPIC_AUTH_TOKEN,'local-edited');
  assert.equal('ANTHROPIC_MODEL' in result.settings.env,false);
  assert.equal(JSON.stringify(payload).includes(secret),false);
  assert.equal(JSON.stringify(payload).includes('previous-secret'),false);
  assert.equal(JSON.stringify(payload).includes(BASE),false);
  assert.equal(JSON.stringify(payload).includes('previous.provider.invalid'),false);
  assert.equal(payload.keys.length,3);
});

test('a forged native uninstall approval cannot remove a user-edited provider value',()=>{
  const settings={env:{ANTHROPIC_BASE_URL:BASE,ANTHROPIC_AUTH_TOKEN:'user-edited'}};
  const record={mainMemory:{envWritten:{ANTHROPIC_BASE_URL:BASE,ANTHROPIC_AUTH_TOKEN:'installer-value'}}};
  const forged={changedKeys:['ANTHROPIC_BASE_URL','ANTHROPIC_AUTH_TOKEN'],operations:[
    {key:'ANTHROPIC_BASE_URL',action:'remove'},{key:'ANTHROPIC_AUTH_TOKEN',action:'remove'}]};
  assert.throws(()=>withFake({ok:true,value:forged},()=>mainMemoryModule.removeMainMemoryIntegration(settings,record)),
    /NATIVE_MAIN_MEMORY_POLICY_DIVERGENCE/);
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN,'user-edited');
});
