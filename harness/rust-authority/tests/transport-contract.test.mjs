import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ALLOWED_FIELDS} from '../adapter/telemetry-transport.mjs';

test('transport only sends fields supported by Rust store sanitizer',()=>{
  const source=readFileSync(new URL('../src/store.rs',import.meta.url),'utf8');
  const allowlist=source.match(/const FIELDS:.*?= &\[([\s\S]*?)\];/);
  assert.ok(allowlist,'expected explicit allowlist in Rust sanitizer');
  const nativeFields=new Set([...allowlist[1].matchAll(/"([a-zA-Z]+)"/g)].map(m=>m[1]));
  assert.deepEqual([...ALLOWED_FIELDS].filter(x=>!nativeFields.has(x)),[]);
  assert.deepEqual([...nativeFields].filter(x=>x!=='timestamp'&&!ALLOWED_FIELDS.has(x)),[]);
});
