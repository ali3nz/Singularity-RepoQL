import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {validatePromotionMetadata,recordPromotionMetadata,approvePromotion,markPromoted,promoteCandidate,
  discoverCandidate,evaluateCandidates,loadCandidate,candidatePath} from '../scripts/selflearn-candidates.mjs';
import {promotionArguments,approvalPayload,assertApproval,evidenceSnapshot,verifyReadback,readConcept,
  invokeRql,conceptIdentity,capsulePath,hasVerifiedPromotion} from '../scripts/selflearn-promotion.mjs';

const metadata = (extra={}) => ({conceptName:'VerifiedRecovery',capsuleCategory:'knowledge',tags:['recovery'],
  relevance:'**/src/probe.py',verification:'file:///src/probe.py#line=1',ttlDays:14,why:'Read the verified source.',example:'',...extra});
function fixture(root,extra={}) {
  return {id:'1234abcd',state:'AWAITING_APPROVAL',lesson:{text:'Verify the owned component after recovery.',evidenceRefs:['src/probe.py']},
    verification:{state:'satisfied',pending:[],satisfied:['evidence-refs-resolve','repoql-dedup-ran','promotion-metadata']},
    promotion:{eligible:true,metadata:metadata(extra)}};
}
function scratch() {
  const root=mkdtempSync(join(tmpdir(),'singularity-promotion-'));
  mkdirSync(join(root,'src'));
  writeFileSync(join(root,'src','probe.py'),'def probe():\n    return True\n');
  return root;
}
function nativeCapsule(record) {
  const m=record.promotion.metadata;
  let head='---\ndescription: '+JSON.stringify(record.lesson.text)+'\ntags:\n';
  for(const tag of m.tags) head+='  - '+JSON.stringify(tag)+'\n';
  head+='category: '+m.capsuleCategory+'\nuniversal: '+(m.capsuleCategory==='principle')+'\n';
  if(m.relevance)head+='relevance: '+JSON.stringify(m.relevance)+'\n';
  if(m.verification)head+='verification: '+JSON.stringify(m.verification)+'\nttl: '+m.ttlDays+'\nverified:\n  date: '+JSON.stringify(new Date().toISOString().slice(0,10))+'\n  commit: ""\n';
  let body='## Capsule: '+m.conceptName+'\n\n**Invariant**\n'+record.lesson.text+'\n';
  if(m.why)body+='\n**Why**\n'+m.why+'\n';
  if(m.example)body+='\n**Example**\n'+m.example+'\n';
  return head+'---\n\n'+body;
}

