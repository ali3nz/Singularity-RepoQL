import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {planParentProxy,applyParentProxy,verifyParentProxy,rollbackParentProxy} from './configure_parent_memory_proxy.mjs';
function fixture(settings={}){
 const home=mkdtempSync(join(tmpdir(),'main-proxy-'));mkdirSync(join(home,'.claude'));
 if(settings!==null)writeFileSync(join(home,'.claude','settings.json'),JSON.stringify(settings));
 const configFile=join(home,'private.json');writeFileSync(configFile,JSON.stringify({
  schema:'singularity-option2-parent-proxy/v1',baseUrl:'http://127.0.0.1:8096/claude-code/default',
  token:'secret-operator-token-123',model:'memory-proxy-model'}));
 return {home,configFile};
}
test('plan is read-only and never emits the private token',()=>{
 const p=fixture({hooks:{Stop:[]},env:{FOREIGN_SETTING:'preserved'}});
 const before=readFileSync(join(p.home,'.claude','settings.json'));
 const q=planParentProxy(p);
 assert.equal(q.changed,true);assert.deepEqual(before,readFileSync(join(p.home,'.claude','settings.json')));
 assert.doesNotMatch(JSON.stringify({change:q.changed}),/secret-operator/);
});
test('applies exact owned settings and restores previous unmodified bytes',()=>{
 const settings={hooks:{Stop:[{hooks:[{type:'command',command:'unchanged'}]}]},env:{USER_VALUE:'kept'}};
 const p=fixture(settings),original=readFileSync(join(p.home,'.claude','settings.json'));
 const applied=applyParentProxy({...p,apply:true,windowsHost:true});
 assert.equal(applied.applied,true);assert.equal(verifyParentProxy({home:p.home}).configured,true);
 const now=JSON.parse(readFileSync(join(p.home,'.claude','settings.json')));
 assert.equal(now.env.ANTHROPIC_AUTH_TOKEN,'secret-operator-token-123');
 assert.equal(now.env.USER_VALUE,'kept');
 assert.equal(now.hooks.Stop[0].hooks[0].command,'unchanged');
 assert.doesNotMatch(JSON.stringify(applied),/secret-operator-token-123/);
 // The receipt binds the credential it wrote without storing or printing it.
 const receipt=JSON.parse(readFileSync(join(p.home,'.claude','.singularity-parent-memory-proxy-receipt.json'),'utf8'));
 assert.match(receipt.credentialSalt,/^[a-f0-9]{32}$/);
 assert.match(receipt.credentialBinding,/^[a-f0-9]{64}$/);
 assert.doesNotMatch(JSON.stringify(receipt),/secret-operator-token-123/);
 assert.equal(rollbackParentProxy({home:p.home,apply:true,windowsHost:true}).rolledBack,true);
 assert.deepEqual(readFileSync(join(p.home,'.claude','settings.json')),original);
});
test('fresh settings created only with approval then removed by owned rollback',()=>{
 const p=fixture(null),settings=join(p.home,'.claude','settings.json');
 assert.equal(existsSync(settings),false);
 assert.throws(()=>applyParentProxy({...p,apply:true,windowsHost:false}),/NATIVE_WINDOWS/);
 assert.equal(existsSync(settings),false);
 applyParentProxy({...p,apply:true,windowsHost:true});
 rollbackParentProxy({home:p.home,apply:true,windowsHost:true});
 assert.equal(existsSync(settings),false);
});
test('foreign provider and token conflict are refused before mutation',()=>{
 const p=fixture({env:{ANTHROPIC_BASE_URL:'https://other.example/v1',ANTHROPIC_AUTH_TOKEN:'other'}});
 const before=readFileSync(join(p.home,'.claude','settings.json'));
 assert.throws(()=>planParentProxy(p),/FOREIGN_PROVIDER_CONFLICT/);
 assert.deepEqual(before,readFileSync(join(p.home,'.claude','settings.json')));
 const another=fixture({env:{ANTHROPIC_BASE_URL:'http://127.0.0.1:8096/claude-code/default',ANTHROPIC_AUTH_TOKEN:'foreign'}});
 assert.throws(()=>planParentProxy(another),/EXISTING_PROVIDER_TOKEN_CONFLICT/);
});
test('settings drift is never overwritten by rollback',()=>{
 const p=fixture({env:{A:'existing'}});applyParentProxy({...p,apply:true,windowsHost:true});
 const path=join(p.home,'.claude','settings.json');writeFileSync(path,readFileSync(path,'utf8')+'\nuser-change\n');
 assert.equal(verifyParentProxy({home:p.home}).configured,false);
 assert.throws(()=>rollbackParentProxy({home:p.home,apply:true,windowsHost:true}),/PARENT_PROXY_SETTINGS_DRIFT/);
});
test('invalid endpoint and model config refused',()=>{
 const p=fixture();writeFileSync(p.configFile,JSON.stringify({schema:'singularity-option2-parent-proxy/v1',
 baseUrl:'https://external.example/claude-code/default',token:'lengthysecret',model:'any'}));
 assert.throws(()=>planParentProxy(p),/PROXY_LOOPBACK_URL_REQUIRED/);
});

