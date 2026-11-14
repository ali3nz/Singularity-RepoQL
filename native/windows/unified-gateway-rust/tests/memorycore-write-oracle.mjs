// JavaScript reference for exactly one already-authorized conversation add.
// No native writer selection or retries are permitted in the reference path.
import { callMemoryCore, loadMemoryConfig } from '../../../../scripts/memory-config-loader.mjs';
let input='';
for await (const chunk of process.stdin) input+=chunk;
const req=JSON.parse(input);
delete process.env.SINGULARITY_RUST_MEMORYCORE_WRITER_BIN;
try {
  const value=await callMemoryCore('/v3/conversation/add',req.body,loadMemoryConfig());
  process.stdout.write(JSON.stringify({ok:true,payload:value}));
} catch { process.stdout.write(JSON.stringify({ok:false})); }