test('applicability and category rules follow the installed scoped concept contract',()=>{
  for(const relevance of ['**','**/**','src/probe.py','file:///src/probe.py','**/../probe.py','**/*.py;src/probe.py'])
    assert.equal(validatePromotionMetadata(metadata({relevance})).ok,false,relevance);
  for(const relevance of ['**/src/probe.py','**/src/*.py;**/src/probe.py'])assert.equal(validatePromotionMetadata(metadata({relevance})).ok,true);
  assert.equal(validatePromotionMetadata(metadata({capsuleCategory:'principle',relevance:'',verification:'',ttlDays:0})).ok,true);
  assert.equal(validatePromotionMetadata(metadata({capsuleCategory:'wisdom',verification:'',ttlDays:0})).ok,true);
  for(const category of ['principle','wisdom'])assert.equal(validatePromotionMetadata(metadata({capsuleCategory:category})).ok,false);
  for(const category of ['rule','shape']) {
    assert.equal(validatePromotionMetadata(metadata({capsuleCategory:category,verification:'',ttlDays:0})).ok,true);
    assert.equal(validatePromotionMetadata(metadata({capsuleCategory:category,verification:'',ttlDays:14})).ok,false);
  }
  for(const ttlDays of [0,-1,1.5,3651,'NaN'])assert.equal(validatePromotionMetadata(metadata({ttlDays})).ok,false);
  for(const verification of ['', 'src/probe.py#line=1', 'file:///src/probe.py', 'https://example.invalid/evidence'])
    assert.equal(validatePromotionMetadata(metadata({verification})).ok,false);
});
test('source scope and verification anchors must match real bounded evidence',()=>{
  const root=scratch();
  try {
    assert.equal(evidenceSnapshot(fixture(root),root).sources.length,1);
    for(const override of [{relevance:'**/unrelated/**'},{verification:'file:///src/other.py#line=1'},
      {verification:'file:///src/probe.py#line=999'},{verification:'file:///src/probe.py#symbol=missing'}])
      assert.throws(()=>evidenceSnapshot(fixture(root,override),root));
    assert.equal(evidenceSnapshot(fixture(root,{verification:'file:///src/probe.py#symbol=probe'}),root).sources.length,1);
  }finally{rmSync(root,{recursive:true,force:true})}
});
test('digest-bound approval rejects changed content, evidence, metadata and stale authority',()=>{
  const root=scratch();
  try {
    const record=fixture(root);const now=Date.now();
    record.promotion.approval={authority:'acceptance-operator',digest:approvalPayload(record,root).digest,
      grantedAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+60000).toISOString()};
    assert.ok(assertApproval(record,root));
    for(const mutate of [r=>r.lesson.text+=' changed',r=>r.promotion.metadata.tags.push('changed'),
      r=>r.promotion.approval.expiresAt=new Date(now-1).toISOString(),r=>r.promotion.approval.authority='']) {
      const changed=structuredClone(record);mutate(changed);assert.throws(()=>assertApproval(changed,root));
    }
    writeFileSync(join(root,'src','probe.py'),'def probe():\n    return False\n');
    assert.throws(()=>assertApproval(record,root));
  }finally{rmSync(root,{recursive:true,force:true})}
});
test('readback rejects wrong identity, changed text, changed metadata and divergent local capsule',()=>{
  const record=fixture();const content=nativeCapsule(record);const observed={uri:conceptIdentity(record.promotion.metadata),content};
  assert.equal(verifyReadback(record,observed,content).schema,'selflearn.repoql-receipt.v1');
  assert.throws(()=>verifyReadback(record,{...observed,uri:'concept:///knowledge/fabricated.md'},content));
  for(const changed of [content.replace('after recovery.','after tampering.'),content.replace('ttl: 14','ttl: 13'),content.replace('"recovery"','"unrelated"')])
    assert.throws(()=>verifyReadback(record,{...observed,content:changed},changed));
  assert.throws(()=>verifyReadback(record,observed,content+'changed'));
});
test('structured native arguments preserve all literal content without POSIX quoting or truncation',()=>{
  const text='Apostrophe isn\'t "quoted" \\path (x) $env:PATH `tick` $(Write-Output injected);\nUnicode λ雪 '+ 'long '.repeat(700);
  const plan=promotionArguments({text:'Preserve literal data.'},metadata({why:text,example:''}));
  assert.equal(plan.args[plan.args.indexOf('--why')+1],text);assert.equal(plan.shell,false);
  assert.equal(promotionArguments({text:'Valid invariant'},metadata({why:'',example:''})).args.includes('--why'),false);
  assert.throws(()=>promotionArguments({text},metadata()),/invalid invariant/);
  assert.ok(promotionArguments({text:'Shared principle'},metadata({capsuleCategory:'principle',relevance:'',verification:'',ttlDays:0})).args.includes('--universal'));
});
test('fresh lock without owner cannot be reclaimed during owner publication',async()=>{
  const root=scratch();
  try{
    const rec=discoverCandidate({root,session:'owner-window',files:['src/probe.py']}).record;
    mkdirSync(join(root,'data','selflearn','pending','.locks',rec.id+'.lock'),{recursive:true});
    const result=await evaluateCandidates({root,provider:null});
    assert.equal(result.outcomes[0].state,"LOCKED");assert.equal(loadCandidate(rec.id,root).state,'DISCOVERED');
  }finally{rmSync(root,{recursive:true,force:true})}
});

