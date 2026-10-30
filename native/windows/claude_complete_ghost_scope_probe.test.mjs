import {test} from 'node:test';
import assert from 'node:assert/strict';
import {probeGhostScope,validateProbe} from './claude_complete_ghost_scope_probe.mjs';
const probe={schema:'singularity-option2-ghost-scope-probe/v1',
 ghost:{team_id:'ghost-companion',user_id:'operator',agent_id:'ghost'},
 delegated:{team_id:'team',user_id:'operator',agent_id:'board'},
 ghostMarker:'GHOSTPROOF-UNIQUE2026A',delegatedMarker:'DELEGATEPROOF-UNIQUE2026B'};
const found=(marker)=>({code:0,data:{messages:[{content:`private marker ${marker}`} ]}});
const absent={code:0,data:{messages:[]}};
test('positive markers followed by negative cross search produce bounded receipt',async()=>{
 const r=await probeGhostScope({probe,search:async(id,m)=>{
  if(id.agent_id==='ghost'&&m===probe.ghostMarker)return found(m);
  if(id.agent_id==='board'&&m===probe.delegatedMarker)return found(m);
  return absent;
 }});
 assert.equal(r.ownScopeMarkersObserved,true);assert.equal(r.searchSeparationObserved,true);
 assert.equal(r.securityAuthorizationProven,false);assert.equal(r.releaseReady,false);
 assert.doesNotMatch(JSON.stringify(r),/UNIQUE2026/);
});
test('without own-scope positive controls no negative search accepted',async()=>{
 let calls=0;const r=await probeGhostScope({probe,search:async()=>{calls++;return absent}});
 assert.equal(r.searchSeparationObserved,false);assert.equal(calls,2);
});
test('cross scope content detected and reported but not leaked',async()=>{
 const r=await probeGhostScope({probe,search:async(id,m)=>found(m)});
 assert.equal(r.crossScopeMarkerObserved,true);assert.equal(r.searchSeparationObserved,false);
 assert.deepEqual(r.issues,['GHOST_SCOPE_CROSS_SCOPE_CONTENT_OBSERVED']);
});
test('backend failure does not count as absence',async()=>{
 let calls=0;const r=await probeGhostScope({probe,search:async(id,m)=>{
  calls++;if(calls>2)throw Error('service secret');return found(m);
 }});
 assert.deepEqual(r.issues,['GHOST_SCOPE_CROSS_SEARCH_FAILED']);
 assert.equal(r.searchSeparationObserved,false);
 assert.doesNotMatch(JSON.stringify(r),/service secret/);
});
test('incorrect identities and markers rejected before service calls',async()=>{
 assert.throws(()=>validateProbe({...probe,ghost:{...probe.ghost,agent_id:'board'}}));
 assert.throws(()=>validateProbe({...probe,delegated:{...probe.delegated,agent_id:'ghost'}}));
 assert.throws(()=>validateProbe({...probe,ghostMarker:probe.delegatedMarker}));
});
