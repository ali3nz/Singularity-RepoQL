/// <reference path="./repoql-connector.d.ts" />
// The Tencent MemoryCore connector: it copies a Tencent MemoryCore store into a workspace, as one Markdown file
// for each L1 memory record, each L2 scene block and each L3 persona profile, and an overview. It follows
// help:///skills/writing-connectors/SKILL.md, and QUESTIONS.md beside it records what the first step left.
// manifest.yaml states what it asks for, README.md tells the person who installs it what it keeps, help/layout.md
// tells a reader how to ask, sql/ holds the views a reader queries, and lifecycle.json is its suite, whose fixture
// folders are under fixtures/:
//
//   rql connector test connector.ts --fixtures lifecycle.json
//
// The source. A store keeps its files under a data folder, which the person who installs the connector chooses as
// the source root `data` (memorycore://data is the import). The connector reads three things there and nothing else:
//
//   records/<YYYY-MM-DD>.jsonl   one L1 record a line, as the store wrote it:
//                                { "id": "m_1736233200000_aa01bb02", "content": "...", "type": "episodic",
//                                  "priority": 80, "scene_name": "...", "source_message_ids": ["msg-..."],
//                                  "metadata": { "activity_start_time": "...", "activity_end_time": "..." },
//                                  "timestamps": ["2026-01-07T08:02:00.000Z"], "createdAt": "...", "updatedAt": "...",
//                                  "version": 0, "sessionKey": "ses_...", "sessionId": "ses_...", "taskId": "...",
//                                  "teamId": "...", "userId": "...", "agentId": "..." }
//   profiles/<team%3A...%7Cagent%3A...>/persona.md          one L3 persona, narrative Markdown. A second
//   profiles/<team>|agent>.../persona.<plane>.md            extraction plane adds persona.<plane>.md beside it
//   profiles/<team>|agent>.../scene_blocks/<Scene>.md       one L2 scene block: a META header, then Markdown
//
// The store's service is the folder's only writer. Its conversations/, vectors.db, metadata/, instances/, .backup/
// and every .metadata/ folder are left out by design; the README names them.
//
// What the copy must hold, and what it must not:
// - Every record's own facts as frontmatter, so they can be counted and joined; the record's instant is its
//   createdAt, its file's modification time, and its day the folder it sits in.
// - No secret a record's text happens to carry: the shapes of token listed in redact below are replaced in every
//   file this connector writes. A shape that list does not name is written as it stands: that list is the only guard.
// - No source_message_ids, no metadata beyond the two activity instants, no sessionKey (it repeats sessionId), and
//   no store internals. What the import holds about a person is stated in README.md and held to in the suite.
//
// Two things a sweep must promise. It must leave the same files however its calls were cut, so:
// - no call reads the clock: every instant a file carries is the source's own;
// - every loop runs over a listing in the host's byte order of names, and every list written to .state is sorted.
// And a full sweep must leave the workspace as the source is, so it removes what the source no longer has, at the
// call that ends it, after re-listing the source.
import { Connector, InvalidImport, type ImportTarget, type ImportUri, type Missing, type SyncRequest, type SyncResult } from 'repoql:connector';

// The name of the source root, which the import URI states as its authority.
const ROOT = 'data';

// A records file of the source, such as 2026-01-07.jsonl.
const SHARD = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
// A record id, as it appears in the source and as the file it becomes is named.
const RECORD_ID = /^[A-Za-z0-9_-]{1,158}$/;
// An instant as the store writes it: UTC, milliseconds, as 2026-01-07T08:02:00.000Z.
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// A profile folder name, which states the team and the agent the store keys its profile by.
const PROFILE = /^team:([A-Za-z0-9._-]{1,64})\|agent:([A-Za-z0-9._-]{1,64})$/;
// A persona file of a profile folder, with the extraction plane it was written for when it is not the first.
const PERSONA = /^persona(?:\.([A-Za-z0-9_-]{1,64}))?\.md$/;
// Names a workspace refuses on some platforms: the Windows device names, with or without an extension.
const DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

// Text a workspace file can hold: a string with no U+0000. The store's files are UTF-8, and a zero byte cannot be
// written back as one; a record whose text holds one is left out and named as a gap, in the sweep's answer.
const isText = (value: unknown): value is string => typeof value === 'string' && !value.includes('\0');