const native=process.platform==='win32'&&process.env.SINGULARITY_NATIVE_PROMOTION_ACCEPTANCE==='1';
test('native Windows RepoQL promotion, literal arguments, recovery and independent retrieval',{skip:!native,timeout:300000},async t=>{
  // The owned isolated workspace has its own index and concepts. No production
  // service is stopped. The task evidence directory is git-ignored.
  const root=mkdtempSync(resolve('work/autonomous-bots-1165/native-promotion-acceptance-'));
  mkdirSync(join(root,'src'),{recursive:true});
  writeFileSync(join(root,'src','probe.py'),'def probe():\n    return True\n');
  if(!existsGit(root))execFileSync('git',['init','--quiet'],{cwd:root,windowsHide:true});
  invokeRql(['init'],root);
  const now=Date.now();const record=fixture(root,{conceptName:'NativeProbeReturnsTrue',tags:['probe'],verification:'file:///src/probe.py#line=1,2',why:'The function returns the literal True without reading arguments or external state.'});
  record.lesson.text='The probe function in src/probe.py returns True.';
  const pending=join(root,'data','selflearn','pending');mkdirSync(pending,{recursive:true});
  writeFileSync(candidatePath(record.id,root),JSON.stringify(record));
  const digest=approvalPayload(record,root).digest;
  assert.equal(approvePromotion({id:record.id,root,expectedDigest:digest,authority:'acceptance-operator',expiresAt:new Date(now+3600000).toISOString()}).ok,true);
  const before=markPromoted({id:record.id,root,conceptId:record.promotion.metadata.conceptName});
  assert.equal(before.ok,false,'no concept exists, so metadata and approval cannot mark PROMOTED');
  assert.equal(markPromoted({id:record.id,root,conceptId:'FabricatedConcept'}).ok,false);
  const complete=promoteCandidate({id:record.id,root});assert.equal(complete.ok,true,complete.error);
  assert.equal(hasVerifiedPromotion(complete.record,root),true);
  assert.equal(promoteCandidate({id:record.id,root}).duplicate,true);
  const saved=readFileSync(capsulePath(record.promotion.metadata,root),'utf8');
  const interrupted={...loadCandidate(record.id,root),state:'AWAITING_APPROVAL'};delete interrupted.promotion.receipt;
  writeFileSync(candidatePath(record.id,root),JSON.stringify(interrupted));
  const recovery=promoteCandidate({id:record.id,root});assert.equal(recovery.ok,true,recovery.error);
  assert.equal(readFileSync(capsulePath(record.promotion.metadata,root),'utf8'),saved,'recovery reuses original capsule');
  const retrieved=readConcept(record.promotion.metadata,root);assert.equal(retrieved.state,'FOUND');
  assert.equal(retrieved.record.uri,conceptIdentity(record.promotion.metadata));
  const sentinel=join(root,'INJECTED');
  const vectors=["apostrophe isn't",'double "quotes"','spaces survive','C:\\path\\backslash\\','(parentheses)',
    '$dollar','$env:PATH','`backticks`','$(New-Item '+sentinel+')','text; New-Item '+sentinel,'line one\nline two','Unicode λ 雪', 'long '.repeat(900).trimEnd()];
  for(let index=0;index<vectors.length;index++){
    await t.test('native literal argument '+index,()=>{
      const m=metadata({conceptName:'NativeLiteral'+index,capsuleCategory:'wisdom',verification:'',ttlDays:0,why:vectors[index],example:''});
      const r=fixture(root);r.lesson.text='Preserve literal concept description data.';r.promotion.metadata=m;
      invokeRql(promotionArguments(r.lesson,m).args,root);
      const observed=readConcept(m,root);assert.equal(observed.state,'FOUND');
      assert.equal(verifyReadback(r,observed.record,readFileSync(capsulePath(m,root),'utf8')).schema,'selflearn.repoql-receipt.v1');
    });
  }
  assert.equal(existsSync(sentinel),false,'no model-generated extra command executed');
});
function existsGit(path){try{readFileSync(join(path,'.git','HEAD'));return true}catch{return false}}
