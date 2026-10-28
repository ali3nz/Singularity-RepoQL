// sol-outfile.mjs — V3.3.1 fix (2026-09-19): the Sol bridge's output contract
// is FILE-based — content is written to <promptFile>.sol-out and stdout is
// intentionally EMPTY (the bridge only writes to stdout when given no outfile
// argument, and callEngine always passes one). The router wrote the outfile
// but never read it back, so EVERY routed Sol call returned "" — rc=0 calls
// whose gate JSON never existed (3× in a row the night of 2026-09-18), which
// cascaded into cursor/openrouter failover and the "no eligible reasoning
// engine remains" hard-stop the operator saw.
//
// This module centralizes the readback so callEngine, tests, and any future
// Sol consumer share one truth. The outfile is ALWAYS consumed after reading:
// the same prompt path is reused by the format-repair pass, and stale content
// must never leak into a later call.
import { readFileSync, existsSync, rmSync } from "node:fs";

export function solOutfilePath(promptFile) { return `${promptFile}.sol-out`; }

/** Read + consume the Sol bridge outfile. Returns trimmed content or null
 *  (missing file / read error / empty file). Best-effort deletion always. */
export function readSolOutfile(promptFile) {
  const p = solOutfilePath(promptFile);
  if (!existsSync(p)) return null;
  let content = null;
  try { content = readFileSync(p, "utf8").trim() || null; } catch { content = null; }
  try { rmSync(p, { force: true }); } catch { /* best effort */ }
  return content;
}
