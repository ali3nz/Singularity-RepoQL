// payload-budget.mjs — V3.3.35 (ticket 085, plan D10). Byte-accurate final
// serialised payload enforcement with typed rejection and a complete manifest.
// The evidence-pack/attach builders measure the FINAL serialised bytes (after
// every transport normalisation), enumerate included vs omitted sources, and
// REJECT oversize payloads with a typed result instead of silently clipping
// and later claiming completeness. No chunking here (deferred by the plan
// until ordering + receipts are proven).

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export const PAYLOAD_LIMITS = {
  attachTotalBytes: 24_000,   // matches consult --attach contract (8k x 3+)
  attachPerFileBytes: 8_000,
};

function bytesOf(s) { return Buffer.byteLength(String(s ?? ""), "utf8"); }

// files: [{name, content}] already transport-normalised by the caller.
// Returns { ok, totalBytes, included:[{name,bytes,sha256}], omitted:[{name,bytes,reason}], reasons }
export function budgetPayload(files, { totalCap = PAYLOAD_LIMITS.attachTotalBytes, perFileCap = PAYLOAD_LIMITS.attachPerFileBytes } = {}) {
  const included = [], omitted = [], reasons = [];
  let spent = 0;
  for (const f of files) {
    const b = bytesOf(f.content);
    if (b > perFileCap) { omitted.push({ name: f.name, bytes: b, reason: `per-file cap ${perFileCap} exceeded` }); reasons.push(`${f.name}: ${b}B > per-file cap ${perFileCap}B`); continue; }
    if (spent + b > totalCap) { omitted.push({ name: f.name, bytes: b, reason: `total cap ${totalCap} would be exceeded` }); reasons.push(`${f.name}: would exceed total cap ${totalCap}B`); continue; }
    spent += b;
    included.push({ name: f.name, bytes: b, sha256: createHash("sha256").update(String(f.content)).digest("hex") });
  }
  // Honest manifest: callers MUST NOT claim completeness when omitted is
  // non-empty — they must surface it, attach a raw-source reference, or fail.
  return { ok: omitted.length === 0, totalBytes: spent, included, omitted, reasons };
}

// Typed rejection wrapper for builders that MUST NOT truncate: throws
// PayloadTooLargeError carrying the manifest so the caller can fail the gate
// honestly (send nothing rather than something incomplete presented as whole).
export class PayloadTooLargeError extends Error {
  constructor(manifest) {
    super(`payload budget exceeded: ${manifest.reasons.join("; ")}`);
    this.name = "PayloadTooLargeError";
    this.manifest = manifest;
  }
}

export function requireWithinBudget(files, opts) {
  const m = budgetPayload(files, opts);
  if (!m.ok) throw new PayloadTooLargeError(m);
  return m;
}

// Byte-accurate splitter for consult attachments: split TEXT into <= cap-byte
// parts on line boundaries, multibyte-safe. Returns array of strings; caller
// names them partN. Guarantees: every part <= cap bytes; concatenation is
// byte-identical to the input; no line is split mid-character.
export function splitIntoByteParts(text, cap = PAYLOAD_LIMITS.attachPerFileBytes) {
  const s = String(text ?? "");
  if (!s) return [];
  const lines = s.split("\n");
  const trailingNl = s.endsWith("\n");
  if (trailingNl) lines.pop(); // split() yields a phantom empty last element; the newline is re-added per line below
  const parts = [];
  let cur = "", curBytes = 0;
  const push = () => { parts.push(cur); cur = ""; curBytes = 0; };
  for (let i = 0; i < lines.length; i++) {
    const isLast = i === lines.length - 1;
    const nl = isLast && !trailingNl ? "" : "\n"; // preserve the input's exact trailing-newline state
    const lb = Buffer.byteLength(lines[i] + nl, "utf8");
    if (lb > cap) {
      // Oversize single line: hard-split by bytes WITHOUT cutting a codepoint.
      if (cur) push();
      const buf = Buffer.from(lines[i] + nl, "utf8");
      let off = 0;
      while (off < buf.length) {
        let end = Math.min(off + cap, buf.length);
        while (end > off && (buf[end] & 0xc0) === 0x80) end--; // back up to codepoint start
        parts.push(buf.subarray(off, end).toString("utf8"));
        off = end;
      }
      continue;
    }
    if (curBytes + lb > cap && cur) push();
    cur += lines[i] + nl; curBytes += lb;
  }
  if (cur) parts.push(cur);
  return parts;
}

export function sha256OfText(t) { return createHash("sha256").update(String(t ?? "")).digest("hex"); }
