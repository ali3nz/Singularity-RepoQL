#!/usr/bin/env node
// Honest, source-pinned migration inventory. A candidate is not a verified port.
import {readFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const ROOT=resolve(fileURLToPath(new URL('..',import.meta.url)));
const inventory=JSON.parse(readFileSync(join(ROOT,'docs/source-inventory.json'),'utf8'));
const refs=JSON.parse(readFileSync(join(ROOT,'docs/reference-modules.json'),'utf8'));
export function getCoverage(){
  const modules=inventory.modules||[];
  const pinned=Object.keys(refs.modules||{}).map(name=>({source:`lib/${name}.mjs`,hash:refs.modules[name],candidate:`src/${({
    'gate-parser':'gate','bridge-result':'bridge','payload-budget':'payload',
    'worker-completion':'worker','run-slots':'scope','no-change':'no_change',
    'deviation-ledger':'deviation','doc-impact':'doc_impact',
    'run-summary':'run_summary','engine-router':'engine_router',
    'case-store':'case_store','engine-state':'engine_state',
    'resource-lease':'resource_lease', 'phase-driver':'phase_driver', 'nanny':'nanny_observe'
  })[name]||name}.rs` }));
  for(const port of pinned){
    const original=modules.find(m=>m.path===port.source);
    if(!original || original.sha256!==port.hash)throw Error(`source inventory mismatch: ${port.source}`);
    if(!existsSync(join(ROOT,port.candidate)))throw Error(`missing Rust candidate: ${port.candidate}`);
  }
  return {status:'development candidate; native build and parity not verified',
    recordedSourceModules:modules.length, rustCandidateSourceModules:pinned.length,
    sourceModulesWithoutCandidate:modules.length-pinned.length,
    nativeVerifiedModules:0, parityExecuted:0,
    candidateModules:pinned.map(({source,candidate})=>({source,candidate,verified:false})),
    keyBlockingSurfaces:[
      'orchestrate.mjs stage machine and coordinator execution',
      'stateful model and provider invocation',
      'worker leases, production resource-lease cutover, and nanny action/runtime loops',
      'host service and external OpenCode plugin integration',
      'RepoQL web application sources and authenticated navigation',
      'complete Rust compile, lint, parity and end-to-end acceptance'
    ],
    note:'The source includes tooling and tests. Unported count does not mean every file needs its own Rust replacement. No candidate has been proven equivalent.'};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  console.log(JSON.stringify(getCoverage(),null,2));
}
