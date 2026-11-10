/** Verify the current canonical Markdown revision through the existing RepoQL. */
import {readFileSync, realpathSync, lstatSync} from 'node:fs';
import {resolve, relative, dirname, isAbsolute} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pinnedRql, RQL_VERSION, RQL_SHA256} from './selflearn-promotion.mjs';

export const normalizeDocument = text => String(text).replace(/\r\n/g, '\n');
export const documentHash = text => createHash('sha256').update(normalizeDocument(text)).digest('hex');

export function confinedDocument(root, document) {
  root = resolve(root);
  if (typeof document !== 'string' || !document || isAbsolute(document) || document.includes('\\') ||
      /[<>:"|?*\x00-\x1f]/.test(document) ||
      document.split('/').some(part => part === '..' || part === '.' || !part || /[. ]$/.test(part) ||
        /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part))) throw new Error('DOC_PATH_INVALID');
  const target = resolve(root, document);
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('DOC_PATH_OUTSIDE_ROOT');
  let at = target;
  while (dirname(at) !== at) {
    try { if (lstatSync(at).isSymbolicLink()) throw new Error('DOC_REPARSE_PATH_REFUSED'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    at = dirname(at);
  }
  return target;
}

function relativeUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file:///') || /[?#]/.test(uri)) throw new Error('REPOQL_SOURCE_IDENTITY_INVALID');
  const path = decodeURIComponent(uri.slice('file:///'.length));
  if (!path || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..'))
    throw new Error('REPOQL_SOURCE_IDENTITY_INVALID');
  return path;
}

export function verifyRepoqlReadback(records, {root, document, expectedHash}) {
  const target = confinedDocument(root, document);
  const canonical = relative(realpathSync(root), realpathSync(target)).replace(/\\/g, '/');
  const equal = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  if (!equal(canonical, document)) throw new Error('REPOQL_CANONICAL_PATH_MISMATCH');
  if (!Array.isArray(records)) throw new Error('REPOQL_READ_FORMAT_INVALID');
  const matches = records.filter(record => record?.representation === 'Content' &&
    typeof record.content === 'string' && equal(relativeUri(record.uri), canonical));
  if (matches.length !== 1) throw new Error('REPOQL_SOURCE_NOT_UNIQUE');
  const current = documentHash(readFileSync(target, 'utf8'));
  if (current !== expectedHash || documentHash(matches[0].content) !== current) throw new Error('REPOQL_CURRENT_REVISION_NOT_VERIFIED');
  return {status: 'REPOQL_VERIFIED', document: canonical, sourceUri: matches[0].uri,
    sourceSha256: current, repoqlVersion: RQL_VERSION, executableSha256: RQL_SHA256,
    verifiedAt: new Date().toISOString()};
}

export async function verifyRepoqlDocument({root, document, query, invoke, deadlineMs = Infinity}) {
  try {
    const run = invoke || ((args, directory) => {
      if (deadlineMs - Date.now() < 11_000) throw new Error('DOC_PASS_BUDGET_PENDING_REPOQL');
      const executable = pinnedRql();
      return execFileSync(executable, args, {cwd: resolve(directory), encoding: 'utf8',
        timeout: Math.max(1, Math.min(30_000, deadlineMs - Date.now())), maxBuffer: 2 * 1024 * 1024,
        windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe']});
    });
    const target = confinedDocument(root, document);
    const expectedHash = documentHash(readFileSync(target, 'utf8'));
    const search = JSON.parse(await run(['explore', query || document.replace(/[^a-zA-Z0-9]+/g, ' '),
      '--uri-glob', 'docs/**', '--json', '--token-budget', '2000'], root));
    if (!search || !Array.isArray(search.matches)) throw new Error('REPOQL_SEARCH_FORMAT_INVALID');
    const searchTarget = process.platform === 'win32' ? document.toLowerCase() : document;
    const found = search.matches.some(hit => {
      try {
        const path = relativeUri(hit.uri);
        return (process.platform === 'win32' ? path.toLowerCase() : path) === searchTarget;
      } catch { return false; }
    });
    if (!found) throw new Error('REPOQL_TARGET_NOT_DISCOVERABLE');
    const records = JSON.parse(await run(['read', `file:///${document}`, '--json', '--token-budget', '16000'], root));
    const receipt = verifyRepoqlReadback(records, {root, document, expectedHash});
    receipt.search = {query: query || document, matches: search.matches.length, performed: true};
    return receipt;
  } catch (error) {
    return {status: 'DOC_BLOCKED', verification: 'REPOQL_UNVERIFIED', document,
      reason: String(error.message).split('\n')[0], retryable: true};
  }
}