// An instant the store wrote: UTC, milliseconds, as 2026-01-07T08:02:00.000Z. Anything else - a fraction of another
// width, an offset, a year before 1970, or a date the calendar does not have, such as the 30th of February - is not
// one, and a record whose createdAt is not one fails the call: the file's day and modification time come from it.
function isInstant(value: unknown): value is string {
  return typeof value === 'string' && INSTANT.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

// A name the host accepts on every platform. A source name that fails this is not written; the file it names is
// reported as a gap instead, because one odd name must not fail a whole store's sweep.
function safeName(name: string): boolean {
  if (name === '' || name.length > 200) return false;
  if (/[\\/:*?"<>|]/.test(name)) return false;
  if (/[\u0000-\u001f\u007f]/.test(name)) return false;
  if (name.endsWith('.') || name.endsWith(' ')) return false;
  if (DEVICE.test(name)) return false;
  return true;
}

// A YAML double-quoted string. JSON's escapes are YAML's, so JSON.stringify is exact for every fact written here.
const q = (value: string): string => JSON.stringify(value);

// A one-line title from a text: its whitespace flattened, cut at 120 code points. The title is the file's headline,
// so a reader sees what the record says and not only which id it is.
function lead(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const points = Array.from(flat);
  return points.length <= 120 ? flat : `${points.slice(0, 119).join('')}\u2026`;
}

// The shapes of token replaced in every file this connector writes. A record's text can carry a credential inside a
// command, a log or a pasted configuration; the host checks only for the secrets the connector was handed, and this
// connector is handed none, so this list is the only guard. README.md states it to the person who installs it.
const SECRETS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*?-----END [A-Z ]{0,40}PRIVATE KEY-----/g, '[redacted private key]'],
  [/\bghp_[A-Za-z0-9]{20,79}\b/g, '[redacted]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[redacted]'],
  [/\bsk-[A-Za-z0-9-]{20,}\b/g, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]'],
  [/\b(Bearer)\s+[A-Za-z0-9_~+/=-]{8,}/g, '$1 [redacted]'],
  [/\b(api[_-]?key|apikey|token|secret|password|passwd|pwd)\s*([=:])\s*(['"]?)[A-Za-z0-9_~+/=-]{8,}\3/gi, '$1$2[redacted]'],
  [/(-{1,2}(?:password|token|secret|api[_-]?key)\s+)[A-Za-z0-9_~+/=-]{8,}/gi, '$1[redacted]'],
];

function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRETS) out = out.replace(pattern, replacement);
  return out;
}

// The profile folder name decoded into the team and the agent, or null when it names no pair: the folder is then
// left out and counts as a gap, named by its own name. Real folders look like team%3Ateam-fixture%7Cagent%3Aagt-fixture.
function decodeProfile(folder: string): [string, string] | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(folder);
  } catch {
    return null;
  }
  const match = PROFILE.exec(decoded);
  return match === null ? null : [match[1], match[2]];
}

// The extraction plane of a persona file: null when the name is not one, '' for persona.md, and the plane's name
// for persona.<plane>.md.
function personaPlane(name: string): string | null {
  const match = PERSONA.exec(name);
  return match === null ? null : match[1] ?? '';
}

interface Stat {
  size: number;
  modified: string;
}

interface RecordState {
  /** The record's updatedAt, which is what a changed record changes. */
  updated: string;
  /** The day its file sits under, from its createdAt. */
  day: string;
  /** Its type, as written in its frontmatter. */
  type: string;
  /** The source file it was read from, such as records/2026-01-07.jsonl. */
  src: string;
}

interface Gap {
  /** The source path the missing item belongs to, which is how a gap goes when the source changes. */
  ref: string;
  what: string;
  why: string;
}

interface State {
  /** Each shard read, with the fingerprint that says it was. */
  shards: Record<string, Stat>;
  /** Each persona and scene file read, keyed by its path under profiles/. */
  sources: Record<string, Stat>;
  /** Each record written, keyed by its id. */
  records: Record<string, RecordState>;
  /** Shard names whose newest bytes were not read yet, sorted. */
  pending: string[];
  /** What the copy lacks, named. */
  gaps: Gap[];
  /** The agents the profiles state, sorted. */
  agents: string[];
  /** Profile folders whose name states no team and agent, sorted. */
  looseFolders: string[];
}

const emptyState = (): State => ({ shards: {}, sources: {}, records: {}, pending: [], gaps: [], agents: [], looseFolders: [] });

/** Sorted keys, so that the bytes of .state/state.json never depend on the order things were visited. */
function sorted<T>(source: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(source).sort()) out[key] = source[key];
  return out;
}

interface ShardItem {
  kind: 'shard';
  name: string;
}

interface ProfileItem {
  kind: 'profile';
  folder: string;
}

type Item = ShardItem | ProfileItem;

export default class MemoryCore extends Connector {
  // An import is memorycore://data. The authority names the manifest's source root, so the host knows which folder
  // to hand `sync`; anything after the authority is refused, because the connector reads one whole folder.
  static parse(uri: ImportUri): ImportTarget {
    if (uri.authority !== ROOT || uri.path.length > 0)
      throw new InvalidImport('A memorycore import is memorycore://data: the connector reads the store\'s whole data folder, which is the source root it asks for.');
    return { root: `memorycore://${ROOT}/`, title: 'Tencent MemoryCore' };
  }

