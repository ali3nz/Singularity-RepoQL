// The source-contract tests compare the Rust candidates against the actual
// JavaScript harness that remains production authority. The in-repo kit is the
// default so the source suite is self-contained; ORCHESTRA_REFERENCE_KIT can
// point at a pinned external extraction when testing a historical source.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const IN_REPO_KIT = resolve(fileURLToPath(new URL("../../kit/", import.meta.url)));
const configured = String(process.env.ORCHESTRA_REFERENCE_KIT ?? "").trim();

export const REFERENCE_KIT = configured || IN_REPO_KIT;
export const REFERENCE_KIT_SOURCE = configured ? "ORCHESTRA_REFERENCE_KIT" : "in-repo harness/kit";
