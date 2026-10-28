import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseFileBlocks, extractSource } from "/app/knowledge/dist-test/ingest-v2-CSw_7GGw.mjs";
import { parseFileBlocks as baselineParseFileBlocks } from "/app/knowledge/dist-base/ingest-v2-CSw_7GGw.mjs";
import { n as parseFrontmatter } from "/app/knowledge/dist-test/frontmatter-Ce2kZn6q.mjs";

const SRC = (title) => `---\ntype: source\ntitle: ${title}\n---\n\n# ${title}\n\nBody for ${title}.\n`;
const OPEN = (p) => `<<<FILE path="${p}">>>\n`;
const END = "<<<END>>>\n";
const isSource = (content) => {
  const p = parseFrontmatter(content);
  return p.hasFrontmatter && p.frontmatter.type === "source";
};

test("1 canonical END terminators", () => {
  const r = parseFileBlocks(OPEN("wiki/sources/a.md") + SRC("A") + END + OPEN("wiki/concepts/b.md") + SRC("B") + END);
  assert.deepEqual(r.files.map((f) => f.path), ["wiki/sources/a.md", "wiki/concepts/b.md"]);
});

test("2 blocks separated by --- without END are both recovered", () => {
  const r = parseFileBlocks(OPEN("wiki/sources/a.md") + SRC("A") + "---\n" + OPEN("wiki/sources/b.md") + SRC("B") + "---\n");
  assert.equal(r.files.length, 2);
});

test("3 ---END terminators", () => {
  const r = parseFileBlocks(OPEN("wiki/sources/a.md") + SRC("A") + "---END\n" + OPEN("wiki/sources/b.md") + SRC("B") + "---END\n");
  assert.equal(r.files.length, 2);
});

test("4 trailing '--- ' terminator and '--- ' frontmatter delimiters are normalized", () => {
  const fm = "--- \ntype: source\ntitle: A\n--- \n\n# A\n\nBody.\n";
  const r = parseFileBlocks(OPEN("wiki/sources/a.md") + fm + "--- \n" + OPEN("wiki/sources/b.md") + SRC("B") + END);
  assert.equal(r.files.length, 2);
  assert.ok(r.files[0].content.startsWith("---\ntype: source\ntitle: A\n---\n"));
});

test("5 frontmatter-only block whose closing --- is the last line is kept", () => {
  const r = parseFileBlocks(OPEN("wiki/sources/a.md") + "---\ntype: source\ntitle: Only FM\n---");
  assert.equal(r.files.length, 1);
  assert.match(r.files[0].content, /title: Only FM/);
});

test("6 unclosed A followed by closed B: A never contains B", () => {
  const r = parseFileBlocks(OPEN("wiki/sources/a.md") + SRC("A") + OPEN("wiki/sources/b.md") + SRC("B") + END);
  assert.equal(r.files.length, 2);
  assert.ok(!r.files[0].content.includes("Body for B"));
  assert.ok(r.files[1].content.includes("Body for B"));
});

test("7 single bare-EOF final block yields zero files with a warning", () => {
  const r = parseFileBlocks(OPEN("wiki/sources/a.md") + SRC("A"));
  assert.equal(r.files.length, 0);
  assert.equal(r.warnings.length, 1);
});

test("8 <<<<FILE typo is a boundary; invalid stub rejected; no leak into previous page", () => {
  const stub = "<<<<FILE path=\"wiki/concepts/stub.md\">>>\n---\ntitle: broken";
  const r = parseFileBlocks(OPEN("wiki/sources/a.md") + SRC("A") + END + stub);
  assert.equal(r.files.length, 1);
  assert.ok(!r.files[0].content.includes("<<<"));
  assert.ok(!r.files[0].content.includes("stub"));
});

test("9 invalid paths are rejected", () => {
  for (const p of ["/etc/passwd", "../x.md", "notes/x.md"]) {
    assert.equal(parseFileBlocks(OPEN(p) + SRC("X") + END).files.length, 0, p);
  }
});

test("10 missing frontmatter is rejected", () => {
  const r = parseFileBlocks(OPEN("wiki/concepts/x.md") + "# just body\n" + END);
  assert.equal(r.files.length, 0);
});

test("11 CRLF input", () => {
  const text = "<<<FILE path=\"wiki/sources/a.md\">>>\r\n---\r\ntype: source\r\ntitle: A\r\n---\r\n\r\n# A\r\nBody.\r\n<<<END>>>\r\n";
  const r = parseFileBlocks(text);
  assert.equal(r.files.length, 1);
  assert.equal(parseFrontmatter(r.files[0].content).frontmatter.title, "A");
});

test("12 text after END is dropped", () => {
  const r = parseFileBlocks(OPEN("wiki/sources/a.md") + SRC("A") + END + "TRAILING COMMENTARY\n");
  assert.equal(r.files.length, 1);
  assert.ok(!r.files[0].content.includes("TRAILING"));
});

test("13 horizontal rule inside body is preserved", () => {
  const body = "---\ntype: source\ntitle: A\n---\n\n# A\n\nSection one.\n\n---\n\nSection two.\n";
  const r = parseFileBlocks(OPEN("wiki/sources/a.md") + body + END);
  assert.match(r.files[0].content, /---\n\nSection two\./);
});

test("14 source page with unquoted colons in title/description is repaired, not dropped", () => {
  const page = "---\ntype: source\ntitle: Skill: mail sink \u2014 how to send\ndescription: Use: carefully\n---\n\n# Mail sink\n\nBody.\n";
  const r = parseFileBlocks(OPEN("wiki/sources/mail.md") + page + END);
  assert.equal(r.files.length, 1);
  assert.equal(parseFrontmatter(r.files[0].content).frontmatter.title, "Skill: mail sink \u2014 how to send");
  assert.ok(r.warnings.some((w) => w.includes("已修复")));
});

