// Claude Code Windows source component classification contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
 COMPONENT, VARIANT_COMPONENTS, CREDENTIAL_COMPONENTS, OPT_IN_COMPONENTS,
 classifyBundleFile, variantIncludesComponent, partitionBundleFiles,
 variantFileSet, assertVariantExactSet, assertInstalledSet,
 walkShippedFiles, auditComponentSet,
} from "./bundle-classification.mjs";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = ["AGENTS.md", "adapters/claude-code/memory-hook.mjs",
 "office/README.md", "native/desktop-bridge/src/office.rs", "dashboard/server.py",
 "dashboard/static/app.js", "connectors/kanzo/connector.ts"];

test("exactly one complete Claude Code profile is supported", () => {
 assert.deepEqual(Object.keys(VARIANT_COMPONENTS), ["2"]);
 assert.deepEqual(VARIANT_COMPONENTS[2], [COMPONENT.CORE, COMPONENT.OFFICE, COMPONENT.DASHBOARD]);
 for(const c of [COMPONENT.CORE,COMPONENT.OFFICE,COMPONENT.DASHBOARD]) assert.equal(variantIncludesComponent(2,c),true);
 for (const n of [1,3,4,5]) assert.throws(()=>variantIncludesComponent(n,COMPONENT.CORE),/unknown installation option/);
});
test("classifier has no fallback for unknown clients", () => {
 assert.equal(classifyBundleFile("office/README.md").component,COMPONENT.OFFICE);
 assert.equal(classifyBundleFile("dashboard/server.py").component,COMPONENT.DASHBOARD);
 assert.equal(classifyBundleFile("adapters/claude-code/memory-hook.mjs").component,COMPONENT.CORE);
 assert.equal(classifyBundleFile("unknown-client/runtime.js"),null);
 assert.equal(classifyBundleFile(""),null);
});
test("full profile includes Office and dashboard, without a lean alternative", () => {
 const full=variantFileSet(FIXTURE,2);
 assert.ok(full.includes("office/README.md"));
 assert.ok(full.includes("dashboard/server.py"));
 assert.deepEqual(OPT_IN_COMPONENTS,[]);
 for (const n of [1,3,4]) assert.throws(()=>variantFileSet(FIXTURE,n),/unknown installation option/);
});
test("installed source must contain all full components", () => {
 assert.equal(assertVariantExactSet(FIXTURE,2).ok,true);
 assert.equal(assertInstalledSet(variantFileSet(FIXTURE,2),2).ok,true);
 assert.equal(assertInstalledSet(["AGENTS.md","office/README.md"],2).ok,false);
 assert.equal(assertInstalledSet(["AGENTS.md","dashboard/server.py"],2).ok,false);
 assert.equal(assertVariantExactSet([...FIXTURE,"unreviewed/file"],2).ok,false);
});
test("credentials are limited to the supported components",()=>{
 assert.deepEqual(Object.keys(CREDENTIAL_COMPONENTS).sort(),["memory.json","office.json","selflearn.json"]);
 assert.equal(CREDENTIAL_COMPONENTS["office.json"],COMPONENT.OFFICE);
});
test("actual source inventory has one full Claude Code profile",()=>{
 const files=walkShippedFiles(ROOT);
 assert.ok(files.length>100);
 const parts=partitionBundleFiles(files);
 assert.deepEqual(parts.unclassified,[]);
 const result=auditComponentSet(ROOT,2);
 assert.equal(result.ok,true,result.problems.join("; "));
 assert.ok(result.installedFiles.includes("dashboard/server.py"));
 assert.ok(result.installedFiles.some(f=>f.startsWith("office/")));
});