test('interrupted apply with original settings intact can remove owned journal safely',()=>{
 const p=fixture({env:{USER:'untouched'}}),settings=join(p.home,'.claude','settings.json');
 const before=readFileSync(settings);
 applyParentProxy({...p,apply:true,windowsHost:true});
 // Simulate a crashed promotion with the previous bytes retained.
 writeFileSync(settings,before);
 const result=rollbackParentProxy({home:p.home,apply:true,windowsHost:true});
 assert.equal(result.interruptedApplyRecovered,true);
 assert.deepEqual(readFileSync(settings),before);
});
test('refuses conflict with existing model and URL embedded credentials',()=>{
 const p=fixture({env:{ANTHROPIC_BASE_URL:'http://127.0.0.1:8096/claude-code/default',ANTHROPIC_MODEL:'foreign-model'}});
 assert.throws(()=>planParentProxy(p),/EXISTING_PROVIDER_MODEL_CONFLICT/);
 const q=fixture();writeFileSync(q.configFile,JSON.stringify({schema:'singularity-option2-parent-proxy/v1',
  baseUrl:'http://user:pass@127.0.0.1:8096/claude-code/default',token:'secret-token-888',model:'model'}));
 assert.throws(()=>planParentProxy(q),/PROXY_LOOPBACK_URL_REQUIRED/);
});

test('interrupted promotion securely removes its exact journal-owned credential temp',()=>{
 const p=fixture({env:{USER:'stable'}}),settings=join(p.home,'.claude','settings.json');
 const original=readFileSync(settings);
 applyParentProxy({...p,apply:true,windowsHost:true});
 const receiptPath=join(p.home,'.claude','.singularity-parent-memory-proxy-receipt.json');
 const receipt=JSON.parse(readFileSync(receiptPath,'utf8'));
 assert.match(receipt.pendingTmp,/singularity-parent-new-[0-9a-f-]+$/);
 writeFileSync(receipt.pendingTmp,readFileSync(settings));
 writeFileSync(settings,original);
 assert.equal(verifyParentProxy({home:p.home}).configured,false);
 const result=rollbackParentProxy({home:p.home,apply:true,windowsHost:true});
 assert.equal(result.interruptedApplyRecovered,true);
 assert.equal(existsSync(receipt.pendingTmp),false);
 assert.deepEqual(readFileSync(settings),original);
});
test('modified token-bearing pending file refuses cleanup and preserves recovery receipt',()=>{
 const p=fixture({env:{USER:'stable'}}),settings=join(p.home,'.claude','settings.json');
 applyParentProxy({...p,apply:true,windowsHost:true});
 const receiptPath=join(p.home,'.claude','.singularity-parent-memory-proxy-receipt.json');
 const receipt=JSON.parse(readFileSync(receiptPath,'utf8'));
 writeFileSync(receipt.pendingTmp,'untrusted operator content');
 assert.throws(()=>rollbackParentProxy({home:p.home,apply:true,windowsHost:true}),/PARENT_PROXY_PENDING_TEMP_DRIFT/);
 assert.equal(existsSync(receiptPath),true);
 assert.equal(existsSync(receipt.pendingTmp),true);
});
test('tampered journal cannot nominate an unrelated file for deletion',()=>{
 const p=fixture({env:{USER:'stable'}});
 applyParentProxy({...p,apply:true,windowsHost:true});
 const receiptPath=join(p.home,'.claude','.singularity-parent-memory-proxy-receipt.json');
 const receipt=JSON.parse(readFileSync(receiptPath,'utf8'));
 const foreign=join(p.home,'.claude','foreign.txt');writeFileSync(foreign,'preserve me');
 receipt.pendingTmp=foreign;writeFileSync(receiptPath,JSON.stringify(receipt));
 assert.throws(()=>rollbackParentProxy({home:p.home,apply:true,windowsHost:true}),/PARENT_PROXY_PENDING_TEMP_UNOWNED/);
 assert.equal(readFileSync(foreign,'utf8'),'preserve me');
});

