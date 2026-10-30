import assert from 'node:assert/strict';
function dead(){return {innerHTML:'',textContent:'',dataset:{},classList:{toggle(){},add(){},remove(){}},addEventListener(){},removeEventListener(){},appendChild(){},querySelector(){return null},querySelectorAll(){return []}}}
globalThis.document={getElementById(){return dead()},querySelectorAll(){return []},querySelector(){return null},addEventListener(){},createElement(){return dead()},body:dead(),hidden:false};
globalThis.location={hash:'',pathname:'/',href:'http://127.0.0.1:18100/'};
globalThis.history={replaceState(){}};
globalThis.sessionStorage={getItem(){return null},setItem(){}};
globalThis.matchMedia=()=>({matches:false,addEventListener(){}});
globalThis.window={addEventListener(){},scrollTo(){}};
for(let n=1;n<=4;n++){
  globalThis.window.__SINGULARITY_VARIANT__={variant:n,gui:n<=2?'claude-desktop-code':'openchamber-desktop'};
  const {__editorTestSurface:u}=await import(`./app.js?variant=${n}`);
  assert.equal(u.nativeUsageGui,n<=2?'Claude Desktop Code':'OpenChamber Desktop');
  assert.equal(u.cpuScale.cores,1);
  assert.equal(u.cpuScale.label,'one logical core');
}
delete window.__SINGULARITY_VARIANT__;
const {__editorTestSurface:u}=await import('./app.js?legacy');
assert.equal(u.nativeUsageGui,null);
assert.equal(u.cpuScale.cores,4);
console.log('5/5 native/legacy dashboard UI source contracts passed');