  sync(request: SyncRequest): SyncResult {
    // The concepts and terms are set on every call, so an import teaches them as soon as it exists and an updated
    // connector's wording replaces the old at the next sweep.
    this.teach();

    const state = this.loadState();
    const items = this.items();

    // The cursor is a position into this listing. The listing is the same for every call of a sweep with the same
    // source, so a sweep interrupted by `this.signal.aborted` resumes where it stopped.
    let at = 0;
    if (request.cursor !== undefined) {
      const position = Number(request.cursor);
      if (!Number.isInteger(position) || position < 0) throw new Error(`The cursor is not a position of this connector: ${request.cursor}`);
      at = position;
    }

    while (at < items.length) {
      const item = items[at];
      if (item.kind === 'shard') this.bringShard(item.name, state);
      else this.bringProfile(item.folder, state);
      at += 1;
      // Read after an item, never before the first, so every call does some work.
      if (at < items.length && this.signal.aborted) {
        this.save(state);
        return { nextCursor: String(at) };
      }
    }

    // The call that ends a sweep brings the copy back to what the source is - removals on a full sweep - restores
    // any file a reader or another tool deleted, writes the overview, and names what the copy lacks.
    const missing = this.finish(state, request.full);
    this.save(state);
    return { missing };
  }

  // The source items of one full pass, in the host's byte order of names: the daily shards, then the profile
  // folders. A folder the store grows with a new shard or a new agent is picked up at the next sweep.
  private items(): Item[] {
    const items: Item[] = [];
    if (this.source.exists('records')) {
      for (const entry of this.source.list('records')) {
        if (!entry.directory && SHARD.test(entry.name)) items.push({ kind: 'shard', name: entry.name });
      }
    }
    if (this.source.exists('profiles')) {
      for (const entry of this.source.list('profiles')) {
        if (entry.directory) items.push({ kind: 'profile', folder: entry.name });
      }
    }
    return items;
  }

