// effort.mjs — ticket 189 item 11: highest reasoning effort everywhere except
// Claude Sonnet/Opus. Pure helpers (no fs/network). The live catalog supplies
// per-model `variants`; BAKED_TOP is the fallback when the catalog is unreachable.

export const VARIANT_ORDER = Object.freeze(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
export const DEFAULT_EXEMPT = Object.freeze(["claude-pro/claude-sonnet-*", "claude-pro/claude-opus-*"]);

// Verified against the live catalog 2026-09-30 (ticket 189 item 11 table).
export const BAKED_TOP = Object.freeze({
  "openai/gpt-6-luna": "max",
  "openai/gpt-6-sol": "max",
  "opencode/muse-spark-1.3-contributor-free": "xhigh",
  "freebuff/glm-5.3-flash-max": "high",
  "claude-pro/claude-haiku-4-5": "max",
  "claude-pro/claude-fable-5": "max",
  "claude-pro/claude-fable-5-1": "max",
  "opencode/space-bunny-free": "max",
});

// Highest variant id present, by VARIANT_ORDER. Unknown ids rank below "none".
export function topVariant(variants) {
  const list = (Array.isArray(variants) ? variants : Object.keys(variants ?? {})).map((v) => String(v).toLowerCase());
  let best = null, bestRank = -1;
  for (const v of list) {
    const r = VARIANT_ORDER.indexOf(v);
    if (r > bestRank) { best = v; bestRank = r; }
  }
  return best;
}

function globToRe(g) {
  return new RegExp("^" + String(g).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
}

export function isExemptModel(model, globs = DEFAULT_EXEMPT) {
  const m = String(model ?? "").split("#")[0];
  return (globs ?? []).some((g) => globToRe(g).test(m));
}

// Decide the variant to send for a model. Returns { variant|null, reason }.
// catalog: { "<provider/model>": ["low","high",...] } (variants per model).
export function resolveEffort(model, { catalog = null, exempt = DEFAULT_EXEMPT, enforce = true, baked = BAKED_TOP } = {}) {
  const base = String(model ?? "").split("#")[0];
  if (!enforce) return { variant: null, reason: "enforce-off" };
  if (isExemptModel(base, exempt)) return { variant: null, reason: "exempt" };
  const fromCat = catalog && Object.prototype.hasOwnProperty.call(catalog, base) ? topVariant(catalog[base]) : null;
  if (fromCat) return { variant: fromCat === "none" ? null : fromCat, reason: "catalog" };
  if (catalog && Object.prototype.hasOwnProperty.call(catalog, base)) return { variant: null, reason: "no-variants" };
  const b = baked[base];
  return b ? { variant: b, reason: "baked-table" } : { variant: null, reason: "no-variants" };
}

// A variant rejection must NOT fail the seat: callers retry once without it.
export function isVariantRejection(text) {
  return /variant|reasoning[_ ]effort/i.test(String(text ?? "")) && /(unknown|invalid|unsupported|not supported|not a valid|rejected|unrecognized)/i.test(String(text ?? ""));
}

// Shell fragment for `opencode run`: "--variant 'xhigh'" or "".
export function variantFlag(variant) {
  return variant && /^[a-z0-9_-]+$/i.test(variant) ? `--variant '${variant}'` : "";
}

// Parse `opencode models <provider> --verbose` output: repeated blocks of
//   <provider>/<id>\n{ ...json... }
// into { "<provider>/<id>": ["variant", ...] }. Tolerates junk; never throws.
export function parseModelsVerbose(text) {
  const out = {};
  const s = String(text ?? "");
  const re = /^([a-z0-9._-]+\/[A-Za-z0-9._:\/-]+)\n(\{[\s\S]*?\n\})(?=\n[a-z0-9._-]+\/|\s*$)/gm;
  let m;
  while ((m = re.exec(s)) !== null) {
    try {
      const j = JSON.parse(m[2]);
      out[m[1].toLowerCase()] = Object.keys(j.variants ?? {});
    } catch { /* skip malformed block */ }
  }
  return out;
}

// Call `call(model, prompt, opts)` with the top variant; if the provider
// REJECTS the variant, retry ONCE without it (a variant error must not fail
// the seat/gate). Returns the result plus { variant, variantRetried }.
export function callWithEffortSync(call, model, prompt, opts, eff) {
  const v = eff?.variant ?? null;
  const r1 = call(model, prompt, { ...opts, variant: v });
  if (v && !r1.ok && isVariantRejection(r1.output)) {
    const r2 = call(model, prompt, { ...opts, variant: null });
    return { ...r2, variant: null, variantRetried: true, variantRejected: v };
  }
  return { ...r1, variant: v, variantRetried: false };
}

export async function callWithEffort(call, model, prompt, opts, eff) {
  const v = eff?.variant ?? null;
  const r1 = await call(model, prompt, { ...opts, variant: v });
  if (v && !r1.ok && isVariantRejection(r1.output)) {
    const r2 = await call(model, prompt, { ...opts, variant: null });
    return { ...r2, variant: null, variantRetried: true, variantRejected: v };
  }
  return { ...r1, variant: v, variantRetried: false };
}
