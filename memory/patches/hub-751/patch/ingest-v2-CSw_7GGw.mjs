import { t as createLogger } from "./logger-CcNfQhS0.mjs";
import { n as slugify, t as dirForType } from "./slug-D2KxInte.mjs";
import { n as parseFrontmatter, t as buildPage } from "./frontmatter-Ce2kZn6q.mjs";
import { r as loadTemplate } from "./template-BGLLCFYb.mjs";
import { t as createLlmClient } from "./llm-D0pM9cxz.mjs";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
//#region src/engines/wiki/ingest-v2/prompts.ts
/** 把已有页清单格式化为列表文本（供分析/生成阶段复用）。 */
function formatExistingPages(existingPages) {
	return existingPages.length > 0 ? existingPages.map((p) => `- [${p.type}] ${p.relPath}${p.title ? ` — ${p.title}` : ""}${p.description ? `（${p.description}）` : ""}`).join("\n") : "(wiki is empty — this is the first source)";
}
/** 分析阶段系统提示词：扮演"抽取规划者"，只产出结构化分析，不写页面。 */
function buildAnalysisSystemPrompt(template) {
	return `You are a knowledge base analyst. Your job is to read a source document and plan how to integrate it into
the existing wiki. You do NOT write final pages — you only produce a structured "extraction plan" for the
next (generation) stage.

## Wiki Purpose
${template.purpose}

## Extraction Schema
${template.schema}

## Your Analysis Output (markdown, structured, concise)
1. **Source Summary**: Summarize this source in 2–4 sentences.
2. **Entities**: Concrete entities (people, products, systems, organizations, etc.) in the source. For each, give a name and a one-sentence key point.
3. **Concepts**: Abstract concepts (theories, methods, mechanisms, etc.) in the source. For each, give a name and a one-sentence key point.
4. **Relationship to Existing Pages**: Which entities/concepts already appear in the existing page list (update/merge rather than create new), and which are brand new.
5. **Suggested Cross-References**: Which entity/concept pairs should be connected via [[wikilink]].

## Granularity

Decide whether a subject deserves its own page by asking:

1. **Independent identity** — can this subject be defined and understood on its own, without relying on its parent context?
2. **Distinct relationships** — does it have meaningful relationships to other entities/concepts beyond just belonging to its parent?
3. **Substantial content** — is there enough to say about it to fill more than a one-sentence stub?

→ If all three are true, create a dedicated page.
→ If the subject is merely a member, sub-operation, or property that has no identity outside its parent, list it as a subsection or list item within the parent's page instead.

Output only the analysis itself — no FILE blocks, no final page content. Match the source document's primary language.`;
}
/** 构造分析阶段用户提示词。 */
function buildAnalysisPrompt(args) {
	const { sourceName, sourceText, existingPages } = args;
	return `## Source to analyze: ${sourceName}

## Existing wiki pages (for deciding what to update vs. create)
${formatExistingPages(existingPages)}

## Source Document
${sourceText}

---
Produce the structured extraction plan following the rules above.`;
}
/** 构造系统提示词：角色、格式契约、输出协议。 */
function buildSystemPrompt(template) {
	return `You are a meticulous knowledge base (wiki) maintainer. Your job is to read source documents
provided by the user and integrate their knowledge into a persistent, cumulative markdown wiki —
extracting entities and concepts, building cross-references, and updating existing pages, rather than
simply paraphrasing the source.

## Wiki Purpose
${template.purpose}

## Extraction Schema
${template.schema}

## Page Format (MUST be followed strictly)
Each wiki page is "YAML frontmatter + markdown body". Frontmatter is wrapped in \`---\` at the top:
- type: REQUIRED. Values: source | entity | concept | comparison | synthesis, etc. Determines the page's directory.
- title: Human-readable title.
- description: One-sentence summary (used for index and search snippets).
- sources: Array of raw source filenames this page draws from (e.g. ["redis.md"]). Must be accurate.
- tags: Optional, short cross-category labels.
- timestamp: Optional, ISO 8601 last-modified time.
- Do NOT output a \`locked\` field.

Body guidelines:
- Link between entities/concepts using [[wikilink]], e.g. [[Redis]], [[Cache]]. Use these liberally.
- **Wikilink consistency**: Inside the brackets, write only the target page's title (e.g. [[Gateway]],
  [[Consistent Hashing]]). Do NOT include \`.md\` suffix, \`wiki/\` or slash paths, or filename slugs.
  When referencing an existing page, use its title.
- Use structured sections where applicable: # Schema / # Examples / # Citations, lists, and tables.
- **Consistent language**: Use the same primary language as the source document throughout (title, body,
  wikilinks, descriptions). Avoid mixing languages.

## Output Protocol (FILE blocks, MUST be followed strictly)
You cannot write files directly. Wrap each page to be written in the following boundary markers:

<<<FILE path="wiki/<dir>/<slug>.md">>>
---
type: ...
title: ...
---

body...
<<<END>>>

Directory conventions (use plural directory names):
- source → wiki/sources/
- entity → wiki/entities/
- concept → wiki/concepts/
- comparison → wiki/comparisons/
- synthesis → wiki/synthesis/

Rules:
- A single reply may contain multiple FILE blocks.
- path must be inside wiki/. Use stable slugs for filenames (lowercase, spaces→hyphens).
- You MUST produce at least one type: source summary page.
- For notable entities/concepts in the source, produce or update corresponding entity/concept pages.
- Do NOT output any explanatory text outside of FILE blocks.`;
}
/** 构造生成提示词（单阶段）：源全文 + 已有页清单 + 待更新页原文。 */
function buildGeneratePrompt(args) {
	const { sourceName, sourceText, existingPages, pagesToUpdate } = args;
	return `## Source to ingest: ${sourceName}

## Existing wiki pages (for deciding what to create vs. update, to avoid duplicates)
${existingPages.length > 0 ? existingPages.map((p) => `- [${p.type}] ${p.relPath}${p.title ? ` — ${p.title}` : ""}${p.description ? `（${p.description}）` : ""}`).join("\n") : "(wiki is empty — this is the first source)"}
${pagesToUpdate && pagesToUpdate.length > 0 ? `\n## Pages to Update (preserve existing facts while merging new information — output the merged full page)\n` + pagesToUpdate.map((p) => `### ${p.relPath}\n\`\`\`\n${p.content}\n\`\`\``).join("\n\n") : ""}

## Source Document
${sourceText}

---
Read the source, follow the format and protocol in the system prompt, and output FILE blocks:
1. MUST include one type: source summary page (path like wiki/sources/<slug>.md).
2. For key entities/concepts in the source, produce or update corresponding entity/concept pages.
3. If an entity already appears in the existing page list, reuse its path for merging — do NOT create a near-duplicate page.
4. Use [[wikilink]] generously between pages.
Output ONLY FILE blocks — no extra commentary.`;
}
/**
* 构造"生成阶段"用户提示词（两阶段流程）：以分析结果为主输入，
* 仍附源全文供查证细节。让 LLM 据此产出 FILE 块。
*/
function buildGenerateFromAnalysisPrompt(args) {
	const { sourceName, sourceText, analysis, existingPages } = args;
	return `## Source to ingest: ${sourceName}

## Extraction Plan (from analysis stage — generate pages based on this)
${analysis}

## Existing wiki pages (reuse paths for merging — avoid duplicates)
${formatExistingPages(existingPages)}

## Source Document (for detail verification)
${sourceText}

---
Based on the Extraction Plan above, follow the format and protocol in the system prompt, and output FILE blocks:
1. MUST include one type: source summary page (path like wiki/sources/<slug>.md).
2. For the entities/concepts listed in the extraction plan, produce or update corresponding entity/concept pages.
3. Items marked as "already exist" in the plan should reuse their existing paths for merging — do NOT create near-duplicates.
4. Follow the cross-reference suggestions in the plan — use [[wikilink]] generously.
Output ONLY FILE blocks — no extra commentary.`;
}
//#endregion
//#region src/engines/wiki/ingest-v2/file-protocol.ts
/**
* 开标签：标准为 >>>；模型偶发漏写一个 > 变成 >>。
* 接受 ≥2 个收尾 >，避免「长输出但 files=0」。
*/
const OPEN_RE = /<<<FILE\s+path\s*=\s*"([^"]*)"\s*>>+/g;
/**
* 闭标签：标准为 <<<END>>>；模型偶发拆成 <<<\nEND>>>。
* 仅放宽 END 两侧空白（含换行），仍要求字面 END。
*/
const CLOSE_RE = /<<<\s*END\s*>>>/g;
/**
* 校验并规范化 FILE 块声明的 path。
* 返回规范化路径（POSIX 风格、wiki/ 前缀）或 null（非法，应跳过）。
*
* 规则：
*   - 必须是相对路径（拒绝绝对路径 / 盘符）。
*   - 拆分后任一段不得为 ".." 或 "."（防穿越）。
*   - 规范化后必须以 "wiki/" 开头（只允许写 wiki/**）。
*/
function normalizeWikiPath(raw) {
	if (!raw) return null;
	let p = raw.trim().replace(/\\/g, "/");
	if (!p) return null;
	if (p.startsWith("/") || /^[a-zA-Z]:\//.test(p)) return null;
	p = p.replace(/^(\.\/)+/, "");
	const segments = p.split("/").filter((s) => s.length > 0);
	if (segments.length === 0) return null;
	for (const seg of segments) if (seg === ".." || seg === ".") return null;
	const normalized = segments.join("/");
	if (normalized !== "wiki" && !normalized.startsWith("wiki/")) return null;
	if (normalized === "wiki") return null;
	return normalized;
}
// PATCH-751 (documentation/issues/751-memoryhub-wiki-reingest-failed-sources.md).
// Boundary-first FILE segmentation. The baseline parser broke out of the whole response at the first
// unclosed block; the model often omits <<<END>>> and separates blocks with --- / ---END or bare EOF.
// A block now runs to the next opener (or EOF) and is accepted only with valid YAML frontmatter that
// carries a title. A bare-EOF final block is rejected (no silent acceptance of possibly truncated output).
const BOUNDARY_RE = /<{3,}FILE\s+path\s*=\s*"([^"]*)"\s*>+/g;
// Tolerant terminator: the model emits <<<END>>, <<END>>> and similar. The canonical CLOSE_RE is a strict subset.
const END_TOLERANT_RE = /<{2,}\s*END\b\s*>*/g;
const SEPARATOR_LINE_RE = /^---[ \t]*\r?$/;
const TRAILER_LINE_RE = /^---(?:END)?[ \t]*\r?$/;
const PROTOCOL_REMINDER = [
	"PROTOCOL REMINDER (mandatory):",
	"- Every FILE block MUST end with the literal line <<<END>>> before the next <<<FILE ...>>> line.",
	"- A line containing only --- or ---END is NOT a terminator.",
	"- Every page starts with a YAML frontmatter block; type and title are required.",
	"- Quote any title or description value that contains a colon.",
	"- Output ONLY FILE blocks, and include one type: source summary page under wiki/sources/.",
].join("\n");
function isSourcePageFile(file) {
	return canonicalizePagePath(file.path, file.content).startsWith("wiki/sources/");
}
function hasValidFrontmatter(content) {
	const { frontmatter, hasFrontmatter } = parseFrontmatter(content);
	return hasFrontmatter && typeof frontmatter.title === "string" && frontmatter.title.trim() !== "";
}
/** Normalize only the opening and first closing frontmatter delimiter lines (`--- ` -> `---`). */
function normalizeFrontmatterDelims(content) {
	const lines = content.split("\n");
	if (!SEPARATOR_LINE_RE.test(lines[0] ?? "")) return content;
	lines[0] = "---";
	for (let i = 1; i < lines.length; i++) if (SEPARATOR_LINE_RE.test(lines[i])) {
		lines[i] = "---";
		break;
	}
	return lines.join("\n");
}
/** Bounded repair for source pages whose unquoted title/description contains a colon (YAML error). */
function quoteFrontmatterScalars(content) {
	const lines = content.split("\n");
	if (lines[0] !== "---") return content;
	const end = lines.indexOf("---", 1);
	if (end < 0) return content;
	for (let i = 1; i < end; i++) {
		const m = /^(title|description):[ \t]*(.*?)[ \t]*$/.exec(lines[i]);
		if (!m || !m[2] || /^["']/.test(m[2])) continue;
		lines[i] = `${m[1]}: ${JSON.stringify(m[2])}`;
	}
	return lines.join("\n");
}
/** Validate one candidate block body; returns normalized page content or null. */
function finalizeBlock(rawBody) {
	const base = normalizeFrontmatterDelims(stripBlockEdges(rawBody));
	if (!base.trim()) return null;
	if (hasValidFrontmatter(base)) return { content: base, repaired: false };
	const repaired = quoteFrontmatterScalars(base);
	if (repaired !== base && /^type:[ \t]*source[ \t]*$/m.test(repaired) && hasValidFrontmatter(repaired)) return { content: repaired, repaired: true };
	return null;
}
/** Drop trailing blank and --- separator lines (a block body never legitimately ends with a bare separator). */
function stripTrailingSeparators(text) {
	const lines = text.replace(/\s+$/, "").split("\n");
	while (lines.length > 0 && TRAILER_LINE_RE.test(lines[lines.length - 1])) lines.pop();
	return lines.join("\n");
}
/** Candidate bodies for one block region (text between an opener and the next opener or EOF), in preference order. */
function candidateBodies(region, isFinalBlock) {
	const close = new RegExp(END_TOLERANT_RE.source, "g").exec(region);
	if (close) {
		const before = region.slice(0, close.index);
		return [stripTrailingSeparators(before), before];
	}
	const trimmed = region.replace(/\s+$/, "");
	const lines = trimmed.split("\n");
	const last = (lines[lines.length - 1] ?? "").trim();
	if (last === "---END" || last === "---") return [stripTrailingSeparators(lines.slice(0, -1).join("\n")), trimmed];
	return isFinalBlock ? [] : [region];
}

/**
* 解析一段 LLM 输出文本，提取所有合法的 FILE 块。
*
* @param text LLM 原始响应文本
* @returns 合法文件列表 + 警告（被跳过的块）
*/
function parseFileBlocks(text) {
	const files = [];
	const warnings = [];
	if (!text) return {
		files,
		warnings
	};
	const openers = [];
	const openerRe = new RegExp(BOUNDARY_RE.source, "g");
	let match;
	while ((match = openerRe.exec(text)) !== null) openers.push({
		rawPath: match[1],
		start: match.index,
		bodyStart: openerRe.lastIndex
	});
	for (let i = 0; i < openers.length; i++) {
		const { rawPath, bodyStart } = openers[i];
		const isFinalBlock = i === openers.length - 1;
		const normPath = normalizeWikiPath(rawPath);
		if (!normPath) {
			warnings.push(`非法 path 已跳过: "${rawPath}"`);
			continue;
		}
		const region = text.slice(bodyStart, isFinalBlock ? text.length : openers[i + 1].start);
		const candidates = candidateBodies(region, isFinalBlock);
		let accepted = null;
		for (const body of candidates) {
			accepted = finalizeBlock(body);
			if (accepted) break;
		}
		if (!accepted) {
			warnings.push(isFinalBlock && candidates.length === 0 ? `未闭合的 FILE 块（末块无结束标记），已丢弃: path="${rawPath}"` : `FILE 块未通过 frontmatter 校验，已丢弃: path="${rawPath}"`);
			continue;
		}
		if (accepted.repaired) warnings.push(`FILE frontmatter 已修复（title/description 加引号）: "${normPath}"`);
		files.push({
			path: normPath,
			content: accepted.content
		});
	}
	return {
		files,
		warnings
	};
}

/** 去掉块开头的换行与结尾多余空白，并保证以单个换行结尾。 */
function stripBlockEdges(raw) {
	let s = raw.replace(/^\r?\n/, "");
	s = s.replace(/\s+$/, "");
	if (!s) return "";
	return s + "\n";
}
/** 合并两个 sources 列表为去重并集。 */
function unionSources(oldSources, newSources) {
	const set = /* @__PURE__ */ new Set();
	for (const s of [...oldSources, ...newSources]) if (typeof s === "string" && s.trim()) set.add(s.trim());
	return [...set];
}
/** 归一化正文用于规则判重：折叠空白、trim。 */
function normalizeForCompare(body) {
	return (body ?? "").replace(/\s+/g, " ").trim();
}
/**
* 规则判重：候选正文是否已被旧页完全覆盖（无新增信息）。
* 保守策略——仅当归一化后的候选正文非空且整体是旧页正文的子串时才判为冗余，
* 避免误跳过真实新信息。典型命中：同一源未改动被重复摄取。
*/
function isCandidateRedundant(oldBody, candidateBody) {
	const cand = normalizeForCompare(candidateBody);
	if (!cand) return true;
	return normalizeForCompare(oldBody).includes(cand);
}
/**
* 决定一个生成页面对一个已存在页应如何落盘。
*
* @param existingContent 已存在页的磁盘内容（null = 不存在，直接写）
* @param candidateContent LLM 本次生成的候选页内容
* @param llm 用于合并的客户端
* @param options 合并行为（阈值等）
*/
async function mergePage(existingContent, candidateContent, llm, options = {}) {
	if (existingContent == null) return {
		action: "write",
		content: candidateContent
	};
	const oldParsed = parseFrontmatter(existingContent);
	if (oldParsed.frontmatter.locked === true) return {
		action: "skip",
		reason: "目标页 locked，跳过合并"
	};
	const candParsed = parseFrontmatter(candidateContent);
	const union = unionSources(arr(oldParsed.frontmatter.sources), arr(candParsed.frontmatter.sources));
	if (isCandidateRedundant(oldParsed.body, candParsed.body)) return {
		action: "write",
		content: buildPage({
			...oldParsed.frontmatter,
			sources: union
		}, oldParsed.body)
	};
	const threshold = options.fullRewriteMaxChars ?? 4e3;
	if (oldParsed.body.length > threshold) return {
		action: "write",
		content: await appendMerge(oldParsed, candParsed.body, union, llm)
	};
	return {
		action: "write",
		content: await rewriteMerge(existingContent, candidateContent, llm)
	};
}
const MERGE_SYSTEM = `You are a knowledge base maintainer. Merge two markdown pages on the same topic into one.
Merge principles:
- Preserve facts from the old page that still hold true — do not lose information.
- Incorporate new information from the new page.
- If old and new conflict, keep both and explicitly note the disagreement.
- Maintain YAML frontmatter format (type is required). Do NOT output a \`locked\` field.
- Preserve and merge [[wikilink]] cross-references in the body.
- Output the complete merged page directly (including frontmatter) — no extra commentary, no FILE blocks.`;
const APPEND_SYSTEM = `You are a knowledge base maintainer. Given an [existing page body] and [new material],
output only the incremental information that the existing page does NOT yet contain,
written as a concise markdown fragment (may include [[wikilink]]).
Requirements:
- Do not repeat content already in the existing page.
- Do not paraphrase or rewrite the entire page — only produce the "new" part.
- Do not output frontmatter, FILE blocks, or any explanation.
- If the new material adds nothing beyond what the existing page already covers, return an empty string.`;
/** 调 LLM 做整页重写合并，并强制 sources 取旧 ∪ 新 并集。 */
async function rewriteMerge(existingContent, candidateContent, llm) {
	const prompt = `## Existing page (preserve its facts)
\`\`\`
${existingContent}
\`\`\`

## New page (merge its additions)
\`\`\`
${candidateContent}
\`\`\`

Output the merged complete page.`;
	const out = await llm.chat({
		system: MERGE_SYSTEM,
		prompt,
		label: "merge-rewrite"
	});
	const mergedParsed = parseFrontmatter(out);
	if (!out.trim() || !mergedParsed.hasFrontmatter) return reconcileSources(existingContent, candidateContent, candidateContent);
	return reconcileSources(existingContent, candidateContent, out);
}
/**
* 追加模式合并（大页省 token）：只让 LLM 产出增量片段，旧页正文原样保留并在末尾追加。
*
* @param oldParsed   旧页解析结果（frontmatter + body）
* @param candidateBody 候选页正文
* @param union       已算好的 sources 并集
*/
async function appendMerge(oldParsed, candidateBody, union, llm) {
	const prompt = `## Existing page body
${oldParsed.body}

## New material
${candidateBody}

Output only the incremental information not already in the existing page. If nothing is new, output an empty string.`;
	const fragment = (await llm.chat({
		system: APPEND_SYSTEM,
		prompt,
		label: "merge-append"
	})).trim();
	if (!fragment) return buildPage({
		...oldParsed.frontmatter,
		sources: union
	}, oldParsed.body);
	const newBody = `${oldParsed.body.trimEnd()}\n\n${fragment}`;
	return buildPage({
		...oldParsed.frontmatter,
		sources: union
	}, newBody);
}
/** 把合并结果页的 sources 重写为「旧 ∪ 新」并集。 */
function reconcileSources(existingContent, candidateContent, mergedContent) {
	const oldSrc = arr(parseFrontmatter(existingContent).frontmatter.sources);
	const newSrc = arr(parseFrontmatter(candidateContent).frontmatter.sources);
	const merged = parseFrontmatter(mergedContent);
	const union = unionSources(oldSrc, newSrc);
	return buildPage({
		...merged.frontmatter,
		sources: union
	}, merged.body);
}
function arr(v) {
	return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}
//#endregion
//#region src/engines/wiki/ingest-v2/chunker.ts
const DEFAULT_TARGET = 12e3;
const DEFAULT_OVERLAP = 400;
/**
* 把文本切成「切分单位」数组：每个单位尽量是一个完整的 markdown 小节
* （从一个标题行到下一个标题行之前）。无标题的开头部分作为独立单位。
* 超过 target 的单位再按空行段落细分，仍超长的段落硬切。
*/
function splitIntoUnits(text, target) {
	const lines = text.split("\n");
	const sections = [];
	let cur = [];
	const isHeading = (line) => /^#{1,6}\s+\S/.test(line);
	for (const line of lines) if (isHeading(line) && cur.length > 0) {
		sections.push(cur.join("\n"));
		cur = [line];
	} else cur.push(line);
	if (cur.length > 0) sections.push(cur.join("\n"));
	const units = [];
	for (const sec of sections) {
		const s = sec.trim();
		if (!s) continue;
		if (s.length <= target) {
			units.push(s);
			continue;
		}
		for (const para of s.split(/\n\s*\n/)) {
			const p = para.trim();
			if (!p) continue;
			if (p.length <= target) units.push(p);
			else for (let i = 0; i < p.length; i += target) units.push(p.slice(i, i + target));
		}
	}
	return units;
}
/**
* 把文本聚合成若干块。每块尽量不超过 targetChars，按 markdown 小节边界聚合。
*
* @returns 块数组；输入为空返回 []，不超阈值返回单元素数组。
*/
function chunkText(text, opts = {}) {
	const target = Math.max(1e3, opts.targetChars ?? DEFAULT_TARGET);
	const overlap = Math.max(0, Math.min(opts.overlapChars ?? DEFAULT_OVERLAP, Math.floor(target / 2)));
	const trimmed = (text ?? "").trim();
	if (!trimmed) return [];
	if (trimmed.length <= target) return [trimmed];
	const units = splitIntoUnits(trimmed, target);
	const chunks = [];
	let buf = "";
	for (const unit of units) {
		const candidate = buf ? `${buf}\n\n${unit}` : unit;
		if (candidate.length > target && buf) {
			chunks.push(buf);
			const tail = overlap > 0 ? buf.slice(-overlap) : "";
			buf = tail ? `${tail}\n\n${unit}` : unit;
		} else buf = candidate;
	}
	if (buf) chunks.push(buf);
	return chunks;
}
//#endregion
//#region src/engines/wiki/ingest-v2/safe-path.ts
/**
* safe-path.ts — 落盘路径的边界校验。
*
* ingest 的落盘路径由 LLM 输出间接推导（FILE 块 path + frontmatter type），
* 推导链上任何一环出错都可能产出逃出项目目录的相对路径。这里提供最后一道
* 与推导逻辑无关的卡口：只认「解析成绝对路径后仍在 root 内」。
*/
/**
* candidate 解析后是否仍落在 root 之内（root 自身算在内）。
*
* 比较前双方都过 resolve，因此 `..`、`.`、重复分隔符都已折叠；
* 前缀比较额外带上分隔符，避免 `/data/proj-evil` 被判为在 `/data/proj` 内。
*/
function isInsideRoot(root, candidate) {
	const resolvedRoot = resolve(root);
	const resolvedCandidate = resolve(candidate);
	return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + sep);
}
//#endregion
//#region src/engines/wiki/ingest-v2/index-builder.ts
/**
* index-builder.ts — 维护 wiki/index.md（OKF §6 渐进式披露 / llm-wiki「先看目录再钻取」）。
*
* ingest 写盘后调用：扫描 wiki/ 下所有页的 frontmatter，按页类型分组，
* 生成 `* [标题](relPath) - 描述` 列表，覆盖写入 wiki/index.md。
*
* 设计取舍：
*   - index.md 是结构性文件（page/write/rm 禁改），但 ingest 可维护它（PRD §3.7-2）。
*   - 用标准 markdown 链接（OKF 推荐 bundle-relative `/path`），不影响 [[wikilink]] 图谱。
*   - 分组顺序固定（sources → entities → concepts → 其它 type），同组按标题排序，输出稳定。
*   - 宽容：坏页/缺 frontmatter 跳过，不抛错。
*/
/** 结构性文件不列入 index。 */
const STRUCTURAL = new Set([
	"index.md",
	"schema.md",
	"purpose.md",
	"log.md",
	"overview.md"
]);
/** 分组展示顺序与中文小节标题。未知 type 归到「其它」。 */
const GROUP_ORDER = [
	{
		type: "source",
		heading: "Sources"
	},
	{
		type: "entity",
		heading: "Entities"
	},
	{
		type: "concept",
		heading: "Concepts"
	},
	{
		type: "comparison",
		heading: "Comparisons"
	},
	{
		type: "synthesis",
		heading: "Synthesis"
	}
];
/** 扫描 wiki/ 收集所有非结构性页的索引条目。 */
function collectEntries(wikiDir) {
	const out = [];
	const walk = (dir) => {
		let entries;
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(dir, entry);
			let st;
			try {
				st = statSync(full);
			} catch {
				continue;
			}
			if (st.isDirectory()) {
				if (entry !== "media") walk(full);
				continue;
			}
			if (!entry.endsWith(".md")) continue;
			const rel = relative(wikiDir, full).replace(/\\/g, "/");
			if (STRUCTURAL.has(rel)) continue;
			let content;
			try {
				content = readFileSync(full, "utf-8");
			} catch {
				continue;
			}
			const { frontmatter } = parseFrontmatter(content);
			const title = typeof frontmatter.title === "string" && frontmatter.title.trim() ? frontmatter.title.trim() : entry.replace(/\.md$/, "");
			const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
			out.push({
				title,
				relPath: `/${rel}`,
				description,
				type: frontmatter.type
			});
		}
	};
	if (existsSync(wikiDir)) walk(wikiDir);
	return out;
}
/**
* 根据当前 wiki/ 内容渲染 index.md 文本（OKF 渐进式披露格式，无 frontmatter）。
* 导出以便单测。
*/
function renderIndex(entries) {
	const byType = /* @__PURE__ */ new Map();
	for (const e of entries) {
		const arr = byType.get(e.type) ?? [];
		arr.push(e);
		byType.set(e.type, arr);
	}
	const sections = ["# Index", ""];
	const emitted = /* @__PURE__ */ new Set();
	const emitGroup = (type, heading) => {
		const items = byType.get(type);
		if (!items || items.length === 0) return;
		emitted.add(type);
		items.sort((a, b) => a.title.localeCompare(b.title));
		sections.push(`## ${heading}`, "");
		for (const it of items) sections.push(`* [${it.title}](${it.relPath})${it.description ? ` - ${it.description}` : ""}`);
		sections.push("");
	};
	for (const { type, heading } of GROUP_ORDER) emitGroup(type, heading);
	const otherTypes = [...byType.keys()].filter((t) => !emitted.has(t)).sort();
	for (const t of otherTypes) emitGroup(t, t.charAt(0).toUpperCase() + t.slice(1));
	return sections.join("\n").replace(/\n+$/, "") + "\n";
}
/**
* 重建并覆盖写入 wiki/index.md。
* @returns 写入的条目数（用于日志）。
*/
function rebuildIndexFile(projectPath) {
	const wikiDir = join(projectPath, "wiki");
	if (!existsSync(wikiDir)) return 0;
	const entries = collectEntries(wikiDir);
	const text = renderIndex(entries);
	writeFileSync(join(wikiDir, "index.md"), text, "utf-8");
	return entries.length;
}
//#endregion
//#region src/engines/wiki/ingest-v2/log-writer.ts
/**
* log-writer.ts — 维护 wiki/log.md 摄取日志（OKF §7 / llm-wiki 时间线，OQ-10）。
*
* 每次摄取一个源后追加一条日期分组的条目，最新在前，便于 grep 与人工回溯：
*   ## YYYY-MM-DD
*   * **ingest** <源文件名> — 写入 N 页
*
* 批量 ingest 另有：
*   * **batch-ingest** N sources (...) — wrote M pages
*
* log.md 是结构性文件（page/write/rm 禁改），但 ingest 可维护它。
* 无 frontmatter（OKF 约定）。纯文本追加，不调用 LLM。
*
* 自研实现，未参考任何 GPL 代码。
*/
const HEADER = "# Ingest Log";
/** 取本地日期 YYYY-MM-DD。 */
function today(date = /* @__PURE__ */ new Date()) {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
/** 渲染批量 ingest 日志行。 */
function renderBatchLogEntry(sourcesProcessed, pageCount) {
	const list = sourcesProcessed.join(", ");
	return `* **batch-ingest** ${sourcesProcessed.length} sources (${list}) — wrote ${pageCount} pages`;
}
function readLogBody(logPath) {
	if (!existsSync(logPath)) return "";
	try {
		return readFileSync(logPath, "utf-8");
	} catch {
		return "";
	}
}
function appendEntries(projectPath, entries, now) {
	const logPath = join(projectPath, "wiki", "log.md");
	const day = today(now);
	let body = readLogBody(logPath);
	for (const entry of entries) body = mergeEntry(body, day, entry);
	writeFileSync(logPath, body, "utf-8");
}
/**
* 批量聚合日志（一次 ingest 一条 batch 记录，可选 merge-errors）。
* 与 appendIngestLog 共存，写入同一个 wiki/log.md。
*/
function appendIngestLogBatch(projectPath, input, now = /* @__PURE__ */ new Date()) {
	const entries = [renderBatchLogEntry(input.sourcesProcessed, input.pagesWritten.length)];
	for (const err of input.mergeErrors) entries.push(`* **merge-errors** ${err}`);
	appendEntries(projectPath, entries, now);
}
/**
* 把一条 entry 并入日志文本：若已有当天分组则插到该组最前，否则在 header 后新建当天分组。
* 最新日期分组始终在最前。导出以便单测。
*/
function mergeEntry(existing, day, entry) {
	const dayHeading = `## ${day}`;
	const lines = (existing || `${HEADER}\n`).split("\n");
	let headerIdx = lines.findIndex((l) => l.trim() === HEADER);
	if (headerIdx === -1) {
		lines.unshift(HEADER, "");
		headerIdx = 0;
	}
	const dayIdx = lines.findIndex((l) => l.trim() === dayHeading);
	if (dayIdx !== -1) lines.splice(dayIdx + 1, 0, entry);
	else {
		let insertAt = headerIdx + 1;
		if (lines[insertAt]?.trim() === "") insertAt++;
		lines.splice(insertAt, 0, dayHeading, entry, "");
	}
	return lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "") + "\n";
}
//#endregion
//#region src/engines/wiki/ingest-v2/index.ts
/**
* index.ts — ingest 引擎入口。
*
* 两阶段模型（wiki-ingest-optimization）：
*   1. extractSource() — 纯 LLM 抽取，返回候选页 Map（可并发）
*   2. commitCandidates() — 串行 merge + 落盘 + index.md/log.md 收尾
*
* ingestSource() 保留为薄封装（= extract + commit 串行），现有单测/外部调用不变。 */
const log = createLogger("wiki-ingest");
/** generate 解析失败时落盘原文，便于 FILE 协议排查（不改变成功路径）。 */
function dumpGenerateFailure(args) {
	const { projectPath, sourceName, chunkTag, output, reason } = args;
	try {
		const debugDir = join(projectPath, "_debug");
		mkdirSync(debugDir, { recursive: true });
		const file = join(debugDir, `generate-fail-${sourceName.replace(/[^\w.\-]+/g, "_")}-${chunkTag.replace(/[^\w.\-#]+/g, "_")}-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}.txt`);
		writeFileSync(file, [
			`# generate failure dump`,
			`# source=${sourceName}`,
			`# chunk=${chunkTag}`,
			`# reason=${reason}`,
			`# outputChars=${output.length}`,
			`# dumpedAt=${(/* @__PURE__ */ new Date()).toISOString()}`,
			``,
			``
		].join("\n") + output, "utf-8");
		return file;
	} catch (err) {
		log.warn("generate 失败原文落盘失败", {
			source: sourceName,
			error: String(err)
		});
		return null;
	}
}
/** 不允许 ingest 写入/覆盖的结构性文件（PRD §3.7-2）。 */
const STRUCTURAL_FILES = new Set([
	"wiki/index.md",
	"wiki/schema.md",
	"wiki/purpose.md",
	"wiki/log.md",
	"wiki/overview.md"
]);
/** 粗略上下文预算（字符）：保留余量给 prompt 框架与输出。 */
const SOURCE_CHAR_BUDGET = 28e3;
/**
* 阶段1：对单个源文件调 LLM 生成候选 wiki 页（纯内存，不落盘）。
* 可安全并发调用。
*
* 空候选语义：candidates.size === 0 视为失败（throw），与现有行为一致。
*/
async function extractSource(projectPath, sourcePath, llmConfig, existingPages, options = {}) {
	if (!existsSync(sourcePath)) throw new Error(`源文件不存在: ${sourcePath}`);
	const sourceText = readFileSync(sourcePath, "utf-8");
	const sourceName = basename(sourcePath);
	if (!sourceText.trim()) throw new Error(`源文件为空: ${sourceName}`);
	const llm = options.llm ?? createLlmClient(llmConfig);
	const template = loadTemplate(projectPath);
	const systemPrompt = buildSystemPrompt(template);
	const mode = options.mode ?? "two-stage";
	const chunks = sourceText.length > SOURCE_CHAR_BUDGET ? chunkText(sourceText, { targetChars: SOURCE_CHAR_BUDGET }) : [sourceText];
	log.info("extractSource 开始", {
		source: sourceName,
		sourceChars: sourceText.length,
		mode,
		chunks: chunks.length,
		existingPages: existingPages.length,
		templateCustomized: template.customized
	});
	const candidates = /* @__PURE__ */ new Map();
	const warnings = [];
	for (let i = 0; i < chunks.length; i++) {
		const chunkLabel = chunks.length > 1 ? `${sourceName} (chunk ${i + 1}/${chunks.length})` : sourceName;
		const tag = chunks.length > 1 ? `${sourceName}#${i + 1}` : sourceName;
		let out;
		if (mode === "two-stage") {
			log.debug("阶段A 分析开始", { chunk: tag });
			const analysis = await llm.chat({
				system: buildAnalysisSystemPrompt(template),
				prompt: buildAnalysisPrompt({
					sourceName: chunkLabel,
					sourceText: chunks[i],
					existingPages
				}),
				label: `analysis:${tag}`
			});
			log.debug("阶段A 分析完成", {
				chunk: tag,
				analysisChars: analysis.length,
				empty: !analysis.trim()
			});
			log.debug("阶段A 分析内容预览", {
				chunk: tag,
				preview: analysis.slice(0, 200)
			});
			const genPrompt = analysis.trim() ? buildGenerateFromAnalysisPrompt({
				sourceName: chunkLabel,
				sourceText: chunks[i],
				analysis,
				existingPages
			}) : buildGeneratePrompt({
				sourceName: chunkLabel,
				sourceText: chunks[i],
				existingPages
			});
			if (!analysis.trim()) log.warn("分析为空，降级单阶段生成", { chunk: tag });
			out = await llm.chat({
				system: systemPrompt,
				prompt: genPrompt,
				label: `generate:${tag}`
			});
		} else {
			const prompt = buildGeneratePrompt({
				sourceName: chunkLabel,
				sourceText: chunks[i],
				existingPages
			});
			out = await llm.chat({
				system: systemPrompt,
				prompt,
				label: `generate:${tag}`
			});
		}
		let { files, warnings: w } = parseFileBlocks(out);
		if (files.length === 0 || (i === 0 && !files.some(isSourcePageFile))) {
			log.warn("FILE 协议未产出可用的 source 页，追加一次协议提醒重试", {
				chunk: tag,
				files: files.length,
				warnings: w.length
			});
			const retry = parseFileBlocks(await llm.chat({
				system: systemPrompt,
				prompt: `${buildGeneratePrompt({
					sourceName: chunkLabel,
					sourceText: chunks[i],
					existingPages
				})}\n\n${PROTOCOL_REMINDER}`,
				label: `generate-retry:${tag}`
			}));
			files = [...files, ...retry.files];
			w = [...w, ...retry.warnings];
		}
		warnings.push(...w);
		if (files.length && w.length) log.warn("FILE 块部分恢复或修复", {
			chunk: tag,
			files: files.length,
			warnings: w.length
		});

		log.debug("FILE 块解析", {
			chunk: tag,
			outChars: out.length,
			files: files.length,
			warnings: w.length
		});
		if (files.length === 0 && out.trim()) {
			const dumpPath = dumpGenerateFailure({
				projectPath,
				sourceName,
				chunkTag: tag,
				output: out,
				reason: w.length ? `parse_empty warnings=${w.length}` : "parse_empty files=0"
			});
			if (dumpPath) log.warn("generate 无合法 FILE，已落盘", {
				source: sourceName,
				dumpPath
			});
		}
		for (const f of files) {
			const canonicalPath = canonicalizePagePath(f.path, f.content);
			if (STRUCTURAL_FILES.has(canonicalPath)) {
				warnings.push(`跳过结构性文件: ${canonicalPath}`);
				continue;
			}
			candidates.set(canonicalPath, ensureSources(f.content, sourceName));
		}
	}
	if (candidates.size === 0) {
		log.error("未生成任何合法 wiki 页", {
			source: sourceName,
			warnings
		});
		throw new Error(`未生成任何合法 wiki 页（no files generated）: ${sourceName}${warnings.length ? ` [${warnings.join("; ")}]` : ""}`);
	}
	if (![...candidates.keys()].some((p) => p.startsWith("wiki/sources/"))) {
		log.error("未生成 source 摘要页", {
			source: sourceName,
			warnings
		});
		throw new Error(`未生成 source 摘要页（no source page）: ${sourceName}${warnings.length ? ` [${warnings.join("; ")}]` : ""}`);
	}

	log.info("extractSource 完成", {
		source: sourceName,
		candidates: candidates.size,
		warnings: warnings.length
	});
	return candidates;
}
/**
* 阶段2：串行落盘 + 收尾。
* - 按 relPath 聚合所有源产出的候选页，逐页 merge。
* - 每页 try/catch：单页 merge 失败不阻塞其他页。
* - mergePage 内部可能调 LLM，通过 globalLlmLimit 纳入全局限流。
* - 全部落盘完成后统一跑一次 rebuildIndexFile + appendIngestLogBatch。
*/
async function commitCandidates(projectPath, allCandidates, llm, options) {
	const { globalLlmLimit, skipLog, ...mergeOpts } = options ?? {};
	const byPage = /* @__PURE__ */ new Map();
	for (const { sourceFilename, candidates } of allCandidates) for (const [relPath, content] of candidates) {
		if (!byPage.has(relPath)) byPage.set(relPath, []);
		byPage.get(relPath).push({
			source: sourceFilename,
			content
		});
	}
	const written = [];
	const mergeErrors = [];
	for (const [relPath, entries] of byPage) {
		const fullPath = join(projectPath, relPath);
		if (!isInsideRoot(projectPath, fullPath)) {
			for (const entry of entries) mergeErrors.push({
				relPath,
				source: entry.source,
				error: `path escapes project root: ${relPath}`
			});
			log.error("阻断越界落盘路径", {
				relPath,
				projectPath
			});
			continue;
		}
		let existing = existsSync(fullPath) ? readFileSync(fullPath, "utf-8") : null;
		for (const entry of entries) {
			if (!llm) {
				mergeErrors.push({
					relPath,
					source: entry.source,
					error: "LLM client unavailable"
				});
				continue;
			}
			try {
				const decision = globalLlmLimit ? await globalLlmLimit(() => mergePage(existing, entry.content, llm, mergeOpts)) : await mergePage(existing, entry.content, llm, mergeOpts);
				if (decision.action === "skip") {
					log.debug("跳过页（locked）", {
						relPath,
						source: entry.source
					});
					continue;
				}
				mkdirSync(dirname(fullPath), { recursive: true });
				writeFileSync(fullPath, decision.content, "utf-8");
				existing = decision.content;
				if (!written.includes(relPath)) written.push(relPath);
				log.debug("写盘", {
					relPath,
					source: entry.source,
					bytes: decision.content.length
				});
			} catch (err) {
				mergeErrors.push({
					relPath,
					source: entry.source,
					error: String(err)
				});
				log.error("页面合并失败", {
					relPath,
					source: entry.source,
					error: String(err)
				});
			}
		}
	}
	try {
		rebuildIndexFile(projectPath);
	} catch (err) {
		log.warn("index.md 重建失败（不影响主流程）", { error: String(err) });
	}
	try {
		if (!skipLog) appendIngestLogBatch(projectPath, {
			sourcesProcessed: allCandidates.map((c) => c.sourceFilename),
			pagesWritten: written,
			mergeErrors: mergeErrors.map((e) => `${e.relPath} (from ${e.source}): ${e.error}`)
		});
	} catch (err) {
		log.warn("log.md 写入失败（不影响主流程）", { error: String(err) });
	}
	return {
		written,
		mergeErrors
	};
}
/** 扫 wiki/ 得到已有页的精简信息（供 LLM 判断新建/更新）。不含结构性文件。 */
function scanExistingPages(projectPath) {
	const wikiDir = join(projectPath, "wiki");
	if (!existsSync(wikiDir)) return [];
	const out = [];
	walk(wikiDir, wikiDir, out);
	return out;
}
function walk(baseDir, dir, out) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return;
	}
	for (const entry of entries) {
		const full = join(dir, entry);
		let st;
		try {
			st = statSync(full);
		} catch {
			continue;
		}
		if (st.isDirectory()) {
			if (entry !== "media") walk(baseDir, full, out);
		} else if (entry.endsWith(".md")) {
			const rel = `wiki/${full.slice(baseDir.length + 1).replace(/\\/g, "/")}`;
			if (STRUCTURAL_FILES.has(rel)) continue;
			try {
				const { frontmatter } = parseFrontmatter(readFileSync(full, "utf-8"));
				out.push({
					relPath: rel,
					title: typeof frontmatter.title === "string" ? frontmatter.title : basename(entry, ".md"),
					type: frontmatter.type,
					description: typeof frontmatter.description === "string" ? frontmatter.description : void 0
				});
			} catch {}
		}
	}
}
/**
* 确保候选页 frontmatter 的 sources 至少包含当前源文件名（§3.7-3 / AC-10）。
* LLM 可能漏写或写错 sources，这里强制补上当前源。
*/
function ensureSources(content, sourceName) {
	const parsed = parseFrontmatter(content);
	const cur = Array.isArray(parsed.frontmatter.sources) ? parsed.frontmatter.sources.filter((x) => typeof x === "string") : [];
	if (cur.includes(sourceName)) return content;
	return buildPage({
		...parsed.frontmatter,
		sources: [...cur, sourceName]
	}, parsed.body);
}
/**
* OQ-6: 规范化页面落盘路径，保证 dedup 稳定性。
*
* LLM 选的 path（如 `wiki/entity/redis.md`）可能与我方目录约定（`wiki/entities/redis.md`）
* 不一致，或对同一实体在不同次摄取里给出不同 slug，破坏「同一实体 → 同一路径」的去重不变量。
*
* 策略：优先用页面 frontmatter 的 `type` + `title` 通过 `pageRelPath` 推导规范路径
* （目录由 type 决定、文件名由 title slug 决定，与 dedup 命中逻辑一致）。
* 当 frontmatter 缺 type/title 时，回退到「规范化 LLM 原路径的目录段」——
* 即把目录通过 `dirForType` 归一（entity→entities），文件名沿用原 slug。
*
* @param llmPath  LLM 在 FILE 块里声明的 path（已过 normalizeWikiPath 白名单校验）
* @param content  页面完整内容（含 frontmatter）
* @returns 规范化后的 wiki 相对路径（始终以 `wiki/` 开头）
*/
function canonicalizePagePath(llmPath, content) {
	const { frontmatter } = parseFrontmatter(content);
	const type = typeof frontmatter.type === "string" ? frontmatter.type.trim() : "";
	const title = typeof frontmatter.title === "string" ? frontmatter.title.trim() : "";
	if (type && title) {
		const slug = slugify(title);
		if (slug) return `wiki/${dirForType(type)}/${slug}.md`;
	}
	const segments = llmPath.split("/");
	const fileName = segments[segments.length - 1];
	if (segments.length >= 3) {
		const dirSeg = segments[1];
		return [
			"wiki",
			type ? dirForType(type) : dirForType(dirSeg),
			...segments.slice(2, -1),
			fileName
		].join("/");
	}
	return llmPath;
}
//#endregion
export { commitCandidates, extractSource, parseFileBlocks, scanExistingPages };
