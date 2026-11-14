// Oracle for the compiled Rust read-only MemoryCore CLI. No live credentials:
// differential_memorycore_reader.py runs a loopback fixture with a temporary key.
import { createMemorycoreClient } from '../../../../harness/kit/lib/memorycore-client.mjs';
let data = '';
for await (const chunk of process.stdin) data += chunk;
const request = JSON.parse(data);
const client = createMemorycoreClient({ teamId: request.team });
let result;
if (request.operation === 'v3Read') {
  const {loadMemoryConfig,callMemoryCore} = await import('../../../../scripts/memory-config-loader.mjs');
  result = await callMemoryCore(request.path,request.body,loadMemoryConfig());
}
else if (request.operation === 'resolveBlocks') result = await client.resolveBlocks({});
else if (request.operation === 'search') result = await client.search(request);
else if (request.operation === 'skillList') result = await client.skillList(request);
else result = { ok: false, code: 'OPERATION_BLOCKED' };
process.stdout.write(JSON.stringify(result));
