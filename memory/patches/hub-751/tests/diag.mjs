import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFileBlocks } from "/app/knowledge/dist-test/ingest-v2-CSw_7GGw.mjs";
import { n as parseFrontmatter } from "/app/knowledge/dist-test/frontmatter-Ce2kZn6q.mjs";

const dir = "/dumps";
const names = readdirSync(dir).filter((n) => n.endsWith(".txt")).sort();
let leakFiles = 0;
let invalid = 0;
let shown = 0;
const byPath = {};
for (const name of names) {
  const raw = readFileSync(join(dir, name), "utf8");
  const body = raw.slice(raw.indexOf("\n\n") + 2);
  const { files } = parseFileBlocks(body);
  for (const f of files) {
    const m = /<{3}\s*(FILE|END)/.exec(f.content);
    if (m) {
      leakFiles++;
      byPath[f.path] = (byPath[f.path] || 0) + 1;
      if (shown < 8) {
        shown++;
        console.log("LEAK " + name.slice(0, 64) + " | " + f.path + " | " + JSON.stringify(f.content.slice(Math.max(0, m.index - 70), m.index + 40)));
      }
    }
    if (!parseFrontmatter(f.content).hasFrontmatter) invalid++;
  }
}
console.log("LEAKFILES " + leakFiles + " INVALID " + invalid);
console.log("LEAK_PATHS " + JSON.stringify(byPath).slice(0, 1200));