test('interrupted restore temp is journal-owned and resumable',()=>{
 const p=fixture({env:{BEFORE:'restore'}}),settings=join(p.home,'.claude','settings.json');
 const original=readFileSync(settings);
 applyParentProxy({...p,apply:true,windowsHost:true});
 const receiptPath=join(p.home,'.claude','.singularity-parent-memory-proxy-receipt.json');
 const journal=JSON.parse(readFileSync(receiptPath,'utf8'));
 journal.restoreTmp=settings+'.singularity-parent-restore-11111111-2222-3333-4444-555555555555';
 writeFileSync(receiptPath,JSON.stringify(journal));
 writeFileSync(journal.restoreTmp,original);
 assert.deepEqual(verifyParentProxy({home:p.home}).issues,['PARENT_PROXY_ROLLBACK_IN_PROGRESS']);
 assert.equal(rollbackParentProxy({home:p.home,apply:true,windowsHost:true}).rolledBack,true);
 assert.deepEqual(readFileSync(settings),original);
 assert.equal(existsSync(journal.restoreTmp),false);
 assert.equal(existsSync(receiptPath),false);
});
test('restore-temp tampering refuses rollback without erasing receipt or foreign bytes',()=>{
 const p=fixture({env:{BEFORE:'restore'}}),settings=join(p.home,'.claude','settings.json');
 applyParentProxy({...p,apply:true,windowsHost:true});
 const receiptPath=join(p.home,'.claude','.singularity-parent-memory-proxy-receipt.json');
 const journal=JSON.parse(readFileSync(receiptPath,'utf8'));
 journal.restoreTmp=settings+'.singularity-parent-restore-11111111-2222-3333-4444-555555555555';
 writeFileSync(receiptPath,JSON.stringify(journal));
 writeFileSync(journal.restoreTmp,'modified user data');
 assert.throws(()=>rollbackParentProxy({home:p.home,apply:true,windowsHost:true}),/PARENT_PROXY_RESTORE_TEMP_DRIFT/);
 assert.equal(existsSync(receiptPath),true);
 assert.equal(readFileSync(journal.restoreTmp,'utf8'),'modified user data');
});
test('crash after restore rename can complete receipt cleanup without a backup',()=>{
 const p=fixture({env:{BEFORE:'restore'}}),settings=join(p.home,'.claude','settings.json');
 const original=readFileSync(settings);
 applyParentProxy({...p,apply:true,windowsHost:true});
 const receiptPath=join(p.home,'.claude','.singularity-parent-memory-proxy-receipt.json');
 const journal=JSON.parse(readFileSync(receiptPath,'utf8'));
 journal.restoreTmp=settings+'.singularity-parent-restore-11111111-2222-3333-4444-555555555555';
 writeFileSync(receiptPath,JSON.stringify(journal));
 writeFileSync(settings,original);
 unlinkSync(journal.backup);
 assert.equal(rollbackParentProxy({home:p.home,apply:true,windowsHost:true}).interruptedApplyRecovered,true);
 assert.deepEqual(readFileSync(settings),original);
 assert.equal(existsSync(receiptPath),false);
});
