/// <reference path="./repoql-connector.d.ts" />
// The Kanzo connector: it copies the whole Kanzo board into a workspace, as one Markdown file for each task with its
// comments, one for each project, and an overview. It is read-only: every request is a GET, and nothing is written
// back to the board. It follows help:///skills/writing-connectors/SKILL.md; QUESTIONS.md beside it is what step one
// left, manifest.yaml states what it asks for, README.md tells the person who installs it what it keeps,
// help/layout.md tells a reader how to ask, and sql/ holds the views a reader queries.
//
//   rql connector test connectors/kanzo/connector.ts --fixtures connectors/kanzo/suite.json
//   rql connector pack connector.ts --id RepoQL.Connectors.Kanzo --version 1.0.0 --authors fleet
//
// The source. Kanzo is the fleet's shared board. It serves a loopback-only HTTP API with no authentication, and one
// board:
//
//   GET /api/board?done=all   {changes, done_hidden, projects[], statuses[], tasks[], version}
//                             projects: id, slug, name, repos[], color, created_at, open, total
//                             tasks:    id, project (slug), title, description, tags[], human, status, position,
//                                       created_at, updated_at, comments (a count)
//   GET /api/tasks/<id>       {task, comments[{id, task_id, author, body, created_at}], images[]}
//   GET /api/changes          {changes: "<counter>"}   (not needed: the board states the same counter)
//
// A task's description carries machine-written HTML-comment envelopes of the Kanzo lifecycle broker:
//
//   <!-- kanzo-lifecycle:source:v1-begin -->  {...}  <!-- ...:source:v1-end -->   migration provenance, 493 cards
//   <!-- kanzo-lifecycle:claim:v1-begin -->   {...}  <!-- ...:claim:v1-end -->    a live claim, signed
//   <!-- kanzo-lifecycle:closure:v1-begin --> {...}  <!-- ...:closure:v1-end -->  a closure, written by close_work
//
// What the copy must hold, and what it must not:
//
// - Every fact of a card as frontmatter, so it can be counted and joined: the qualified native key, the raw column,
//   the project, tags, human, position, the two instants and the comment count. Nothing is inferred.
// - Migration provenance from a source envelope, field by field (legacy number and owner, source key, path, hash,
//   column and state at import, outcome, closure reason, sign-off, date basis), because that is the only record of
//   what an imported card was.
// - A closure envelope's meaningful outcome: outcome, declared outcome, mismatch, summary, validation, remaining,
//   sign-off, closed-at. Its session id, identity and receipt are dropped.
// - NOT a claim or a check envelope, in whole or in part: they are live coordination state with an HMAC signature.
//   `coordination_blocks_left_out` counts what was dropped of each card, so a reader knows something is missing.
//   A claim in the index is never authoritative: it is a copy of a moment, and the board is the live record.
// - NOT the signed envelopes' signatures, session ids or identities, anywhere.
// - NOT attachments (`/api/images`).
// - No credential that happens to be in a description or a comment, as far as `scrub` knows the shape: it is the
//   only guard, and README.md says so.
//
// Three promises a sweep keeps:
//
// - Fail-closed. One malformed, incomplete or contradictory answer fails the call, and a failed call publishes
//   nothing and removes nothing. A full listing is trusted only when every record validates, every id is unique,
//   every task's project is a listed project, and each project's `total` equals the tasks listed for it.
// - Deterministic. No call reads a clock for content, every list is written in a stable order, and the same board
//   writes the same bytes. A file is rewritten only when what it holds changed.
// - Removal on the source's word only. Every sweep reads the whole board and not a change feed, so a sweep that
//   completes removes a file whose record the complete, validated listing no longer names — and only then.
import { Connector, InvalidImport, type Changes, type FetchResult, type ImportTarget, type ImportUri, type Row, type Term } from 'repoql:connector';

// The board's own loopback address. The manifest grants this host and no other, and the connector builds every URL
// from it, so no answer can send a request anywhere else.
const BASE = 'http://localhost:4242';
const LISTING = '/api/board?done=all';

// A call may make 20 requests. One is the listing; the rest read the comments of cards that have some.
const COLLECTION = 'kanzo';
const RUN_KEY = '@run';
const META_KEY = '@board';
const SHAPE = 2;
const VALUE_CHUNK = 4000;
const PAGE = 500;

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const REPO = /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

// One card of the board listing, after validation. Its description is the raw text, envelopes and all.
interface Card {
  id: number; project: string; title: string; description: string; tags: string[];
  human: boolean; status: string; position: number; created: string; updated: string; comments: number;
  source: Provenance | null; closure: Closure | null; dropped: number;
}
interface Project {
  id: number; slug: string; name: string; repos: string[]; color: string | null;
  created: string; open: number; total: number;
}
interface Board { version: string; changes: string; statuses: string[]; projects: Project[]; cards: Card[] }
interface Comment { id: number; author: string; created: string; body: string; closure: Closure | null }
// What migration provenance a card's file shows. Every member is optional: a card that was not imported has none.
interface Provenance {
  imported_at?: string; importer?: string; source_key?: string; source_path?: string; source_sha256?: string;
  source_state?: string; source_column?: string; status_at_import?: string; legacy_number?: string;
  legacy_owner?: string; outcome?: string; closure_reason?: string; operator_signoff?: string;
  date_basis?: string; record_date?: string; flags?: string[]; area?: string;
}
// What a closure envelope says that a reader needs. Its session, identity and receipt are dropped.
interface Closure {
  closed_at: string; outcome: string; declared_outcome: string; outcome_mismatch: boolean; summary: string;
  validation: { name: string; result: string; evidence: string }[]; remaining: string[];
  operator_signoff: string; closure_policy: string; target_status: string;
}
// The text of one field after the broker's envelopes are taken out of it.
interface Unwrapped { text: string; source: Provenance | null; closure: Closure | null; dropped: number }
interface KeptCard { kind: 'card-state'; shape: number; updated: string; comments: number; changes: string }
interface BoardMeta {
  kind: 'board-meta'; version: string; changes: string; statuses: string[]; projects: Project[];
  began: string; taskCount: number; commentCount: number; tasksWithComments: number;
  migrated: number; humanTasks: number; byStatus: Record<string, number>; lastChange: string;
}
interface CardSnapshot { kind: 'card-snapshot'; card: Card }
interface Run { kind: 'run'; board: BoardMeta; needs: number[]; next: number }
interface FileRow {
  kind: 'file'; path: string; part: number; parts: number; content: string; time: string; origin: string;
  taskId?: number; projectSlug?: string;
}
type Stored = FileRow | KeptCard | BoardMeta | CardSnapshot | Run;
interface OutputFile { path: string; text: string; time: string; origin: string }

