/** Authoritative RepoQL promotion verification. No alternative writer or store. */
import {execFileSync} from 'node:child_process';
import {readFileSync, existsSync, realpathSync, lstatSync} from 'node:fs';
import {join, resolve, relative, isAbsolute, matchesGlob} from 'node:path';
import {createHash} from 'node:crypto';

// Pin verified by the installed native 1.7.18 release gate and live SHA256.
export const RQL_VERSION = '1.7.18';
export const RQL_SHA256 = '06999056d987472edb937aecf204527b96b46dcf54bc9eea2ce7c1b364b56f3b';
export const RECEIPT_SCHEMA = 'selflearn.repoql-receipt.v1';
export const digest = value => createHash('sha256').update(value).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export const payloadDigest = value => digest(JSON.stringify(canonical(value)));
const normalized = text => String(text).replace(/\r\n/g, '\n');

export function pinnedRql() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA) throw new Error('native Windows RepoQL required');
  const executable = join(process.env.LOCALAPPDATA, 'rql', 'rql.exe');
  if (digest(readFileSync(executable)) !== RQL_SHA256) throw new Error('RepoQL executable pin mismatch');
  if (execFileSync(executable, ['--version'], {encoding: 'utf8', timeout: 10_000, shell: false, windowsHide: true}).trim() !== RQL_VERSION)
    throw new Error('RepoQL version pin mismatch');
  return executable;
}
export function invokeRql(args, root) {
  return execFileSync(pinnedRql(), args, {cwd: resolve(root), encoding: 'utf8', timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
}
export function promotionArguments(lesson, metadata) {
  const invariant = String(lesson?.text || lesson?.lesson || '');
  if (!invariant.trim() || invariant.startsWith('-') || invariant.includes('\0') || invariant.length > 239 || /[\r\n]/.test(invariant)) throw new Error('invalid invariant argument');
  const args = ['concept', 'add', metadata.conceptName, metadata.capsuleCategory, invariant, '--tags', metadata.tags.join(',')];
  if (metadata.capsuleCategory === 'principle') args.push('--universal');
  else args.push('--relevance', metadata.relevance);
  if (metadata.verification) args.push('--verification', metadata.verification, '--ttl-days', String(metadata.ttlDays));
  if (metadata.why) args.push('--why', metadata.why);
  if (metadata.example) args.push('--example', metadata.example);
  if (args.some(arg => String(arg).includes('\0'))) throw new Error('NUL argument refused');
  return {executable: 'pinned RepoQL 1.7.18', args, shell: false};
}
function confinedFile(root, name) {
  if (!name || isAbsolute(name) || name.includes('\\') || name.split('/').includes('..')) throw new Error('source path is not workspace-relative');
  const base = realpathSync(resolve(root));
  const file = resolve(base, name);
  for (let cursor = file; cursor !== base; cursor = resolve(cursor, '..')) {
    if (!relative(base, cursor) || relative(base, cursor).startsWith('..') || isAbsolute(relative(base, cursor))) throw new Error('source escapes workspace');
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('source reparse path refused');
  }
  if (!lstatSync(file).isFile() || realpathSync(file) !== file) throw new Error('source is not a regular confined file');
  return file;
}
export function evidenceSnapshot(record, root) {
  const metadata = record.promotion?.metadata;
  if (!metadata || !record.lesson) throw new Error('promotion metadata and lesson required');
  const refs = [...new Set(record.lesson.evidenceRefs || [])].sort();
  if (!refs.length) throw new Error('source evidence required');
  const sources = refs.map(ref => {
    const name = ref.replace(/^file:\/\/\//, '').split('#')[0];
    return {name, sha256: digest(readFileSync(confinedFile(root, name)))};
  });
  if (metadata.capsuleCategory !== 'principle') {
    for (const pattern of metadata.relevance.split(';')) {
      if (!sources.some(source => matchesGlob(source.name, pattern))) throw new Error('relevance does not match source evidence');
    }
  }
  for (const anchor of metadata.verification.split(';').filter(Boolean)) {
    const match = /^file:\/\/\/([^#]+)#(line=(\d+)(?:,(\d+))?|symbol=([A-Za-z_$][\w$]*))$/.exec(anchor);
    if (!match || !sources.some(source => source.name === match[1])) throw new Error('verification must anchor the supplied source evidence');
    const text = normalized(readFileSync(confinedFile(root, match[1]), 'utf8'));
    if (match[3]) {
      const first = Number(match[3]);
      const last = Number(match[4] || match[3]);
      if (first < 1 || last < first || last > text.split('\n').length) throw new Error('verification line outside source');
    } else {
      const escaped = match[5].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const definition = new RegExp('(?:^|\\n)\\s*(?:(?:export|async|public|static)\\s+)*(?:def|class|function|const|let|var)\\s+' + escaped + '(?![\\w$])');
      if (!definition.test(text)) throw new Error('verification symbol not defined in source');
    }
  }
  return {lesson: record.lesson, metadata, sources, verification: {
    state: record.verification?.state, pending: record.verification?.pending,
    satisfied: [...(record.verification?.satisfied || [])].sort(), note: record.verification?.note || ''}};
}
export function approvalPayload(record, root) {
  const payload = evidenceSnapshot(record, root);
  return {payload, digest: payloadDigest(payload)};
}
export function assertApproval(record, root, now = Date.now()) {
  const current = approvalPayload(record, root);
  const approval = record.promotion?.approval;
  const granted = Date.parse(approval?.grantedAt);
  const expires = Date.parse(approval?.expiresAt);
  if (!approval?.authority || approval.digest !== current.digest || !Number.isFinite(granted) || !Number.isFinite(expires)
      || granted > now || expires <= now || expires - granted > 86_400_000 || expires <= granted)
    throw new Error('current digest-bound unexpired approval required');
  return current;
}
export function conceptIdentity(metadata) {
  return ('concept:///' + metadata.capsuleCategory + '/' + metadata.conceptName + '.md').toLowerCase();
}
export function capsulePath(metadata, root) {
  return join(resolve(root), '.repoql', 'concepts', metadata.capsuleCategory, metadata.conceptName + '.md');
}
/** Distinguish authoritative absence from transport, parse and indexing errors. */
export function readConcept(metadata, root) {
  try {
    const records = JSON.parse(invokeRql(['read', conceptIdentity(metadata), '--json', '--token-budget', '24000'], root));
    if (!Array.isArray(records)) return {state: 'ERROR', reason: 'invalid RepoQL read result'};
    if (!records.length) return {state: 'ABSENT'};
    if (records.length !== 1 || records[0].representation !== 'Content' || typeof records[0].content !== 'string')
      return {state: 'ERROR', reason: 'authoritative content unavailable'};
    return {state: 'FOUND', record: records[0]};
  } catch (error) {
    // Native 1.7.18 deliberately returns exit 1 for an empty read. Only its
    // exact empty-result contract is absence. Transport errors stay ERROR.
    const emptyDiagnostic = "No records. Re-run without --json to see the host's diagnostics for this scope.";
    if (error.status === 1 && String(error.stdout).trim() === '[]' && String(error.stderr).trim() === emptyDiagnostic)
      return {state: 'ABSENT'};
    return {state: 'ERROR', reason: 'authoritative readback failed'};
  }
}
/** Parse only the native concept writer's supported frontmatter shape. */
export function parseCapsule(content) {
  const text = normalized(content);
  const match = /^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error('invalid capsule frontmatter');
  const metadata = {};
  let list = null;
  let nested = false;
  for (const line of match[1].split('\n')) {
    if (line.startsWith('  - ') && list === 'tags') { metadata.tags.push(JSON.parse(line.slice(4))); continue; }
    if (line.startsWith('  ') && nested) {
      const field = /^  (date|commit): (".*")$/.exec(line);
      if (!field || Object.hasOwn(metadata.verified, field[1])) throw new Error('invalid verification stamp');
      metadata.verified[field[1]] = JSON.parse(field[2]); continue;
    }
    const field = /^([a-z]+):(.*)$/.exec(line);
    if (!field || Object.hasOwn(metadata, field[1])) throw new Error('duplicate or invalid capsule metadata');
    const [, key, raw] = field;
    list = null; nested = false;
    if (key === 'tags' && !raw.trim()) { metadata.tags = []; list = key; }
    else if (key === 'verified' && !raw.trim()) { metadata.verified = {}; nested = true; }
    else if (['description', 'relevance', 'verification'].includes(key)) metadata[key] = JSON.parse(raw.trim());
    else if (key === 'category') metadata.category = raw.trim();
    else if (key === 'universal' && /^(true|false)$/.test(raw.trim())) metadata.universal = raw.trim() === 'true';
    else if (key === 'ttl' && /^\d+$/.test(raw.trim())) metadata.ttl = Number(raw.trim());
    else throw new Error('unsupported capsule metadata');
  }
  return {metadata, body: match[2]};
}
export function verifyReadback(record, authoritative, localContent, now = Date.now()) {
  const expected = record.promotion.metadata;
  if (String(authoritative.uri).toLowerCase() !== conceptIdentity(expected)) throw new Error('concept identity mismatch');
  if (normalized(authoritative.content) !== normalized(localContent)) throw new Error('authoritative and local capsule differ');
  const {metadata, body} = parseCapsule(authoritative.content);
  const invariant = String(record.lesson.text || record.lesson.lesson || '');
  let expectedBody = '## Capsule: ' + expected.conceptName + '\n\n**Invariant**\n' + invariant + '\n';
  if (expected.why) expectedBody += '\n**Why**\n' + expected.why + '\n';
  if (expected.example) expectedBody += '\n**Example**\n' + expected.example + '\n';
  if (body !== normalized(expectedBody) || metadata.description !== invariant || metadata.category !== expected.capsuleCategory
      || metadata.universal !== (expected.capsuleCategory === 'principle')
      || JSON.stringify(metadata.tags) !== JSON.stringify(expected.tags)
      || (metadata.relevance || '') !== expected.relevance || (metadata.verification || '') !== expected.verification
      || (metadata.ttl || 0) !== expected.ttlDays) throw new Error('concept content or metadata mismatch');
  if (expected.verification) {
    const date = Date.parse(metadata.verified?.date);
    if (!Number.isFinite(date) || date > now + 86_400_000 || now - date > expected.ttlDays * 86_400_000
        || typeof metadata.verified?.commit !== 'string') throw new Error('concept verification stamp invalid or expired');
  } else if (metadata.verified) throw new Error('unexpected verification stamp');
  return {schema: RECEIPT_SCHEMA, uri: conceptIdentity(expected), contentSha256: digest(normalized(authoritative.content)),
    verifiedAt: new Date(now).toISOString(), executableSha256: RQL_SHA256, version: RQL_VERSION};
}
export function verifyConcept(record, root, now = Date.now()) {
  const observed = readConcept(record.promotion.metadata, root);
  if (observed.state !== 'FOUND') throw new Error(observed.reason || 'authoritative concept missing');
  const path = capsulePath(record.promotion.metadata, root);
  confinedFile(root, relative(resolve(root), path).replaceAll('\\', '/'));
  return verifyReadback(record, observed.record, readFileSync(path, 'utf8'), now);
}
export function verifyAnchors(record, root) {
  for (const anchor of record.promotion.metadata.verification.split(';').filter(Boolean)) {
    const records = JSON.parse(invokeRql(['read', anchor, '--json', '--token-budget', '2000'], root));
    if (!Array.isArray(records) || !records.length) throw new Error('verification anchor readback failed');
    const sourceName = anchor.slice('file:///'.length).split('#')[0];
    const source = normalized(readFileSync(confinedFile(root, sourceName), 'utf8')).split('\n');
    for (const item of records) {
      const match = /^file:\/\/\/([^#]+)#line=(\d+),(\d+)(?:&symbol=[^&]+)?$/.exec(String(item.uri));
      if (item.representation !== 'Content' || !match || match[1] !== sourceName)
        throw new Error('verification anchor identity mismatch');
      const first = Number(match[2]);
      const last = Number(match[3]);
      if (first < 1 || last < first || last > source.length
          || normalized(item.content) !== source.slice(first - 1, last).join('\n'))
        throw new Error('verification anchor content differs from current source');
    }
  }
}
export function hasVerifiedPromotion(record, root) {
  const receipt = record?.promotion?.receipt;
  if (record?.state !== 'PROMOTED' || receipt?.schema !== RECEIPT_SCHEMA || !receipt.payloadDigest) return false;
  try {
    const verifiedAt = Date.parse(receipt.verifiedAt);
    if (!Number.isFinite(verifiedAt) || verifiedAt > Date.now() || receipt.authority !== record.promotion?.approval?.authority
        || assertApproval(record, root, verifiedAt).digest !== receipt.payloadDigest) return false;
    const current = verifyConcept(record, root);
    return receipt.uri === current.uri && receipt.contentSha256 === current.contentSha256
      && receipt.executableSha256 === RQL_SHA256;
  } catch { return false; }
}
