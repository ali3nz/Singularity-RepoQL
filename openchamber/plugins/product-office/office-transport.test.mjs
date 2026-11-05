import { test } from "node:test";
import assert from "node:assert/strict";
import { flushOfficeQueue } from "./office-transport.js";

function fixture() {
  const map = new Map([["office/pending/evt_test", { event_type: "stop", session_id: "oc-ses_test", data: {} }]]);
  return { map, storage: {
    scan: async () => ({ entries: [...map].filter(([k]) => k.startsWith("office/pending/")).map(([key,value]) => ({key,value})) }),
    get: async key => map.get(key), set: async (key,value) => { map.set(key,value); }, remove: async key => { map.delete(key); },
  } };
}
test("native storage objects send the actual event and acknowledge it", async () => {
  const {storage,map}=fixture(); const sent=[];
  await flushOfficeQueue(storage,"http://product-office:8000/api/v1/events","synthetic",()=>false,async (_url,options)=>{sent.push(JSON.parse(options.body));return {ok:true};});
  assert.equal(sent[0].event_type,"stop"); assert.equal(map.has("office/pending/evt_test"),false); assert.equal(map.get("office/sent/evt_test"),true);
});
test("concurrent location activations do not POST the same event twice", async () => {
  const {storage}=fixture(); let count=0;
  const send=async()=>{count++;await new Promise(r=>setTimeout(r,10));return {ok:true};};
  await Promise.all([flushOfficeQueue(storage,"http://example.invalid","synthetic",()=>false,send),flushOfficeQueue(storage,"http://example.invalid","synthetic",()=>false,send)]);
  assert.equal(count,1);
});
test("already completed re-delivery is removed without another POST", async () => {
  const {storage,map}=fixture();map.set("office/sent/evt_test",true);
  await flushOfficeQueue(storage,"http://example.invalid","synthetic",()=>false,async()=>{throw new Error("Must not send");});
  assert.equal(map.has("office/pending/evt_test"),false);
});
test("Office outage preserves queued work for later recovery", async () => {
  const {storage,map}=fixture();
  await assert.rejects(flushOfficeQueue(storage,"http://example.invalid","synthetic",()=>false,async()=>({ok:false,status:503})));
  assert.equal(map.has("office/pending/evt_test"),true);assert.equal(map.has("office/sent/evt_test"),false);
  await flushOfficeQueue(storage,"http://example.invalid","synthetic",()=>false,async()=>({ok:true}));
  assert.equal(map.has("office/pending/evt_test"),false);
});