// Every value copied from an answer is held to its type first. A value of another type fails the call, which
// publishes nothing and removes nothing. The error names the member and never the value.
function refuse(what: string): never {
  throw new Error(`The Kanzo board answered with ${what}. The call fails, so nothing is published and nothing is removed.`);
}
const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const object = (value: unknown, what: string): Record<string, unknown> => isObject(value) ? value : refuse(`${what} that is not an object`);
const list = (value: unknown, what: string): unknown[] => Array.isArray(value) ? value : refuse(`${what} that is not a list`);
const text = (value: unknown, what: string): string =>
  typeof value === 'string' ? value : refuse(`${what} that is not text`);
const filled = (value: unknown, what: string): string => {
  const words = text(value, what).trim();
  if (!words) refuse(`${what} that is empty`);
  return words.replace(/\s+/g, ' ');
};
const count = (value: unknown, what: string): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : refuse(`${what} that is not a whole number from 0`);
const number = (value: unknown, what: string): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : refuse(`${what} that is not a number`);
const boolean = (value: unknown, what: string): boolean =>
  typeof value === 'boolean' ? value : refuse(`${what} that is not true or false`);
const instant = (value: unknown, what: string): string => {
  const at = text(value, what);
  if (!INSTANT.test(at) || Number.isNaN(Date.parse(at))) refuse(`${what} that is not an instant`);
  return at;
};
const optionalInstant = (value: unknown, what: string): string => value === undefined || value === null ? '' : instant(value, what);

// A fact of a file as YAML frontmatter, one a line. A value is written as JSON, which is YAML too.
const facts = (pairs: [string, unknown][]): string =>
  `---\n${pairs.map(([name, value]) => `${name}: ${JSON.stringify(value)}`).join('\n')}\n---\n\n`;