  // One shard of L1 records. The fingerprint of (size, modified) is what says whether its lines were read already;
  // a shard still being appended to is read again at the next sweep because its fingerprint is left as it was.
  private bringShard(name: string, state: State): void {
    const ref = `records/${name}`;
    const stat = this.source.stat(ref);
    const seen = state.shards[name];
    if (seen !== undefined && seen.size === stat.size && seen.modified === stat.modified) return;

    const text = this.source.readText(ref);
    let torn = false;
    // The gaps this read finds. They replace the shard's old gaps only when the shard reads whole, so a torn read
    // never loses what an earlier one found.
    const found: Gap[] = [];
    // The records this shard held at the last read, and the ids it holds now: a record no longer in it is gone from
    // the source, and its file and bookkeeping go with it.
    const before = Object.keys(state.records).filter((id) => state.records[id].src === ref);
    const here = new Set<string>();
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      let line = lines[index];
      if (index === 0 && line.startsWith('\uFEFF')) line = line.slice(1);
      if (line.trim() === '') continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        // A line that does not parse is a line still being written, or a damaged one. The shard is read again at the
        // next sweep, and until it reads whole the copy lacks its newest lines.
        torn = true;
        continue;
      }
      const id = (record as { id?: unknown }).id;
      if (typeof id === 'string') here.add(id);
      this.bringRecord(record, name, state, found);
    }

    if (!torn) {
      for (const id of before) {
        if (here.has(id)) continue;
        const entry = state.records[id];
        const path = `records/${entry.day}/${id}.md`;
        if (this.workspace.exists(path)) this.workspace.remove(path);
        delete state.records[id];
      }
    }

    if (torn) {
      for (const gap of found) if (!state.gaps.some((held) => held.ref === gap.ref && held.what === gap.what)) state.gaps.push(gap);
      state.gaps.sort((a, b) => (a.what < b.what ? -1 : a.what > b.what ? 1 : 0));
      if (!state.pending.includes(name)) state.pending.push(name);
      state.pending.sort();
      return;
    }
    state.gaps = state.gaps.filter((gap) => gap.ref !== ref).concat(found);
    state.gaps.sort((a, b) => (a.what < b.what ? -1 : a.what > b.what ? 1 : 0));
    state.pending = state.pending.filter((pending) => pending !== name);
    state.shards[name] = { size: stat.size, modified: stat.modified };
  }

  // One record. Its file is named by the store's own id under the day it was created, and every fact its frontmatter
  // states comes from the record itself.
  private bringRecord(record: unknown, shard: string, state: State, found?: Gap[]): void {
    const ref = `records/${shard}`;
    if (record === null || typeof record !== 'object' || Array.isArray(record))
      throw new Error(`The shard ${ref} holds a line that is not a record object.`);
    const r = record as Record<string, unknown>;

    const id = r.id;
    if (typeof id !== 'string' || !RECORD_ID.test(id))
      throw new Error(`The shard ${ref} holds a record whose id cannot be a file name: ${JSON.stringify(r.id)}`);
    const created = r.createdAt;
    if (!isInstant(created))
      throw new Error(`The record ${id} states a createdAt that is not UTC with milliseconds, written as 2026-01-07T08:02:00.000Z.`);

    // A record whose text holds U+0000 cannot become a file. It is left out, and the sweep names it as a gap.
    if (!isText(r.content)) {
      const gap: Gap = { ref, what: `The record ${id}, whose text holds a zero byte`, why: 'A workspace file is text, and a zero byte cannot be written as one.' };
      const into = found ?? state.gaps;
      if (!into.some((held) => held.ref === gap.ref && held.what === gap.what)) into.push(gap);
      return;
    }

    const updated = isInstant(r.updatedAt) ? r.updatedAt : created;
    const day = created.slice(0, 10);
    const path = `records/${day}/${id}.md`;
    const seen = state.records[id];
    if (seen !== undefined && seen.updated === updated && this.workspace.exists(path)) {
      // The file is right; only the bookkeeping of which shard holds it is freshened, which a re-sharded file needs.
      state.records[id] = { updated, day, type: seen.type, src: ref };
      return;
    }

    this.workspace.writeText(path, this.recordFile(r, id, created, updated, day, ref));
    // The file's own instant is when the memory happened; a later edit to a record does not move it in time.
    this.workspace.setModified(path, created);
    const type = typeof r.type === 'string' && r.type !== '' ? r.type : 'unknown';
    state.records[id] = { updated, day, type, src: ref };
  }

  private recordFile(r: Record<string, unknown>, id: string, created: string, updated: string, day: string, ref: string): string {
    const text = redact(r.content as string);
    const facts: string[] = [];
    facts.push(`title: ${q(lead(text) || `Memory record ${id}`)}`);
    facts.push(`kind: ${q('memory-record')}`);
    facts.push(`id: ${q(id)}`);
    if (typeof r.type === 'string' && r.type !== '') facts.push(`type: ${q(r.type)}`);
    if (typeof r.priority === 'number' && Number.isFinite(r.priority)) facts.push(`priority: ${String(r.priority)}`);
    facts.push(`created: ${q(created)}`);
    facts.push(`updated: ${q(updated)}`);
    if (typeof r.version === 'number' && Number.isFinite(r.version)) facts.push(`version: ${String(r.version)}`);
    facts.push(`day: ${q(day)}`);
    if (typeof r.scene_name === 'string' && r.scene_name !== '') facts.push(`scene_name: ${q(redact(r.scene_name))}`);
    const named: [string, string][] = [['session', 'sessionId'], ['task', 'taskId'], ['team', 'teamId'], ['agent', 'agentId'], ['user', 'userId']];
    for (const [fact, member] of named) {
      const value = r[member];
      if (typeof value === 'string' && value !== '') facts.push(`${fact}: ${q(value)}`);
    }
    const metadata = r.metadata;
    if (metadata !== null && typeof metadata === 'object') {
      const m = metadata as Record<string, unknown>;
      if (isText(m.activity_start_time) && m.activity_start_time !== '') facts.push(`activity_start: ${q(m.activity_start_time)}`);
      if (isText(m.activity_end_time) && m.activity_end_time !== '') facts.push(`activity_end: ${q(m.activity_end_time)}`);
    }
    facts.push(`source_file: ${q(ref)}`);
    return `---\n${facts.join('\n')}\n---\n\n${text}${text.endsWith('\n') ? '' : '\n'}`;
  }

  // One profile folder: its persona files, and its scene_blocks folder. Every other folder in it, .metadata among
  // them, and every other file, is store internals the copy leaves out.
  private bringProfile(folder: string, state: State): void {
    const decoded = decodeProfile(folder);
    if (decoded === null) {
      if (!state.looseFolders.includes(folder)) state.looseFolders.push(folder);
      state.looseFolders.sort();
      const gap: Gap = {
        ref: `profiles/${folder}`,
        what: `The profile folder profiles/${folder}`,
        why: 'Its name states no team and an agent, so its files cannot be placed under personas/ and scenes/.',
      };
      if (!state.gaps.some((held) => held.ref === gap.ref)) state.gaps.push(gap);
      state.gaps.sort((a, b) => (a.what < b.what ? -1 : a.what > b.what ? 1 : 0));
      return;
    }
    const [team, agent] = decoded;
    if (!state.agents.includes(agent)) state.agents.push(agent);
    state.agents.sort();

    const base = `profiles/${folder}`;
    for (const entry of this.source.list(base)) {
      if (entry.directory) {
        if (entry.name === 'scene_blocks') this.bringScenes(base, folder, entry.name, team, agent, state);
        continue;
      }
      const plane = personaPlane(entry.name);
      if (plane !== null) this.bringPersona(base, folder, entry.name, plane, team, agent, state);
    }
  }

  private bringPersona(base: string, folder: string, name: string, plane: string, team: string, agent: string, state: State): void {
    const key = `${folder}/${name}`;
    this.bringFile(`${base}/${name}`, key, state, (text, stat) => {
      const body = redact(text);
      const title = plane === '' ? `Persona - agent ${agent}` : `Persona (${plane}) - agent ${agent}`;
      const facts = [
        `title: ${q(title)}`,
        `kind: ${q('memory-persona')}`,
        `team: ${q(team)}`,
        `agent: ${q(agent)}`,
        ...(plane === '' ? [] : [`plane: ${q(plane)}`]),
        // No `updated` fact: the file's own modification time is the source's stat, and writing it in the text
        // would change the bytes when only the source's touch time moved. The host serves the modified time already.
        `source_file: ${q(`profiles/${key}`)}`,
      ];
      return { text: `---\n${facts.join('\n')}\n---\n\n${body}${body.endsWith('\n') ? '' : '\n'}`, modified: stat.modified };
    });
  }

  private bringScenes(base: string, folder: string, dir: string, team: string, agent: string, state: State): void {
    for (const entry of this.source.list(`${base}/${dir}`)) {
      if (entry.directory) continue;
      const name = entry.name;
      const key = `${folder}/${dir}/${name}`;
      if (!name.endsWith('.md') || !safeName(name)) continue;
      this.bringFile(`${base}/${dir}/${name}`, key, state, (text, stat) => {
        const fields = this.meta(text);
        const body = redact(fields.body);
        const summary = fields.fields.summary !== undefined ? redact(fields.fields.summary) : '';
        const title = summary !== '' ? summary : lead(body) || name.slice(0, -3);
        const facts = [
          `title: ${q(title)}`,
          `kind: ${q('memory-scene')}`,
          `scene: ${q(name.slice(0, -3))}`,
          `team: ${q(team)}`,
          `agent: ${q(agent)}`,
        ];
        if (isInstant(fields.fields.created)) facts.push(`created: ${q(fields.fields.created)}`);
        if (isInstant(fields.fields.updated)) facts.push(`updated: ${q(fields.fields.updated)}`);
        if (/^\d{1,6}$/.test(fields.fields.heat ?? '')) facts.push(`heat: ${fields.fields.heat}`);
        facts.push(`source_file: ${q(`profiles/${key}`)}`);
        const modified = isInstant(fields.fields.updated) ? fields.fields.updated : stat.modified;
        return { text: `---\n${facts.join('\n')}\n---\n\n${body}${body.endsWith('\n') ? '' : '\n'}`, modified };
      });
    }
  }

  // The META header of a scene block, lifted out of the body and into frontmatter, so the summary, the two instants
  // and the heat can be queried. A file without one is kept whole, and its facts come from its stat alone.
  private meta(text: string): { fields: Record<string, string>; body: string } {
    const start = '-----META-START-----';
    const end = '-----META-END-----';
    const at = text.indexOf(start);
    const to = text.indexOf(end);
    if (at === -1 || to === -1 || to < at) return { fields: {}, body: text };
    const fields: Record<string, string> = {};
    for (const line of text.slice(at + start.length, to).split('\n')) {
      const match = /^([A-Za-z_]+):\s*(.*)$/.exec(line.trim());
      if (match !== null) fields[match[1]] = match[2].trim();
    }
    return { fields, body: text.slice(to + end.length).replace(/^\n+/, '') };
  }

  // One persona or scene file: read when the source changed it or the copy lost it, written with the facts its kind
  // asks for, its modification time the source's own instant. A file whose text holds U+0000 is left out, named as
  // a gap; a name no workspace can hold is left out the same way, before anything is read.
  private bringFile(path: string, key: string, state: State, build: (text: string, stat: Stat) => { text: string; modified: string }): void {
    const stat = this.source.stat(path);
    const seen = state.sources[key];
    const workspacePath = this.workspacePath(key);
    if (seen !== undefined && seen.size === stat.size && seen.modified === stat.modified && this.workspace.exists(workspacePath)) return;

    const text = this.source.readText(path);
    state.gaps = state.gaps.filter((gap) => gap.ref !== path);
    if (!isText(text)) {
      state.gaps.push({ ref: path, what: `The file ${path}`, why: 'Its text holds a zero byte, and a workspace file is text.' });
      state.gaps.sort((a, b) => (a.what < b.what ? -1 : a.what > b.what ? 1 : 0));
      return;
    }
    const built = build(text, stat);
    this.workspace.writeText(workspacePath, built.text);
    this.workspace.setModified(workspacePath, built.modified);
    state.sources[key] = { size: stat.size, modified: stat.modified };
  }

  // Where a persona or scene file of the source sits in the workspace.
  private workspacePath(key: string): string {
    const parts = key.split('/');
    const decoded = decodeProfile(parts[0]);
    if (decoded === null) throw new Error(`The profile folder ${parts[0]} states no team and agent.`);
    const [team, agent] = decoded;
    if (parts.length === 2) return `personas/${team}/${agent}/${parts[1]}`;
    return `scenes/${team}/${agent}/${parts[2]}`;
  }

  // The call that ends a sweep: a full sweep removes what the source no longer has, every sweep restores a content
  // file a reader deleted, writes the overview, and names what the copy lacks.
  private finish(state: State, full: boolean): Missing[] {
    if (full) this.removeStale(state);
    this.restore(state);
    this.overview(state);
    return this.missing(state);
  }

  // Removal, on a full sweep only: the source is listed afresh, the workspace is walked, and what the source no
  // longer has goes, with the folders that held only it. The bookkeeping of .state goes with it.
  private removeStale(state: State): void {
    const expectedRecords = new Set<string>();
    for (const id of Object.keys(state.records)) {
      const entry = state.records[id];
      if (!this.source.exists(entry.src)) {
        delete state.records[id];
        continue;
      }
      expectedRecords.add(`records/${entry.day}/${id}.md`);
    }
    for (const path of this.walk('records')) if (!expectedRecords.has(path)) this.workspace.remove(path);
    this.pruneEmpty('records');

    const expectedProfiles = new Set<string>();
    const loose: string[] = [];
    const liveKeys = new Set<string>();
    if (this.source.exists('profiles')) {
      for (const folder of this.source.list('profiles')) {
        if (!folder.directory) continue;
        const decoded = decodeProfile(folder.name);
        if (decoded === null) {
          loose.push(folder.name);
          continue;
        }
        const [team, agent] = decoded;
        const base = `profiles/${folder.name}`;
        for (const entry of this.source.list(base)) {
          if (entry.directory) {
            if (entry.name !== 'scene_blocks') continue;
            for (const scene of this.source.list(`${base}/${entry.name}`)) {
              if (scene.directory || !scene.name.endsWith('.md') || !safeName(scene.name)) continue;
              expectedProfiles.add(`scenes/${team}/${agent}/${scene.name}`);
              liveKeys.add(`${folder.name}/${entry.name}/${scene.name}`);
            }
            continue;
          }
          if (personaPlane(entry.name) === null) continue;
          expectedProfiles.add(`personas/${team}/${agent}/${entry.name}`);
          liveKeys.add(`${folder.name}/${entry.name}`);
        }
      }
    }
    for (const path of this.walk('personas')) if (!expectedProfiles.has(path)) this.workspace.remove(path);
    for (const path of this.walk('scenes')) if (!expectedProfiles.has(path)) this.workspace.remove(path);
    this.pruneEmpty('personas');
    this.pruneEmpty('scenes');
    for (const key of Object.keys(state.sources)) if (!liveKeys.has(key)) delete state.sources[key];

    state.looseFolders = loose.sort();
    // A gap that names what the source no longer has is dropped with it.
    state.gaps = state.gaps.filter((gap) => this.source.exists(gap.ref));
  }

  // A content file a reader deleted is written again from the source, without re-reading a shard for every record:
  // the files are looked for, and the shards that hold missing ones are read once each.
  private restore(state: State): void {
    // Which shards the source still has, asked once each rather than once per record.
    const live = new Map<string, boolean>();
    for (const id of Object.keys(state.records)) {
      const src = state.records[id].src;
      if (!live.has(src)) live.set(src, this.source.exists(src));
    }
    const missingByShard = new Map<string, string[]>();
    for (const id of Object.keys(state.records)) {
      const entry = state.records[id];
      if (live.get(entry.src) !== true) continue;
      if (this.workspace.exists(`records/${entry.day}/${id}.md`)) continue;
      const ids = missingByShard.get(entry.src) ?? [];
      ids.push(id);
      missingByShard.set(entry.src, ids);
    }
    if (missingByShard.size === 0) return;
    for (const src of Array.from(missingByShard.keys()).sort()) {
      const wanted = new Set(missingByShard.get(src));
      const text = this.source.readText(src);
      for (const line of text.split('\n')) {
        if (line.trim() === '') continue;
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        const id = (record as { id?: unknown }).id;
        if (typeof id === 'string' && wanted.has(id)) this.bringRecord(record, src.slice('records/'.length), state);
      }
    }
  }

  // Every file under a workspace folder, so a full sweep can compare it with the source.
  private walk(prefix: string): string[] {
    const out: string[] = [];
    if (!this.workspace.exists(prefix)) return out;
    for (const entry of this.workspace.list(prefix)) {
      const path = `${prefix}/${entry.name}`;
      if (entry.directory) out.push(...this.walk(path));
      else out.push(path);
    }
    return out;
  }

  // A folder that held only removed files: emptied from the bottom up. A folder that still holds a file is kept.
  private pruneEmpty(prefix: string): void {
    if (!this.workspace.exists(prefix)) return;
    for (const entry of this.workspace.list(prefix)) {
      if (!entry.directory) continue;
      const path = `${prefix}/${entry.name}`;
      this.pruneEmpty(path);
      if (this.workspace.exists(path) && this.workspace.list(path).length === 0) this.workspace.remove(path);
    }
  }

  // What the copy lacks, as the answer that ends a sweep names it: the shards whose newest lines were not read yet,
  // and the items the source states that no workspace file can hold. At most 16 gaps, the rest counted together.
  private missing(state: State): Missing[] {
    const gaps: Missing[] = [];
    for (const name of state.pending) {
      gaps.push({ what: `The newest lines of records/${name}`, why: 'The file was still being written when the sweep read it; the next sweep reads it again.' });
    }
    for (const gap of state.gaps) gaps.push({ what: gap.what, why: gap.why });
    if (gaps.length <= 16) return gaps;
    const more = gaps.length - 15;
    return [...gaps.slice(0, 15), { what: `${more} more items the copy lacks`, why: 'Each is named in .state/state.json under gaps.' }];
  }

  // The overview, written by the call that ends a sweep and only by one. Its instant is the newest source instant
  // the copy was compared at, so an unchanged source leaves it unchanged, and it is rewritten for no reader when
  // nothing moved.
  private overview(state: State): void {
    const types = new Map<string, number>();
    const days: string[] = [];
    let newest = '';
    const watch = (stat: Stat): void => {
      if (stat.modified > newest) newest = stat.modified;
    };
    for (const name of Object.keys(state.shards)) watch(state.shards[name]);
    for (const key of Object.keys(state.sources)) watch(state.sources[key]);
    for (const id of Object.keys(state.records)) {
      const entry = state.records[id];
      types.set(entry.type, (types.get(entry.type) ?? 0) + 1);
      if (!days.includes(entry.day)) days.push(entry.day);
    }
    days.sort();
    const kindCounts = Array.from(types.keys())
      .sort()
      .map((kind) => `${kind} ${types.get(kind)}`)
      .join(', ');
    let scenes = 0;
    let personas = 0;
    for (const key of Object.keys(state.sources)) {
      if (key.includes('/scene_blocks/')) scenes += 1;
      else personas += 1;
    }
    const lines: string[] = [];
    lines.push('# Tencent MemoryCore as imported');
    lines.push('');
    lines.push('This import is a copy of a Tencent MemoryCore store, read from the store\'s data folder. Every file under `records/`, `scenes/` and `personas/` is one item of the store\'s memory as the store wrote it, with the store\'s own ids, instants and provenance in its frontmatter, and nothing restated or merged. A memory here is evidence of what was remembered when, not a claim about what is true now.');
    lines.push('');
    lines.push('## What the copy holds');
    lines.push('');
    lines.push(`- memory records: ${Object.keys(state.records).length}${days.length > 0 ? `, from ${days[0]} to ${days[days.length - 1]}` : ''}${kindCounts !== '' ? ` (${kindCounts})` : ''}`);
    const agentWord = state.agents.length === 1 ? 'agent' : 'agents';
    lines.push(`- scene blocks: ${scenes} across ${state.agents.length} ${agentWord}`);
    lines.push(`- persona files: ${personas} across ${state.agents.length} ${agentWord}`);
    lines.push('');
    lines.push('## What it leaves out');
    lines.push('');
    lines.push('- The store\'s raw conversation logs (`conversations/`), its `vectors.db`, its `metadata/`, `instances/` and `.backup/` folders, and every `.metadata/` folder: none of them is memory, and none is read.');
    lines.push('- Of each record: its `source_message_ids`, its `sessionKey` and every `metadata` member except the two activity instants. Every other fact the store states is kept.');
    lines.push('- Credential-shaped text: the token shapes listed in README.md are replaced with `[redacted]` in every file. A shape that list does not name is written as it stands.');
    if (state.looseFolders.length > 0)
      lines.push(`- ${state.looseFolders.length} profile folder${state.looseFolders.length === 1 ? '' : 's'} whose name states no team and an agent: ${state.looseFolders.join(', ')}`);
    if (state.gaps.length > 0 || state.pending.length > 0) {
      lines.push('');
      lines.push('## Gaps');
      lines.push('');
      lines.push(`- ${state.gaps.length + state.pending.length} item${state.gaps.length + state.pending.length === 1 ? '' : 's'} of the source ${state.gaps.length + state.pending.length === 1 ? 'is' : 'are'} not in the copy; the sweep that ends names each as its \`missing\`, and this file lists them when the copy becomes complete.`);
    } else {
      lines.push('');
      lines.push('The copy has no known gaps.');
    }
    lines.push('');
    lines.push(`Last compared with everything the source lists: ${newest === '' ? 'never' : newest}`);
    lines.push('');
    this.workspace.writeText('overview.md', lines.join('\n'));
  }

  // The concepts and terms this import teaches, set on every call. They say how the tiers relate, that a record is
  // evidence with its own instant, and that provenance is what a quotation is built from.
  private teach(): void {
    this.concepts.set({
      name: 'MemoryTiers',
      category: 'shape',
      invariant: 'The store builds memory in three tiers and the import mirrors them: records/ is L1 episodes, scenes/ is L2 scene blocks, personas/ is L3 profiles, one file per item, named by the store\'s own id.',
      tags: ['memory', 'tiers', 'records', 'scenes', 'personas'],
      relevance: ['records/**', 'scenes/**', 'personas/**'],
      why: 'The store extracts L1 records from conversations, merges them into L2 scenes, and summarises those into L3 personas; the folder layout is the store\'s own.',
    });
    this.concepts.set({
      name: 'MemoryEvidence',
      category: 'rule',
      invariant: 'A file here is what the store held at its instant, not what is true now: a later record may supersede an earlier one, and no file in the import states a current fact.',
      tags: ['memory', 'time', 'stale', 'evidence'],
      relevance: '**',
      why: 'The store is append-only: a changed fact is a new record beside the old one, so only the instants say which came first.',
      example: 'grep the two records for a changed endpoint and prefer the one whose `created` is later, then verify against the live system before acting.',
    });
    this.concepts.set({
      name: 'RecordProvenance',
      category: 'shape',
      invariant: 'Every record states the session, task, team, agent and user it came from, and its file sits under the day it was created; quote a record by its id, and its provenance is the way back to the session that produced it.',
      tags: ['memory', 'provenance', 'session', 'citation'],
      relevance: 'records/**',
      example: 'read("memorycore://data/records/2026-01-07/m_1736233200000_aa01bb02.md") and cite session ses_fixture01.',
    });
    this.concepts.set({
      name: 'MemoryFreshness',
      category: 'wisdom',
      invariant: 'Weigh a record by its `created` instant before relying on it, and check the live system or the code before acting on a memory of state.',
      tags: ['memory', 'verification', 'freshness'],
      relevance: '**',
      why: 'The failure memory systems measure is acting on an outdated fact even when the newer one is beside it; every file here carries the instant that tells the two apart.',
    });
    this.vocabulary.set({
      term: 'L1 record',
      meaning: 'One memory the store extracted from a session, typed episodic, instruction or persona, kept under records/ by its creation day.',
      aliases: ['memory record', 'episode', 'episodic memory'],
      scope: 'records/**',
    });
    this.vocabulary.set({
      term: 'scene block',
      meaning: 'A store-written narrative that merges related episodes for one agent, kept under scenes/.',
      aliases: ['scene', 'L2 scene'],
      scope: 'scenes/**',
    });
    this.vocabulary.set({
      term: 'persona',
      meaning: 'The store\'s narrative profile of the user for one agent and one extraction plane, kept under personas/.',
      aliases: ['L3 profile', 'user profile'],
      scope: 'personas/**',
    });
  }

  private loadState(): State {
    if (!this.workspace.exists('.state/state.json')) return emptyState();
    try {
      const raw = JSON.parse(this.workspace.readText('.state/state.json')) as Partial<State>;
      const state = emptyState();
      if (raw !== null && typeof raw === 'object') {
        if (raw.shards !== undefined) state.shards = raw.shards;
        if (raw.sources !== undefined) state.sources = raw.sources;
        if (raw.records !== undefined) state.records = raw.records;
        if (Array.isArray(raw.pending)) state.pending = raw.pending.filter((name): name is string => typeof name === 'string');
        if (Array.isArray(raw.gaps)) state.gaps = raw.gaps.filter((gap): gap is Gap => gap !== null && typeof gap === 'object' && typeof (gap as Gap).what === 'string' && typeof (gap as Gap).ref === 'string' && typeof (gap as Gap).why === 'string');
        if (Array.isArray(raw.agents)) state.agents = raw.agents.filter((agent): agent is string => typeof agent === 'string');
        if (Array.isArray(raw.looseFolders)) state.looseFolders = raw.looseFolders.filter((folder): folder is string => typeof folder === 'string');
      }
      return state;
    } catch {
      // A state file that does not parse is a destroyed state: every record looks new, files are written again - the
      // host leaves the identical ones alone - and the next full sweep restores the bookkeeping.
      return emptyState();
    }
  }

  private save(state: State): void {
    const text = JSON.stringify(
      {
        shards: sorted(state.shards),
        sources: sorted(state.sources),
        records: sorted(state.records),
        pending: [...state.pending].sort(),
        gaps: state.gaps,
        agents: [...state.agents].sort(),
        looseFolders: [...state.looseFolders].sort(),
      },
      null,
      1,
    );
    if (this.workspace.exists('.state/state.json') && this.workspace.readText('.state/state.json') === text) return;
    this.workspace.writeText('.state/state.json', text);
  }
}