test("15 extractSource retries once when the first response has no source page", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p751-"));
  const src = join(dir, "src.md");
  writeFileSync(src, "Some source text.\n");
  const responses = [
    OPEN("wiki/concepts/c.md") + "---\ntype: concept\ntitle: C\n---\n\nBody\n" + END,
    OPEN("wiki/sources/src.md") + SRC("Src") + END,
  ];
  const calls = [];
  const llm = { chat: async (args) => { calls.push(args); return responses.shift() ?? ""; } };
  const candidates = await extractSource(dir, src, {}, [], { llm, mode: "single" });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].prompt.includes("PROTOCOL REMINDER"));
  const keys = [...candidates.keys()];
  assert.ok(keys.some((k) => k.startsWith("wiki/sources/")), keys.join(","));
  assert.ok(keys.some((k) => k.startsWith("wiki/concepts/")), keys.join(","));
});

test("16 extractSource throws when no source page exists after the retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p751-"));
  const src = join(dir, "src.md");
  writeFileSync(src, "Some source text.\n");
  const concept = OPEN("wiki/concepts/c.md") + "---\ntype: concept\ntitle: C\n---\n\nBody\n" + END;
  const llm = { chat: async () => concept };
  await assert.rejects(extractSource(dir, src, {}, [], { llm, mode: "single" }), /未生成 source 摘要页/);
});

test("17 archived failure dumps: patched recovers at least as much as baseline; no leaks; all pages valid", () => {
  const dir = "/dumps";
  const names = readdirSync(dir).filter((n) => n.endsWith(".txt")).sort();
  const stats = {
    dumps: names.length,
    base: { anyPage: 0, sourcePage: 0 },
    patched: { anyPage: 0, sourcePage: 0, files: 0, leaks: 0, invalid: 0 },
  };
  for (const name of names) {
    const raw = readFileSync(join(dir, name), "utf8");
    const idx = raw.indexOf("\n\n");
    const body = idx >= 0 ? raw.slice(idx + 2) : raw;
    const b = baselineParseFileBlocks(body).files;
    if (b.length) stats.base.anyPage++;
    if (b.some((f) => isSource(f.content))) stats.base.sourcePage++;
    const p = parseFileBlocks(body).files;
    stats.patched.files += p.length;
    if (p.length) stats.patched.anyPage++;
    if (p.some((f) => isSource(f.content))) stats.patched.sourcePage++;
    for (const f of p) {
      if (/<{2,}\s*(FILE|END)/.test(f.content)) stats.patched.leaks++;
      if (!parseFrontmatter(f.content).hasFrontmatter) stats.patched.invalid++;
    }
  }
  console.log("DUMP_SWEEP " + JSON.stringify(stats));
  assert.equal(stats.patched.leaks, 0);
  assert.equal(stats.patched.invalid, 0);
  assert.ok(stats.patched.anyPage >= stats.base.anyPage);
  assert.ok(stats.patched.sourcePage >= stats.base.sourcePage);
});

test("19 malformed <<<END>> closer is recognized; trailing --- separators are not kept", () => {
  const r = parseFileBlocks(OPEN("wiki/sources/a.md") + SRC("A") + "--- \n---\n\n<<<END>>\n");
  assert.equal(r.files.length, 1);
  assert.ok(!r.files[0].content.includes("END"));
  assert.ok(r.files[0].content.trimEnd().endsWith("Body for A."), JSON.stringify(r.files[0].content.slice(-60)));
});

test("20 unterminated <<<END (no closing >) after a ---END line is recognized and trailer removed", () => {
  const r = parseFileBlocks(OPEN("wiki/sources/a.md") + SRC("A") + "\n---END\n<<<END\n");
  assert.equal(r.files.length, 1);
  assert.ok(!/END/.test(r.files[0].content) && !/^---END$/m.test(r.files[0].content), JSON.stringify(r.files[0].content.slice(-60)));
  assert.ok(r.files[0].content.trimEnd().endsWith("Body for A."));
});

test("21 <<<ENDPOINT inside body is NOT treated as a terminator", () => {
  const body = "---\ntype: source\ntitle: A\n---\n\n# A\n\nThe <<<ENDPOINT>>> value is documented here.\n";
  const r = parseFileBlocks(OPEN("wiki/sources/a.md") + body + END);
  assert.equal(r.files.length, 1);
  assert.ok(r.files[0].content.includes("<<<ENDPOINT>>>"));
});

test("18 informational: latest dump of each of the five current failures", () => {
  const five = [
    "services-ai-orchestra-guard.md",
    "services-freebuff-desktop.md",
    "services-oc-guard-drift-watch.md",
    "skills-mail-sink.md",
    "skills-vision.md",
  ];
  const names = readdirSync("/dumps").filter((n) => n.endsWith(".txt")).sort();
  const out = {};
  for (const s of five) {
    const latest = names.filter((n) => n.startsWith(`generate-fail-${s}-`)).pop();
    if (!latest) { out[s] = "no-dump"; continue; }
    const raw = readFileSync(join("/dumps", latest), "utf8");
    const p = parseFileBlocks(raw.slice(raw.indexOf("\n\n") + 2)).files;
    out[s] = { latest, files: p.length, sourcePage: p.some((f) => isSource(f.content)) };
  }
  console.log("FIVE " + JSON.stringify(out));
});