// A string as a Markdown code span, for a value a reader may copy.
const code = (value: string): string => '`' + value.replace(/`/g, '\u0060\u200b') + '`';
const when = (at: string): string => at.replace('T', ' ').replace(/Z$/, ' UTC');

// ---------------------------------------------------------------------------------------------------------------------
// Credentials in free text.
//
// The host scans what a connector publishes only for the secrets the connector was handed. This connector reads no
// secret, so a token pasted into a card's description is its own to remove. Each pattern below replaces the value
// and keeps the name, so the sentence still reads. They are shapes, not proofs: a shape not listed here is written.
const CREDENTIALS: [RegExp, string][] = [
  // A whole PEM private key.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key removed]'],
  // Authorization headers, in either order of scheme and name.
  [/(\bauthorization\s*[:=]\s*)(bearer|basic|token|digest)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1$2 [redacted]'],
  [/\b(bearer)\s+[A-Za-z0-9._~+/=-]{10,}/gi, '$1 [redacted]'],
  // A named credential followed by a value: API_KEY=..., password: ..., client_secret = "...", --password xxx.
  // A name that says it is a credential, however the name is spelled: KANZO_TOKEN=, API_KEY=, password:, --secret.
  [/(\b[A-Za-z0-9_.-]{0,40}(?:api[_-]?key|apikey|access[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|id[_-]?token|password|passwd|pwd|secret|token|credential|passphrase)\b\s*[:=]\s*)(["']?)([^\s"'`,;]{6,})\2/gi, '$1[redacted]'],
  [/(--?(?:password|passwd|token|api-key|apikey|secret)[= ]\s*)(["']?)([^\s"'`,;]{6,})\2/gi, '$1[redacted]'],
  // Shapes that carry their own name.
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[redacted]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g, '[redacted]'],
  [/\bsk-(?:live|test|proj)?-?[A-Za-z0-9_-]{16,}\b/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]'],
  // user:password@ in a URL.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s\/:@]+:[^\s\/@]+@/gi, '$1[redacted]@'],
  // A signature of the board's broker, if one ever reaches free text outside its envelope.
  [/\bhmac-sha256:[0-9a-f]{32,}\b/gi, '[signature removed]'],
];
function scrub(input: string): string {
  let out = input;
  for (const [pattern, replacement] of CREDENTIALS) out = out.replace(pattern, replacement);
  // A value that is only a run of hex or base64 is not scrubbed here: provenance hashes are hex by design, and a
  // pattern for "long random text" would take them. The list above is the whole guard, as README.md says.
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The broker's envelopes.
//
// Each is an HTML comment pair around one JSON object. `unwrap` takes every pair out of a text, keeps what is
// meaningful of a source or a closure envelope, and counts the claim and check envelopes it dropped. An envelope
// that is not closed, or whose JSON does not parse, fails the call: a half-written claim must not be read as no
// claim at all.
const MARKER = /<!--\s*kanzo-lifecycle:([a-z][a-z-]*):(v[0-9]+)-(begin|end)\s*-->/g;

function unwrap(raw: string, what: string): Unwrapped {
  let text = raw;
  const parts: string[] = [];
  let source: Provenance | null = null;
  let closure: Closure | null = null;
  let dropped = 0;
  let cursor = 0;
  const pattern = new RegExp(MARKER.source, 'g');
  const marks: { kind: string; begin: number; end: number }[] = [];
  let open: { kind: string; begin: number; textStart: number } | null = null;
  for (let match = pattern.exec(raw); match; match = pattern.exec(raw)) {
    const [, kind, , side] = match;
    if (side === 'begin') {
      if (open) refuse(`${what} with one ${open.kind} envelope inside another`);
      open = { kind, begin: match.index, textStart: match.index + match[0].length };
    } else {
      if (!open || open.kind !== kind) refuse(`${what} with a ${kind} envelope that does not close the one open`);
      marks.push({ kind, begin: open.begin, end: match.index + match[0].length });
      const body = raw.slice(open.textStart, match.index).trim();
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { refuse(`${what} with a ${kind} envelope that is not JSON`); }
      if (!isObject(parsed)) refuse(`${what} with a ${kind} envelope that is not a JSON object`);
      if (kind === 'source') source = provenance(parsed, what);
      else if (kind === 'closure') closure = closureOf(parsed, what);
      else dropped++;
      open = null;
    }
  }
  if (open) refuse(`${what} with a ${open.kind} envelope that never closes`);
  for (const mark of marks) {
    parts.push(raw.slice(cursor, mark.begin));
    cursor = mark.end;
  }
  parts.push(raw.slice(cursor));
  text = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text, source, closure, dropped };
}

// The fields of a migration source envelope. Every value is taken as the broker wrote it, or left out; a value of
// another type is a malformed envelope, and fails the call like any other malformed answer.
function provenance(body: Record<string, unknown>, what: string): Provenance {
  const at = (key: string): string => {
    const value = body[key];
    if (value === undefined || value === null) return '';
    return typeof value === 'string' ? value : refuse(`${what} with a source ${key} that is not text`);
  };
  const flags = body.flags === undefined || body.flags === null ? [] : list(body.flags, `${what} source flags`);
  const out: Provenance = {};
  const set = (key: keyof Provenance, value: unknown) => { if (value !== '' && value !== undefined) (out as Record<string, unknown>)[key] = value; };
  set('imported_at', at('imported_at'));
  set('importer', at('importer'));
  set('source_key', at('source_key'));
  set('source_path', at('source_path'));
  set('source_sha256', at('source_sha256'));
  set('source_state', at('source_state'));
  set('source_column', at('source_column'));
  set('status_at_import', at('status_at_import'));
  set('legacy_number', at('legacy_number'));
  set('legacy_owner', at('legacy_owner'));
  set('outcome', at('outcome'));
  set('closure_reason', at('closure_reason'));
  set('operator_signoff', at('operator_signoff'));
  set('date_basis', at('date_basis'));
  set('record_date', at('record_date'));
  set('area', at('area'));
  if (flags.length) set('flags', flags.map(flag => text(flag, `${what} source flag`)));
  return out;
}

// The fields of a closure envelope that say what happened. The broker also writes two things here that are its own
// coordination state and not an outcome, and they are dropped: the session id and identity of the caller, and the
// claim's receipt. The signature is dropped with the envelope.
function closureOf(body: Record<string, unknown>, what: string): Closure {
  const str = (key: string): string => typeof body[key] === 'string' ? body[key] as string : '';
  const checks = body.validation === undefined || body.validation === null
    ? []
    : list(body.validation, `${what} closure validation`).map((entry) => {
      const row = object(entry, `${what} closure validation row`);
      return { name: filled(row.name, `${what} closure validation name`), result: filled(row.result, `${what} closure validation result`), evidence: str('evidence') };
    });
  const remaining = body.remaining === undefined || body.remaining === null
    ? []
    : list(body.remaining, `${what} closure remaining`).map(item => text(item, `${what} closure remaining item`));
  return {
    closed_at: str('closed_at'), outcome: str('outcome'), declared_outcome: str('declared_outcome'),
    outcome_mismatch: body.outcome_mismatch === true, summary: str('summary'), validation: checks, remaining,
    operator_signoff: str('operator_signoff'), closure_policy: str('closure_policy'), target_status: str('target_status'),
  };
}

export default class Kanzo extends Connector {
  // An import is kanzo://board. There is one board on this machine, and the connector reaches only its loopback
  // address, so a URI that names anything else is refused before anything is imported.
  static parse(uri: ImportUri): ImportTarget {
    if (uri.authority !== 'board' || uri.path.length > 0 || uri.query.length > 0)
      throw new InvalidImport('A Kanzo import is kanzo://board and names nothing else. This connector copies the one ' +
        'board the Kanzo service on this machine serves; the board is the whole scope.');
    return { root: 'kanzo://board/', title: 'Kanzo board' };
  }

  fetch(cursor?: string): FetchResult {
    if (this.pass?.full !== true) throw new Error('Kanzo requires a complete validated board listing; no rows were removed.');
    let run: Run;
    if (cursor === undefined) {
      const board = this.listing();
      run = { kind: 'run', board: this.boardMeta(board, this.clock.now()), needs: [], next: 0 };
      this.prepareBoard(board, run);
      this.db.put<BoardMeta>(COLLECTION, META_KEY, run.board);
      this.db.put<Run>(COLLECTION, RUN_KEY, run);
    } else {
      const found = this.db.get<Run>(COLLECTION, RUN_KEY);
      if (!this.validRun(found)) throw new Error('The saved Kanzo listing is missing or malformed; no rows were removed.');
      run = found;
      let position: unknown;
      try { position = JSON.parse(cursor); } catch { refuse('a cursor that is not JSON'); }
      const row = object(position, 'a cursor');
      const next = count(row.next, 'a cursor position');
      if (next !== run.next || next > run.needs.length) throw new Error('The saved Kanzo cursor does not match its validated listing; no rows were removed.');
    }
    return this.finishFetch(run);
  }

  private validRun(value: unknown): value is Run {
    if (!isObject(value) || value.kind !== 'run' || !Array.isArray(value.needs) || typeof value.next !== 'number' || !Number.isInteger(value.next) || value.next < 0) return false;
    return value.needs.every(id => Number.isInteger(id) && id > 0) && isObject(value.board) && value.board.kind === 'board-meta';
  }

  private boardMeta(board: Board, began: string): BoardMeta {
    const byStatus = Object.create(null) as Record<string, number>;
    for (const status of board.statuses) byStatus[status] = board.cards.filter(card => card.status === status).length;
    const lastChange = board.cards.reduce((newest, card) => Date.parse(card.updated) > Date.parse(newest) ? card.updated : newest, '1970-01-01T00:00:00Z');
    return {
      kind: 'board-meta', version: board.version, changes: board.changes, statuses: board.statuses, projects: board.projects, began,
      taskCount: board.cards.length, commentCount: board.cards.reduce((sum, card) => sum + card.comments, 0),
      tasksWithComments: board.cards.filter(card => card.comments > 0).length,
      migrated: board.cards.filter(card => card.source !== null).length, humanTasks: board.cards.filter(card => card.human).length, byStatus, lastChange,
    };
  }

  private stateKey(id: number): string { return `state|${id}`; }
  private snapshotKey(id: number): string { return `snapshot|${id}`; }
  private fileKey(path: string, part: number): string { return `file|${encodeURIComponent(path)}|${String(part).padStart(6, '0')}`; }

  private putFile(path: string, contents: string, modified: string, origin: string, taskId?: number, projectSlug?: string): void {
    const chunks: string[] = [];
    if (!contents.length) chunks.push('');
    else for (let at = 0; at < contents.length; at += VALUE_CHUNK) chunks.push(contents.slice(at, at + VALUE_CHUNK));
    for (let part = 0; part < chunks.length; part += 1) {
      const row: FileRow = { kind: 'file', path, part, parts: chunks.length, content: chunks[part], time: modified, origin };
      if (taskId !== undefined) row.taskId = taskId;
      if (projectSlug !== undefined) row.projectSlug = projectSlug;
      this.db.put<FileRow>(COLLECTION, this.fileKey(path, part), row, { time: modified });
    }
  }

  private rows(): Row<Stored>[] {
    const rows: Row<Stored>[] = [];
    let after: string | undefined;
    do {
      const page = this.db.list<Stored>(COLLECTION, { after, limit: PAGE });
      rows.push(...page.rows);
      after = page.next;
    } while (after !== undefined);
    return rows;
  }

  private existingTaskFiles(): Map<number, FileRow[]> {
    const grouped = new Map<number, FileRow[]>();
    for (const row of this.rows()) {
      const value = row.value as Stored;
      if (value.kind !== 'file' || value.taskId === undefined) continue;
      const found = grouped.get(value.taskId) ?? [];
      found.push(value);
      grouped.set(value.taskId, found);
    }
    return grouped;
  }

  private touchTask(id: number, files: Map<number, FileRow[]>): boolean {
    const parts = (files.get(id) ?? []).sort((a, b) => a.part - b.part);
    if (!parts.length || parts.length !== parts[0].parts || parts.some((part, index) => part.part !== index || part.parts !== parts.length)) return false;
    const keys = parts.map(part => this.fileKey(part.path, part.part));
    for (let at = 0; at < keys.length; at += PAGE) this.db.touch(COLLECTION, keys.slice(at, at + PAGE));
    return true;
  }

  private prepareBoard(board: Board, run: Run): void {
    const projects = new Map(board.projects.map(project => [project.slug, project]));
    const oldFiles = this.existingTaskFiles();
    const newest = newestUpdate(board);
    for (const project of board.projects) this.writeProject(project, board, newest(project.slug));
    for (const card of board.cards) {
      const stateKey = this.stateKey(card.id);
      const held = this.db.get<KeptCard>(COLLECTION, stateKey);
      const needsDetails = card.comments > 0 && (!held || held.kind !== 'card-state' || held.shape !== SHAPE ||
        held.comments !== card.comments || held.updated !== card.updated || held.changes !== board.changes);
      if (card.comments === 0) {
        this.writeCard(card, projects.get(card.project)!, [], board);
        this.db.put<KeptCard>(COLLECTION, stateKey, { kind: 'card-state', shape: SHAPE, updated: card.updated, comments: card.comments, changes: board.changes });
      } else if (needsDetails || !this.touchTask(card.id, oldFiles)) {
        this.db.put<CardSnapshot>(COLLECTION, this.snapshotKey(card.id), { kind: 'card-snapshot', card });
        run.needs.push(card.id);
      }
    }
  }

  private finishFetch(run: Run): FetchResult {
    const projects = new Map(run.board.projects.map(project => [project.slug, project]));
    while (run.next < run.needs.length) {
      if (this.signal.aborted) {
        this.db.put<Run>(COLLECTION, RUN_KEY, run);
        return { cursor: JSON.stringify({ next: run.next }) };
      }
      const id = run.needs[run.next];
      const snapshot = this.db.get<CardSnapshot>(COLLECTION, this.snapshotKey(id));
      if (!snapshot || snapshot.kind !== 'card-snapshot' || snapshot.card.id !== id) throw new Error(`The saved Kanzo task ${id} is missing; no rows were removed.`);
      const project = projects.get(snapshot.card.project);
      if (!project) throw new Error(`The saved Kanzo project for task ${id} is missing; no rows were removed.`);
      const comments = this.comments(snapshot.card, project);
      this.writeCard(snapshot.card, project, comments, { ...run.board, cards: [snapshot.card] });
      this.db.put<KeptCard>(COLLECTION, this.stateKey(id), { kind: 'card-state', shape: SHAPE, updated: snapshot.card.updated,
        comments: snapshot.card.comments, changes: run.board.changes });
      this.db.remove(COLLECTION, this.snapshotKey(id));
      run.next += 1;
      this.db.put<Run>(COLLECTION, RUN_KEY, run);
      if (this.signal.aborted && run.next < run.needs.length) return { cursor: JSON.stringify({ next: run.next }) };
    }

    this.writeOverview(run.board);
    this.db.remove(COLLECTION, RUN_KEY);
    return { removeUnseen: true };
  }

  // One complete board, read and validated. Nothing is written from an answer that does not pass every check here:
  // a broken answer read as an empty board would end a full sweep early, and the sweep would then remove every file
  // it had not listed and report success.
  private listing(): Board {
    const reply = this.send(LISTING);
    if (reply.status !== 200)
      throw new Error(`The Kanzo board answered HTTP status ${reply.status} for ${LISTING}, so the call fails and ` +
        'nothing is published or removed. Is kanzo.service running?');
    const body = object(reply.body, `the answer to ${LISTING}`);
    const version = filled(body.version, 'a version');
    const changes = filled(body.changes, 'a changes counter');
    const hidden = count(body.done_hidden, 'done_hidden');
    if (hidden !== 0)
      throw new Error(`The Kanzo board answered with ${hidden} done cards hidden although the listing asked for all ` +
        `of them, so the answer is incomplete. The call fails and nothing is published or removed.`);
    const statuses = list(body.statuses, 'statuses').map(status => filled(status, 'a status'));
    if (!statuses.length) refuse('an empty statuses list');
    if (new Set(statuses).size !== statuses.length) refuse('a statuses list that names a status twice');

    const projects = list(body.projects, 'projects').map((entry): Project => {
      const row = object(entry, 'a project');
      const slug = filled(row.slug, 'a project slug');
      if (!SLUG.test(slug)) refuse('a project slug that is not a slug');
      const repos = list(row.repos, `the repos of project ${slug}`).map(repo => {
        const name = filled(repo, `a repo of project ${slug}`);
        if (!REPO.test(name)) refuse(`a repo of project ${slug} that is not owner/name`);
        return name;
      });
      const color = row.color === null || row.color === undefined ? null : filled(row.color, `the colour of project ${slug}`);
      return {
        id: count(row.id, `the id of project ${slug}`), slug, name: scrub(filled(row.name, `the name of project ${slug}`)),
        repos, color, created: instant(row.created_at, `the created_at of project ${slug}`),
        open: count(row.open, `the open count of project ${slug}`), total: count(row.total, `the total of project ${slug}`),
      };
    });
    if (!projects.length) refuse('an empty projects list');
    if (new Set(projects.map(project => project.slug)).size !== projects.length) refuse('a project listed twice');
    if (new Set(projects.map(project => project.id)).size !== projects.length) refuse('two projects with the same id');
    const slugs = new Set(projects.map(project => project.slug));

    const seen = new Set<number>();
    const cards = list(body.tasks, 'tasks').map((entry): Card => {
      const row = object(entry, 'a task');
      const id = count(row.id, 'a task id');
      if (id === 0) refuse('a task with id 0');
      if (seen.has(id)) refuse(`a task id ${id} listed twice`);
      seen.add(id);
      const project = this.projectSlug(row.project, projects, `the project of task ${id}`);
      if (!slugs.has(project)) refuse(`task ${id} in a project the answer does not list`);
      const status = filled(row.status, `the status of task ${id}`);
      if (!statuses.includes(status)) refuse(`task ${id} with a status the answer does not list`);
      const tags = list(row.tags ?? [], `the tags of task ${id}`).map(tag => filled(tag, `a tag of task ${id}`));
      const unwrapped = unwrap(text(row.description ?? '', `the description of task ${id}`), `task ${id} description`);
      return {
        id, project, title: scrub(filled(row.title, `the title of task ${id}`)),
        description: scrub(unwrapped.text), source: unwrapped.source, closure: unwrapped.closure, dropped: unwrapped.dropped,
        tags: [...new Set(tags)].sort(), human: boolean(row.human, `the human flag of task ${id}`), status,
        position: number(row.position, `the position of task ${id}`),
        created: instant(row.created_at, `the created_at of task ${id}`),
        updated: instant(row.updated_at, `the updated_at of task ${id}`),
        comments: count(row.comments, `the comment count of task ${id}`),
      };
    });

    // The board states, for each project, how many tasks it holds. A listing that agrees with none of them is not the
    // whole board: the connector reads that as incomplete rather than as a board that shrank.
    for (const project of projects) {
      const listed = cards.filter(card => card.project === project.slug).length;
      if (listed !== project.total)
        throw new Error(`The Kanzo board answered with ${listed} tasks in project ${project.slug}, and states the ` +
          `project holds ${project.total}. The listing is incomplete or inconsistent, so the call fails and nothing ` +
          'is published or removed.');
    }
    return { version, changes, statuses, projects, cards };
  }

  private projectSlug(value: unknown, projects: Project[], what: string): string {
    if (typeof value === 'string') {
      const slug = filled(value, what);
      if (projects.some(project => project.slug === slug)) return slug;
      return refuse(`${what} that names no listed project`);
    }
    return refuse(`${what} that is not a project slug string`);
  }

  // One card's comments, from the board's own detail answer. The listing said how many there are, and this answer
  // must hold that many: a count that moved while the sweep read means the sweep and the board disagree, and the
  // next sweep reads both again.
  private comments(card: Card, project: Project): Comment[] {
    const path = `/api/tasks/${card.id}`;
    const reply = this.send(path);
    if (reply.status === 404)
      throw new Error(`The Kanzo board listed task ${card.id} and then answered HTTP 404 for ${path}. The board ` +
        'changed while the sweep read it, so the call fails and nothing is published or removed.');
    if (reply.status !== 200)
      throw new Error(`The Kanzo board answered HTTP status ${reply.status} for ${path}, so the call fails.`);
    const body = object(reply.body, `the answer to ${path}`);
    const task = object(body.task, `the task of ${path}`);
    if (count(task.id, `the id of the task of ${path}`) !== card.id) refuse(`something other than task ${card.id} for ${path}`);
    const detailProject = this.projectSlug(task.project, [project], `the project of the task of ${path}`);
    if (detailProject !== project.slug) refuse(`task ${card.id} in another project than the listing states`);
    const rows = list(body.comments ?? [], `the comments of task ${card.id}`);
    const comments = rows.map((entry): Comment => {
      const row = object(entry, `a comment of task ${card.id}`);
      if (count(row.task_id, `the task_id of a comment of task ${card.id}`) !== card.id)
        refuse(`a comment of task ${card.id} that belongs to another task`);
      const author = text(row.author ?? '', `the author of a comment of task ${card.id}`).trim();
      const unwrapped = unwrap(text(row.body ?? '', `the body of a comment of task ${card.id}`), `a comment on task ${card.id}`);
      return {
        id: count(row.id, `the id of a comment of task ${card.id}`),
        author: author ? scrub(author.replace(/\s+/g, ' ')) : 'unknown',
        created: instant(row.created_at, `the created_at of a comment of task ${card.id}`),
        body: scrub(unwrapped.text), closure: unwrapped.closure,
      };
    }).sort((a, b) => a.created === b.created ? a.id - b.id : a.created < b.created ? -1 : 1);
    if (comments.length !== card.comments)
      throw new Error(`The Kanzo board listed ${card.comments} comments on task ${card.id}, and ${path} answered ` +
        `${comments.length}. The board changed while the sweep read it, so the call fails and nothing is published ` +
        'or removed; the next sweep reads it whole.');
    return comments;
  }

  // One card's file. Its facts are the board's, with no inference: `open` is the board's own reading of its columns
  // (a card is open until it is done), the key is the qualified native id, and provenance is what the card's source
  // envelope said. The body carries the card's own words and the whole comment thread.
  private writeCard(card: Card, project: Project, comments: Comment[], board: Board): void {
    const path = `tasks/${card.id}.md`;
    const key = `${card.project}#${card.id}`;
    const closure = { text: card.description, source: card.source, closure: card.closure, dropped: card.dropped };
    const source = card.source;
    const open = card.status !== 'done';
    const said = card.comments === 0 ? 'no comments' : card.comments === 1 ? '1 comment' : `${card.comments} comments`;
    const description = open
      ? `${card.title}. Open, column ${card.status}, in project ${project.name}; ${said}.`
      : `${card.title}. Closed administratively in project ${project.name}, which is not a claim that the work succeeded; ${said}.`;
    const pairs: [string, unknown][] = [
      ['title', card.title], ['description', description], ['kind', 'task'],
      ['key', key], ['id', card.id], ['project', card.project], ['project_name', project.name],
      ['status', card.status], ['open', open], ['human', card.human], ['tags', card.tags],
      ['position', card.position], ['comments', card.comments],
      ['created', card.created], ['updated', card.updated], ['repos', project.repos],
      ['migrated', !!source],
    ];
    if (source) {
      const order: [keyof Provenance, string][] = [
        ['source_key', 'source_key'], ['source_path', 'source_path'], ['source_sha256', 'source_sha256'],
        ['source_state', 'source_state'], ['source_column', 'source_column'], ['status_at_import', 'status_at_import'],
        ['legacy_number', 'legacy_number'], ['legacy_owner', 'legacy_owner'], ['outcome', 'outcome'],
        ['closure_reason', 'closure_reason'], ['operator_signoff', 'operator_signoff'], ['date_basis', 'date_basis'],
        ['record_date', 'record_date'], ['flags', 'flags'], ['area', 'area'], ['imported_at', 'imported_at'],
        ['importer', 'importer'],
      ];
      for (const [member, name] of order) {
        const value = source[member];
        if (value !== undefined && value !== '') pairs.push([name, value]);
      }
    }
    if (closure.dropped) pairs.push(['coordination_blocks_left_out', closure.dropped]);

    const lines: string[] = [];
    lines.push(`# ${key} ${card.title}`, '');
    if (closure.text) lines.push(scrub(closure.text), '');
    lines.push('## Board state', '');
    lines.push(`- Native key: ${code(key)}`);
    lines.push(`- Project: [${project.name}](../projects/${project.slug}.md) (${code(card.project)})`);
    lines.push(`- Column: ${code(card.status)}${open ? '' : ' — administratively closed; the board does not say the work succeeded'}`);
    lines.push(`- Tags: ${card.tags.length ? card.tags.map(tag => code(tag)).join(', ') : 'none'}`);
    lines.push(`- Human task: ${card.human ? 'yes — a card for the person, which the agent lifecycle never closes' : 'no'}`);
    lines.push(`- Position on the board: ${card.position}`);
    lines.push(`- Created ${when(card.created)}; last changed ${when(card.updated)}`);
    lines.push(`- Comments: ${card.comments}`);
    if (project.repos.length) lines.push(`- Repositories: ${project.repos.map(repo => code(repo)).join(', ')}`);
    if (closure.dropped)
      lines.push(`- Lifecycle envelopes left out of this file: ${closure.dropped} (a claim or a check is live ` +
        'coordination state and is never copied; ask the board who holds this card now)');
    lines.push('');

    if (source) {
      lines.push('## Migration provenance', '');
      lines.push('This card was imported from an older record. These are the fields the importer wrote, as it wrote them.', '');
      const rows: [string, unknown][] = [
        ['Source key', source.source_key], ['Source path', source.source_path], ['Source SHA-256', source.source_sha256],
        ['Source state', source.source_state], ['Source column', source.source_column], ['Status at import', source.status_at_import],
        ['Legacy number', source.legacy_number], ['Legacy owner', source.legacy_owner], ['Outcome recorded', source.outcome],
        ['Closure reason', source.closure_reason], ['Operator sign-off', source.operator_signoff],
        ['Date basis', source.date_basis], ['Record date', source.record_date],
        ['Flags', source.flags?.length ? source.flags.join(', ') : ''], ['Area', source.area],
        ['Imported at', source.imported_at], ['Importer', source.importer],
      ];
      for (const [name, value] of rows)
        if (value !== undefined && value !== '' && value !== null) lines.push(`- ${name}: ${code(String(value))}`);
      lines.push('');
    }

    const rendered = comments.map(comment => this.comment(comment));
    if (card.comments === 0) {
      lines.push('## Comments', '', 'The board holds no comment on this card.', '');
    } else {
      lines.push(`## Comments (${card.comments})`, '');
      for (const block of rendered) lines.push(block, '');
    }
    this.putFile(path, `${facts(pairs)}${lines.join('\n').replace(/\n+$/, '')}\n`, card.updated,
      `${BASE}/#${card.project}/${card.id}`, card.id);
  }

  // One comment as a section. A comment that holds a closure envelope is the broker's own record of a closure, so
  // its meaningful fields are set out and the boilerplate around them is dropped with the envelope. Any other
  // comment is its own text, scrubbed.
  private comment(entry: Comment): string {
    const head = `### ${entry.author.replace(/[\r\n]+/g, ' ')}, ${when(entry.created)}`;
    if (!entry.closure) {
      const body = entry.body ? scrub(entry.body) : '(no text)';
      return `${head}\n\n${body}`;
    }
    const closure = entry.closure;
    const lines: string[] = [head, '', 'A closure the Kanzo lifecycle broker recorded. Its session and signature are not copied.', ''];
    lines.push(`- Outcome: ${code(closure.outcome || 'not stated')}`);
    if (closure.declared_outcome) lines.push(`- Declared by the caller: ${code(closure.declared_outcome)}${closure.outcome_mismatch ? ' (it differs from the outcome the checks gave)' : ''}`);
    if (closure.operator_signoff) lines.push(`- Operator sign-off: ${code(closure.operator_signoff)}`);
    if (closure.closed_at) lines.push(`- Closed at: ${code(closure.closed_at)}`);
    if (closure.closure_policy) lines.push(`- Closure policy: ${code(closure.closure_policy)}`);
    if (closure.summary) lines.push('', scrub(closure.summary));
    if (closure.validation.length) {
      lines.push('', 'Validation as the closure recorded it:', '');
      for (const check of closure.validation)
        lines.push(`- ${check.name}: ${check.result}${check.evidence ? ` — ${scrub(check.evidence)}` : ''}`);
    }
    if (closure.remaining.length) {
      lines.push('', 'Left undone, as the closure recorded it:', '');
      for (const item of closure.remaining) lines.push(`- ${scrub(item)}`);
    }
    return lines.join('\n');
  }
  // One project's file. Its counts are the board's own, so they move when a card moves; the file's time is the last
  // change of any card in it, and never this machine's clock.
  private writeProject(project: Project, board: Board, lastChange: string): void {
    const path = `projects/${project.slug}.md`;
    const open = project.open;
    const description = `${project.name}: ${project.total} tasks, ${open} open.`;
    const pairs: [string, unknown][] = [
      ['title', project.name], ['description', description], ['kind', 'project'],
      ['slug', project.slug], ['id', project.id], ['name', project.name],
      ['repos', project.repos], ['color', project.color], ['created', project.created],
      ['open', project.open], ['total', project.total], ['board_version', board.version],
    ];
    const lines = [`# ${project.name}`, '', `${project.name} is a project of the Kanzo board: ${project.total} tasks, ${open} open.`, ''];
    lines.push('## Repositories', '');
    lines.push(project.repos.length ? project.repos.map(repo => `- ${code(repo)}`).join('\n') : 'The project is linked to no repository.');
    lines.push('', '## Tasks', '');
    lines.push(`Every task of this project is a file under \`tasks/\`, with \`project: "${project.slug}"\` in its frontmatter:`,
      '', '```sql', 'SELECT key, title, status FROM kanzo_tasks WHERE project = \'' + project.slug + '\' ORDER BY id;', '```');
    this.putFile(path, `${facts(pairs)}${lines.join('\n')}\n`, lastChange, `${BASE}/#${project.slug}`, undefined, project.slug);
  }

  // What the copy holds, and when it was last compared with the whole board. The
  // complete timestamp is the beginning of the validated source pass.
  private writeOverview(board: BoardMeta): void {
    const byStatus = board.statuses.map(status => `${status}: ${board.byStatus[status] ?? 0}`);
    const projects = board.projects.map(project => `- ${project.name}, ${code(project.slug)}: ${project.total} tasks, ${project.open} open`);
    const statuses = board.statuses.map(status => `- ${code(status)}${status === 'done' ? ' — administratively closed; this is not a claim that the work succeeded' : ''}`);
    const description = `What this copy of the Kanzo board holds, when it was last compared with the whole board, and what it leaves out.`;
    const pairs: [string, unknown][] = [
      ['title', 'Kanzo board, as copied'], ['description', description], ['kind', 'overview'],
      ['board', 'kanzo://board/'], ['board_version', board.version], ['changes', board.changes],
      ['complete_as_of', board.began], ['tasks', board.taskCount], ['projects', board.projects.length],
      ['comments', board.commentCount], ['tasks_with_comments', board.tasksWithComments],
      ['migrated', board.migrated], ['human_tasks', board.humanTasks],
    ];
    const lines: string[] = [];
    lines.push('# The Kanzo board, as copied', '');
    lines.push(`This is a copy of the whole Kanzo board: every task in every column, open or done, and every project. ` +
      `Tasks: ${board.taskCount}. Projects: ${board.projects.length}. Comments: ${board.commentCount}.`);
    lines.push('');
    lines.push('Every sweep reads the whole board and removes what the board no longer names. The last full sweep ' +
      `began at ${board.began || 'an instant this copy does not hold'}, and every sweep since has read the whole ` +
      'listing: a card\'s facts are at most fifteen minutes old, and its comments are re-read when the card moved ' +
      'or the board\'s change counter moved.');
    lines.push('');
    lines.push('A sweep that cannot read the board whole — a malformed, incomplete or contradictory answer — publishes ' +
      'nothing and removes nothing, and the next sweep tries again.');
    lines.push('', '## Columns', '', statuses.join('\n'));
    lines.push('', 'Tasks by column:', '', byStatus.map(line => `- ${line}`).join('\n'));
    lines.push('', '## Projects', '', projects.join('\n'));
    lines.push('', '## What is left out', '');
    lines.push('- A live claim, a check receipt and their HMAC signature. A card\'s `coordination_blocks_left_out` ' +
      'counts what was dropped, and no file says who holds a card now: that is live state, and only the board has it.');
    lines.push('- The session id and identity inside a closure envelope, and its claim receipt. The closure\'s outcome, ' +
      'summary, validation results and remaining work are kept.');
    lines.push('- Attachments and images.');
    lines.push('- Credentials in a description or a comment, as far as the shapes in `connector.ts` know them. A shape ' +
      'they do not name is written and embedded; README.md says so.');
    lines.push('', '## What "done" means here', '');
    lines.push('A card in `done` was closed administratively. The board records the closure, not a result: it does not ' +
      'say the work succeeded, that tests passed, or that the operator approved it. An imported card carries the ' +
      'outcome its importer recorded (`unknown_legacy` for most of the historical backlog), and that is often ' +
      '"unknown", not "success".');
    // The file's time is the later of the last complete read and the last change of any card, and never this
    // machine's clock, so a sweep that changes nothing does not touch it.
    const stamp = Date.parse(board.began) > Date.parse(board.lastChange) ? board.began : board.lastChange;
    this.putFile('overview.md', `${facts(pairs)}${lines.join('\n')}\n`, stamp, `${BASE}/`);
  }

  // What a reader of these files would get wrong without being told. Each concept arrives with the files it is about;
  // none holds anything of a card.
  private teach(board: BoardMeta): void {
    this.concepts.set({
      name: 'DoneIsAdministrativeClosure', category: 'rule', relevance: 'tasks/**',
      invariant: 'A task whose status is done was closed administratively; the copy does not say the work succeeded, that tests passed, or that anyone approved it.',
      tags: ['done', 'closed', 'status', 'outcome', 'success', 'approval', 'history'],
      why: 'Most of this board was imported and closed by an operator backlog reset, and the importer recorded the outcome as unknown. Reading "done" as "worked" is wrong for almost every file here.',
      depth: ['An imported task states the outcome its importer recorded, in `outcome`; `unknown_legacy` is not a success.',
        'A closure the lifecycle broker recorded states the outcome its checks gave, in the Closure section of the comment.'],
    });
    this.concepts.set({
      name: 'LiveClaimsAreNotCopied', category: 'rule', relevance: ['tasks/**', 'overview.md'],
      invariant: 'A live claim, a check receipt and their HMAC signatures are stripped from every file. The copy never says who holds a task now; the board does.',
      tags: ['claim', 'claimed', 'owner', 'who', 'live', 'lease', 'session', 'authoritative'],
      why: 'A claim is a lease of minutes. A copy up to fifteen minutes old that stated one would be read as current, and an agent would act on a claim that had already expired.',
      depth: ['`coordination_blocks_left_out` on a task counts the envelopes dropped from its file.',
        'Ask the board, not this import: `kanzo mcp` with `check_work`, or the OpenChamber Kanzo tools.'],
    });
    this.concepts.set({
      name: 'TaskFactsAreFrontmatter', category: 'shape', relevance: 'tasks/**',
      invariant: 'Every task states key, status, project, tags, human, comments, created and updated as frontmatter, so a question about many tasks is one query over those facts.',
      tags: ['query', 'frontmatter', 'facts', 'count', 'filter', 'status', 'project', 'tags'],
      example: "SELECT key, title FROM kanzo_tasks WHERE project = 'fleet' AND status = 'doing' ORDER BY id",
      depth: ['`key` is the qualified native id, such as work#3: join on it, and search by it.',
        '`status` is the board column as the board spells it; `open` is false only for the done column.'],
    });
    this.concepts.set({
      name: 'MissingTaskIsGoneOrNewer', category: 'wisdom', relevance: ['tasks/**', 'overview.md'],
      invariant: 'A task that is not in the copy was removed from the board or arrived after the last sweep. `complete_as_of` in overview.md is when the copy was last compared with the whole board.',
      tags: ['missing', 'deleted', 'not found', 'complete', 'stale', 'fresh'],
      why: 'A full sweep removes exactly what a complete, validated listing no longer names, so absence in the copy is the board having no such card at that instant.',
    });
    this.concepts.set({
      name: 'CommentAuthorsAreNames', category: 'shape', relevance: 'tasks/**',
      invariant: 'A comment names its author as the board holds it, a plain name. The copy has no person file: the board keeps no account of its own.',
      tags: ['comment', 'author', 'people', 'who wrote', 'identity'],
    });

    const meanings: Record<string, string> = {
      todo: 'Not started: the task is in the board\'s first column.',
      doing: 'In progress. The card may be claimed by an agent session, and that claim is not in this copy.',
      review: 'Waiting for review.',
      done: 'Administratively closed. The board does not say the work succeeded, that tests passed, or that anyone approved it.',
    };
    const terms: Term[] = board.statuses.map(status => ({
      term: status, domain: 'column', scope: 'tasks/**',
      meaning: meanings[status] ?? `A column of this board, named ${status} in the board's own settings.`,
      aliases: status === 'done' ? ['closed', 'complete', 'finished'] : status === 'doing' ? ['in progress', 'active', 'claimed'] : [],
    }));
    terms.push({
      term: 'claim', domain: 'coordination', scope: 'tasks/**',
      meaning: 'A signed lease a session holds on a task for a short time, so two sessions do not work on one card. It is live coordination state, and this copy holds none of it.',
      aliases: ['claimed by', 'owner', 'lock', 'lease', 'who is working on'],
    });
    terms.push({
      term: 'human task', domain: 'board', scope: 'tasks/**',
      meaning: 'A card marked for the person rather than for agents. The agent lifecycle never closes one.',
      aliases: ['manual', 'for the user', 'human'],
    });
    terms.push({
      term: 'administrative closure', domain: 'lifecycle', scope: ['tasks/**', 'overview.md'],
      meaning: 'A card moved to done because someone ended it, not because its work succeeded. The recorded outcome says what happened, and is often unknown.',
      aliases: ['closed', 'backlog reset', 'done means', 'outcome'],
    });
    for (const term of terms) this.vocabulary.set(term);
    for (const held of this.vocabulary.list())
      if (!terms.some(term => term.term === held.term && term.domain === held.domain))
        this.vocabulary.remove(held.term, held.domain);
  }

  // One GET to the board's loopback address. The connector reads nothing else and sends no credential: the board has
  // no authentication, which is why its manifest grants exactly this host and port and nothing more.
  private send(path: string): { status: number; body: unknown } {
    const reply = this.http.request({ url: `${BASE}${path}` });
    return { status: reply.status, body: reply.body };
  }

  private allRowsForRender(): Row<Stored>[] {
    const selected = this.db.query('SELECT key, value FROM kv WHERE collection = $1 ORDER BY key', [COLLECTION]);
    return selected.map(entry => {
      if (typeof entry.key !== 'string') throw new Error('The Kanzo database has a malformed key; render was not published.');
      let value: unknown = entry.value;
      if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { throw new Error('The Kanzo database has a malformed row; render was not published.'); }
      }
      if (!isObject(value)) throw new Error('The Kanzo database has a malformed row; render was not published.');
      return { key: entry.key, value: value as unknown as Stored };
    });
  }

  private removedPaths(changes: Changes): string[] {
    const paths = new Set<string>();
    let after: string | undefined;
    do {
      const page = this.db.changes(COLLECTION, { since: changes.since, until: changes.until, after, limit: PAGE });
      for (const key of page.removed) {
        const match = /^file\|([^|]+)\|\d{6}$/.exec(key);
        if (match !== null) {
          try { paths.add(decodeURIComponent(match[1])); }
          catch { throw new Error('The removed Kanzo path is malformed; render was not published.'); }
        }
      }
      after = page.next;
    } while (after !== undefined);
    return Array.from(paths).sort();
  }

  render(changes: Changes): void {
    const groups = new Map<string, FileRow[]>();
    let board: BoardMeta | undefined;
    for (const row of this.allRowsForRender()) {
      const value = row.value as Stored;
      if (value.kind === 'file') {
        const group = groups.get(value.path) ?? [];
        group.push(value);
        groups.set(value.path, group);
      } else if (value.kind === 'board-meta') board = value;
    }
    for (const path of this.removedPaths(changes)) this.files.remove(path);
    const files: OutputFile[] = [];
    for (const [path, parts] of groups) {
      parts.sort((a, b) => a.part - b.part);
      for (let i = 0; i < parts.length; i += 1)
        if (parts[i].part !== i || parts[i].parts !== parts.length) throw new Error(`The stored Kanzo file ${path} is missing a chunk; render was not published.`);
      const first = parts[0];
      files.push({ path, text: parts.map(part => part.content).join(''), time: first.time, origin: first.origin });
    }
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    for (const file of files) this.files.write(file.path, file.text, { origin: file.origin, time: file.time });
    if (board) this.teach(board);
  }
}

// The last change of any card in a project, which is the newest instant its project file is written from. A project
// with no cards keeps the instant it was created.
function newestUpdate(board: Board): (slug: string) => string {
  const newest = new Map<string, string>();
  for (const card of board.cards) {
    const held = newest.get(card.project);
    if (!held || Date.parse(card.updated) > Date.parse(held)) newest.set(card.project, card.updated);
  }
  return (slug: string) => newest.get(slug) ?? board.projects.find(project => project.slug === slug)?.created ?? '1970-01-01T00:00:00Z';
}
