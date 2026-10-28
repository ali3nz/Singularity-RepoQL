import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFileBlocks } from "/app/knowledge/dist-test/ingest-v2-CSw_7GGw.mjs";
import { parseFileBlocks as baselineParseFileBlocks } from "/app/knowledge/dist-base/ingest-v2-CSw_7GGw.mjs";
import { n as parseFrontmatter } from "/app/knowledge/dist-test/frontmatter-Ce2kZn6q.mjs";

const isSource = (c) => {
  const p = parseFrontmatter(c);
  return p.hasFrontmatter && p.frontmatter.type === "source";
};
const dir = "/dumps";
const names = readdirSync(dir).filter((n) => n.endsWith(".txt")).sort();
const s = {
  dumps: names.length,
  base: { anyPage: 0, sourcePage: 0, files: 0 },
  patched: { anyPage: 0, sourcePage: 0, files: 0, leaks: 0, invalid: 0 },
};
const perSource = {};
for (const name of names) {
  const raw = readFileSync(join(dir, name), "utf8");
  const body = raw.slice(raw.indexOf("\n\n") + 2);
  const b = baselineParseFileBlocks(body).files;
  s.base.files += b.length;
  if (b.length) s.base.anyPage++;
  if (b.some((f) => isSource(f.content))) s.base.sourcePage++;
  const p = parseFileBlocks(body).files;
  s.patched.files += p.length;
  if (p.length) s.patched.anyPage++;
  if (p.some((f) => isSource(f.content))) s.patched.sourcePage++;
  for (const f of p) {
    if (/<{2,}\s*(FILE|END)/.test(f.content)) s.patched.leaks++;
    if (!parseFrontmatter(f.content).hasFrontmatter) s.patched.invalid++;
  }
  const src = name.replace(/^generate-fail-/, "").replace(/-[^-]*-\d{4}-\d{2}-\d{2}T.*\.txt$/, "");
  perSource[src] = perSource[src] || { dumps: 0, patchedSource: 0 };
  perSource[src].dumps++;
  if (p.some((f) => isSource(f.content))) perSource[src].patchedSource++;
}
console.log("SWEEP " + JSON.stringify(s));
const five = [
  "services-ai-orchestra-guard.md",
  "services-freebuff-desktop.md",
  "services-oc-guard-drift-watch.md",
  "skills-mail-sink.md",
  "skills-vision.md",
];
const out = {};
for (const x of five) {
  const latest = names.filter((n) => n.startsWith(`generate-fail-${x}-`)).pop();
  if (!latest) { out[x] = "no-dump"; continue; }
  const raw = readFileSync(join(dir, latest), "utf8");
  const p = parseFileBlocks(raw.slice(raw.indexOf("\n\n") + 2)).files;
  out[x] = { files: p.length, sourcePage: p.some((f) => isSource(f.content)) };
}
console.log("FIVE_LATEST_DUMP " + JSON.stringify(out));
