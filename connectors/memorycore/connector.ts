/// <reference path="./repoql-connector.d.ts" />
// Tencent MemoryCore -> RepoQL. fetch reads the store's read-only data folder and
// keeps only the sanitized files this import publishes. render reads those rows
// and writes the workspace; it never reaches back into the source.
import { Connector, InvalidImport, type Changes, type FetchResult, type ImportTarget, type ImportUri, type Row } from 'repoql:connector';

const ROOT = 'data';
const COLLECTION = 'memorycore';
const RUN_KEY = '@run';
const SHARD = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const RECORD_ID = /^[A-Za-z0-9_-]{1,158}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const PROFILE = /^team:([A-Za-z0-9._-]{1,64})\|agent:([A-Za-z0-9._-]{1,64})$/;
const PERSONA = /^persona(?:\.([A-Za-z0-9_-]{1,64}))?\.md$/;
const DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const VALUE_CHUNK = 4000;
const PAGE = 500;

interface Item { kind: 'shard' | 'profile'; name: string }
interface Run { kind: 'run'; items: Item[] }
interface FileRow {
  kind: 'file'; path: string; part: number; content: string; sourceRef: string; identity: string;
  fileKind: 'record' | 'persona' | 'scene'; time?: string; sourceModified?: string;
  recordId?: string; recordType?: string; day?: string; agent?: string;
}
interface GapRow { kind: 'gap'; ref: string; what: string; why: string; looseFolder?: string; pending?: boolean }
interface RecordIndexRow { kind: 'record-index'; id: string; path: string; sourceRef: string }
type Stored = FileRow | GapRow | Run | RecordIndexRow;
interface Stat { size: number; modified: string }
interface OutputFile { path: string; text: string; time?: string; sourceModified?: string; fileKind: FileRow['fileKind']; recordId?: string; recordType?: string; day?: string; agent?: string }

const isText = (value: unknown): value is string => typeof value === 'string' && !value.includes('\0');
const q = (value: string): string => JSON.stringify(value);

function isInstant(value: unknown): value is string {
  return typeof value === 'string' && INSTANT.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}

function safeName(name: string): boolean {
  if (name === '' || name.length > 200 || /[\\/:*?"<>|]/.test(name) || /[\u0000-\u001f\u007f]/.test(name)) return false;
  if (name.endsWith('.') || name.endsWith(' ') || DEVICE.test(name)) return false;
  return true;
}

function lead(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const points = Array.from(flat);
  return points.length <= 120 ? flat : `${points.slice(0, 119).join('')}\u2026`;
}

// The connector has no secrets grant: these known credential shapes are its
// entire redaction boundary for text copied from the source.
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

function decodeProfile(folder: string): [string, string] | null {
  let decoded: string;
  try { decoded = decodeURIComponent(folder); } catch { return null; }
  const match = PROFILE.exec(decoded);
  return match === null ? null : [match[1], match[2]];
}

function personaPlane(name: string): string | null {
  const match = PERSONA.exec(name);
  return match === null ? null : match[1] ?? '';
}

function fileIdentityKey(identity: string, part: number): string {
  return `file|${encodeURIComponent(identity)}|${String(part).padStart(6, '0')}`;
}

function gapKey(ref: string, what: string): string {
  return `gap|${encodeURIComponent(ref)}|${encodeURIComponent(what)}`;
}

function recordIndexKey(id: string): string { return `index|${encodeURIComponent(id)}`; }

function validEntry(value: unknown): value is { name: string; directory: boolean } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as { name?: unknown; directory?: unknown };
  return typeof entry.name === 'string' && typeof entry.directory === 'boolean';
}

export default class MemoryCore extends Connector {
  static parse(uri: ImportUri): ImportTarget {
    if (uri.authority !== ROOT || uri.path.length > 0 || uri.query.length > 0)
      throw new InvalidImport('A MemoryCore import is memorycore://data: the connector reads the store\'s whole data folder, which is the source root it asks for.');
    return { root: `memorycore://${ROOT}/`, title: 'Tencent MemoryCore' };
  }

  fetch(cursor?: string): FetchResult {
    // This source has no change feed. Every scheduled pass is deliberately a
    // full listing; only its final call may remove rows the source no longer has.
    if (this.pass?.full !== true) throw new Error('MemoryCore requires a full source listing; no rows were removed.');

    let at = 0;
    let run: Run;
    if (cursor === undefined) {
      run = { kind: 'run', items: this.items() };
      if (JSON.stringify(run).length > 100_000) throw new Error('The source listing is too large to snapshot safely; no rows were removed.');
      this.db.put<Run>(COLLECTION, RUN_KEY, run);
    } else {
      const found = this.db.get<Run>(COLLECTION, RUN_KEY);
      if (!this.validRun(found)) throw new Error('The saved source listing is missing or malformed; no rows were removed.');
      run = found;
      if (!/^(?:0|[1-9]\d*)$/.test(cursor)) throw new Error('The saved source cursor is malformed; no rows were removed.');
      at = Number(cursor);
      if (!Number.isSafeInteger(at) || at < 0 || at > run.items.length) throw new Error('The saved source cursor is outside its listing; no rows were removed.');
    }

    while (at < run.items.length) {
      const item = run.items[at];
      if (item.kind === 'shard') this.bringShard(item.name);
      else this.bringProfile(item.name);
      at += 1;
      if (at < run.items.length && this.signal.aborted) return { cursor: String(at) };
    }

    // A changed listing would make removeUnseen unsafe. Leave all prior rows
    // intact and let the next scheduled full pass take a fresh snapshot.
    if (!this.sameItems(run.items, this.items())) throw new Error('The MemoryCore listing changed during this pass; no rows were removed.');
    this.db.remove(COLLECTION, RUN_KEY);
    return { removeUnseen: true };
  }

  private validRun(value: unknown): value is Run {
    if (value === null || typeof value !== 'object' || (value as Run).kind !== 'run' || !Array.isArray((value as Run).items)) return false;
    return (value as Run).items.every((item) => item && (item.kind === 'shard' || item.kind === 'profile') && typeof item.name === 'string');
  }

  private sameItems(left: Item[], right: Item[]): boolean {
    return left.length === right.length && left.every((item, index) => item.kind === right[index].kind && item.name === right[index].name);
  }

  private list(path: string): { name: string; directory: boolean }[] {
    const entries = this.source.list(path);
    if (!Array.isArray(entries) || !entries.every(validEntry)) throw new Error(`The source listing for ${path} is malformed; no rows were removed.`);
    return entries as { name: string; directory: boolean }[];
  }

  private items(): Item[] {
    const items: Item[] = [];
    if (this.source.exists('records')) {
      for (const entry of this.list('records')) if (!entry.directory && SHARD.test(entry.name)) items.push({ kind: 'shard', name: entry.name });
    }
    if (this.source.exists('profiles')) {
      for (const entry of this.list('profiles')) if (entry.directory) items.push({ kind: 'profile', name: entry.name });
    }
    return items.sort((a, b) => {
      const ak = `${a.kind}/${a.name}`; const bk = `${b.kind}/${b.name}`;
      return ak < bk ? -1 : ak > bk ? 1 : 0;
    });
  }

  private stat(path: string): Stat {
    const stat = this.source.stat(path);
    if (!stat || !Number.isFinite(stat.size) || stat.size < 0 || typeof stat.modified !== 'string' || stat.directory)
      throw new Error(`The source file metadata for ${path} is malformed; no rows were removed.`);
    return { size: stat.size, modified: stat.modified };
  }

  private sameStat(a: Stat, b: Stat): boolean { return a.size === b.size && a.modified === b.modified; }

  private chunks(text: string): string[] {
    const out: string[] = [];
    if (text.length === 0) return [''];
    for (let at = 0; at < text.length; at += VALUE_CHUNK) out.push(text.slice(at, at + VALUE_CHUNK));
    return out;
  }

  private putFile(path: string, content: string, sourceRef: string, fileKind: FileRow['fileKind'], time: string | undefined, sourceModified: string | undefined, metadata: Partial<FileRow> = {}): void {
    const chunks = this.chunks(content);
    for (let part = 0; part < chunks.length; part += 1) {
      const row: FileRow = { kind: 'file', identity: path, path, part, content: chunks[part], sourceRef, fileKind, ...metadata };
      if (time !== undefined) row.time = time;
      if (sourceModified !== undefined) row.sourceModified = sourceModified;
      this.db.put<FileRow>(COLLECTION, fileIdentityKey(path, part), row, time === undefined ? undefined : { time });
    }
  }

  private gap(ref: string, what: string, why: string, looseFolder?: string, pending = false): void {
    const row: GapRow = { kind: 'gap', ref, what, why };
    if (looseFolder !== undefined) row.looseFolder = looseFolder;
    if (pending) row.pending = true;
    this.db.put<GapRow>(COLLECTION, gapKey(ref, what), row);
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

  // A split render's list() is restricted to that slice's changed keys. SQL
  // deliberately reads the entire committed import so every slice derives the
  // same files from the same database state.
  private allRowsForRender(): Row<Stored>[] {
    const selected = this.db.query('SELECT key, value FROM kv WHERE collection = $1 ORDER BY key', [COLLECTION]);
    return selected.map((entry) => {
      if (typeof entry.key !== 'string') throw new Error('The MemoryCore database has a malformed key; render was not published.');
      let value: unknown = entry.value;
      if (typeof value === 'string') {
        try { value = JSON.parse(value); }
        catch { throw new Error('The MemoryCore database has a malformed row; render was not published.'); }
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('The MemoryCore database has a malformed row; render was not published.');
      return { key: entry.key, value: value as unknown as Stored };
    });
  }

  private preserve(predicate: (row: FileRow) => boolean): void {
    const keys: string[] = [];
    for (const row of this.rows()) if ((row.value as FileRow).kind === 'file' && predicate(row.value as FileRow)) keys.push(row.key);
    for (let at = 0; at < keys.length; at += PAGE) this.db.touch(COLLECTION, keys.slice(at, at + PAGE));
  }

  private removePathRows(path: string): void {
    const keys = this.rows().filter((row) => {
      const value = row.value as Stored;
      return value.kind === 'file' && value.path === path;
    }).map((row) => row.key);
    for (const key of keys) this.db.remove(COLLECTION, key);
  }

  private bringShard(name: string): void {
    const ref = `records/${name}`;
    const before = this.stat(ref);
    const text = this.source.readText(ref);
    if (typeof text !== 'string') throw new Error(`The source shard ${ref} is not text; no rows were removed.`);
    const after = this.stat(ref);
    let torn = !this.sameStat(before, after);
    let badLine = false;
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      let line = lines[index];
      if (index === 0 && line.startsWith('\uFEFF')) line = line.slice(1);
      if (line.trim() === '') continue;
      let record: unknown;
      try { record = JSON.parse(line); }
      catch { torn = true; badLine = true; continue; }
      this.bringRecord(record, name, before.modified);
    }
    if (torn) {
      this.preserve((row) => row.sourceRef === ref);
      this.gap(ref, `The newest lines of ${ref}`, badLine ? 'A line was incomplete or malformed while the store was writing it; the prior copy is retained until a complete read.' : 'The shard changed while it was read; the prior copy is retained until a complete read.', undefined, true);
    }
  }

  private bringRecord(record: unknown, shard: string, sourceModified: string): void {
    const ref = `records/${shard}`;
    if (record === null || typeof record !== 'object' || Array.isArray(record)) throw new Error(`The shard ${ref} contains a line that is not a record object.`);
    const r = record as Record<string, unknown>;
    const id = r.id;
    if (typeof id !== 'string' || !RECORD_ID.test(id)) throw new Error(`The shard ${ref} contains a record whose id is not a safe identifier.`);
    const created = r.createdAt;
    if (!isInstant(created)) throw new Error(`The record ${id} has a createdAt that is not UTC with milliseconds.`);
    if (!isText(r.content)) {
      const what = `The record ${id}, whose text holds a zero byte`;
      this.preserve((row) => row.recordId === id);
      this.db.get<RecordIndexRow>(COLLECTION, recordIndexKey(id));
      this.gap(ref, what, 'A workspace file is text, and a zero byte cannot be written as one.');
      return;
    }
    const updated = isInstant(r.updatedAt) ? r.updatedAt : created;
    const day = created.slice(0, 10);
    const path = `records/${day}/${id}.md`;
    const type = typeof r.type === 'string' && r.type !== '' ? r.type : 'unknown';
    const indexKey = recordIndexKey(id);
    const prior = this.db.get<RecordIndexRow>(COLLECTION, indexKey);
    if (prior?.kind === 'record-index' && prior.path !== path) this.removePathRows(prior.path);
    this.db.put<RecordIndexRow>(COLLECTION, indexKey, { kind: 'record-index', id, path, sourceRef: ref });
    this.putFile(path, this.recordFile(r, id, created, updated, day, ref), ref, 'record', created,
      isInstant(sourceModified) ? sourceModified : undefined, { recordId: id, recordType: type, day });
  }

  private recordFile(r: Record<string, unknown>, id: string, created: string, updated: string, day: string, ref: string): string {
    const text = redact(r.content as string);
    const facts: string[] = [
      `title: ${q(lead(text) || `Memory record ${id}`)}`,
      `kind: ${q('memory-record')}`,
      `id: ${q(id)}`,
    ];
    if (typeof r.type === 'string' && r.type !== '') facts.push(`type: ${q(r.type)}`);
    if (typeof r.priority === 'number' && Number.isFinite(r.priority)) facts.push(`priority: ${String(r.priority)}`);
    facts.push(`created: ${q(created)}`, `updated: ${q(updated)}`);
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

  private bringProfile(folder: string): void {
    const decoded = decodeProfile(folder);
    if (decoded === null) {
      const ref = `profiles/${folder}`;
      this.gap(ref, `The profile folder ${ref}`, 'Its name states no team and an agent, so its files cannot be placed under personas/ and scenes/.', folder);
      return;
    }
    const [team, agent] = decoded;
    const base = `profiles/${folder}`;
    for (const entry of this.list(base)) {
      if (entry.directory) {
        if (entry.name === 'scene_blocks') this.bringScenes(base, folder, team, agent);
        continue;
      }
      const plane = personaPlane(entry.name);
      if (plane !== null) this.bringPersona(base, folder, entry.name, plane, team, agent);
    }
  }

  private bringPersona(base: string, folder: string, name: string, plane: string, team: string, agent: string): void {
    const source = `${base}/${name}`;
    this.bringProfileFile(source, `${folder}/${name}`, (text) => {
      const body = redact(text);
      const title = plane === '' ? `Persona - agent ${agent}` : `Persona (${plane}) - agent ${agent}`;
      const facts = [`title: ${q(title)}`, `kind: ${q('memory-persona')}`, `team: ${q(team)}`, `agent: ${q(agent)}`,
        ...(plane === '' ? [] : [`plane: ${q(plane)}`]), `source_file: ${q(`profiles/${folder}/${name}`)}`];
      return { text: `---\n${facts.join('\n')}\n---\n\n${body}${body.endsWith('\n') ? '' : '\n'}`, fileKind: 'persona' as const, agent };
    });
  }

  private bringScenes(base: string, folder: string, team: string, agent: string): void {
    const dir = `${base}/scene_blocks`;
    for (const entry of this.list(dir)) {
      const name = entry.name;
      if (entry.directory || !name.endsWith('.md') || !safeName(name)) continue;
      const source = `${dir}/${name}`;
      this.bringProfileFile(source, `${folder}/scene_blocks/${name}`, (text, stat) => {
        const fields = this.meta(text);
        const body = redact(fields.body);
        const summary = fields.fields.summary !== undefined ? redact(fields.fields.summary) : '';
        const title = summary !== '' ? summary : lead(body) || name.slice(0, -3);
        const facts = [`title: ${q(title)}`, `kind: ${q('memory-scene')}`, `scene: ${q(name.slice(0, -3))}`,
          `team: ${q(team)}`, `agent: ${q(agent)}`];
        if (isInstant(fields.fields.created)) facts.push(`created: ${q(fields.fields.created)}`);
        if (isInstant(fields.fields.updated)) facts.push(`updated: ${q(fields.fields.updated)}`);
        if (/^\d{1,6}$/.test(fields.fields.heat ?? '')) facts.push(`heat: ${fields.fields.heat}`);
        facts.push(`source_file: ${q(`profiles/${folder}/scene_blocks/${name}`)}`);
        const modified = isInstant(fields.fields.updated) ? fields.fields.updated : (isInstant(stat.modified) ? stat.modified : undefined);
        return { text: `---\n${facts.join('\n')}\n---\n\n${body}${body.endsWith('\n') ? '' : '\n'}`, fileKind: 'scene' as const, agent, modified };
      });
    }
  }

  private meta(text: string): { fields: Record<string, string>; body: string } {
    const start = '-----META-START-----'; const end = '-----META-END-----';
    const at = text.indexOf(start); const to = text.indexOf(end);
    if (at === -1 || to === -1 || to < at) return { fields: {}, body: text };
    const fields: Record<string, string> = {};
    for (const line of text.slice(at + start.length, to).split('\n')) {
      const match = /^([A-Za-z_]+):\s*(.*)$/.exec(line.trim());
      if (match !== null) fields[match[1]] = match[2].trim();
    }
    return { fields, body: text.slice(to + end.length).replace(/^\n+/, '') };
  }

  private bringProfileFile(source: string, sourceKey: string,
    build: (text: string, stat: Stat) => { text: string; fileKind: FileRow['fileKind']; agent: string; modified?: string }): void {
    const before = this.stat(source);
    const text = this.source.readText(source);
    if (typeof text !== 'string') throw new Error(`The source file ${source} is not text; no rows were removed.`);
    const after = this.stat(source);
    if (!isText(text)) {
      this.preserve((row) => row.sourceRef === source);
      this.gap(source, `The file ${source}`, 'Its text holds a zero byte, and a workspace file is text.');
      return;
    }
    if (!this.sameStat(before, after)) {
      this.preserve((row) => row.sourceRef === source);
      this.gap(source, `The file ${source}`, 'It changed while it was read; the prior copy is retained until a complete read.', undefined, true);
      return;
    }
    const built = build(text, before);
    const path = this.workspacePath(sourceKey);
    const modified = built.modified ?? (isInstant(before.modified) ? before.modified : undefined);
    this.putFile(path, built.text, source, built.fileKind, modified, isInstant(before.modified) ? before.modified : undefined, { agent: built.agent });
  }

  private workspacePath(key: string): string {
    const parts = key.split('/');
    const decoded = decodeProfile(parts[0]);
    if (decoded === null) throw new Error('A profile folder changed to an invalid team and agent name; no rows were removed.');
    const [team, agent] = decoded;
    if (parts.length === 2) return `personas/${team}/${agent}/${parts[1]}`;
    if (parts.length === 3 && parts[1] === 'scene_blocks') return `scenes/${team}/${agent}/${parts[2]}`;
    throw new Error('A profile source path is outside the approved persona and scene folders; no rows were removed.');
  }

  render(changes: Changes): void {
    const rows = this.allRowsForRender();
    const groups = new Map<string, FileRow[]>();
    const gaps: GapRow[] = [];
    for (const item of rows) {
      if (item.key === RUN_KEY) continue;
      const value = item.value as Stored;
      if (value.kind === 'gap') gaps.push(value);
      else if (value.kind === 'file') {
        const group = groups.get(value.path) ?? [];
        group.push(value);
        groups.set(value.path, group);
      }
    }
    for (const path of this.removedPaths(changes)) this.files.remove(path);
    const files: OutputFile[] = [];
    for (const parts of groups.values()) {
      parts.sort((a, b) => a.part - b.part);
      for (let i = 0; i < parts.length; i += 1) if (parts[i].part !== i) throw new Error('A stored MemoryCore file is missing a chunk; render was not published.');
      const first = parts[0];
      files.push({ path: first.path, text: parts.map((part) => part.content).join(''), fileKind: first.fileKind,
        time: first.time, sourceModified: first.sourceModified, recordId: first.recordId, recordType: first.recordType, day: first.day, agent: first.agent });
    }
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    for (const file of files) this.files.write(file.path, file.text, file.time === undefined ? undefined : { time: file.time });
    this.files.write('overview.md', this.overview(files, gaps));
    this.teach();
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
          catch { throw new Error('The removed MemoryCore path is malformed; render was not published.'); }
        }
      }
      after = page.next;
    } while (after !== undefined);
    return Array.from(paths).sort();
  }

  private overview(files: OutputFile[], gaps: GapRow[]): string {
    const records = files.filter((file) => file.fileKind === 'record');
    const scenes = files.filter((file) => file.fileKind === 'scene');
    const personas = files.filter((file) => file.fileKind === 'persona');
    const types = new Map<string, number>();
    const days = records.map((file) => file.day ?? '').filter(Boolean).sort();
    for (const record of records) {
      const type = record.recordType ?? 'unknown';
      types.set(type, (types.get(type) ?? 0) + 1);
    }
    const agents = new Set([...scenes, ...personas].map((file) => file.agent).filter((agent): agent is string => typeof agent === 'string'));
    let newest = '';
    for (const file of files) if (file.sourceModified && file.sourceModified > newest) newest = file.sourceModified;
    const kindCounts = Array.from(types.keys()).sort().map((kind) => `${kind} ${types.get(kind)}`).join(', ');
    const lines = [
      '# Tencent MemoryCore as imported', '',
      'This import is a copy of a Tencent MemoryCore store, read from the store\'s data folder. Every file under `records/`, `scenes/` and `personas/` is one item of the store\'s memory as the store wrote it, with the store\'s own ids, instants and provenance in its frontmatter, and nothing restated or merged. A memory here is evidence of what was remembered when, not a claim about what is true now.', '',
      '## What the copy holds', '',
      `- memory records: ${records.length}${days.length ? `, from ${days[0]} to ${days[days.length - 1]}` : ''}${kindCounts ? ` (${kindCounts})` : ''}`,
      `- scene blocks: ${scenes.length} across ${agents.size} ${agents.size === 1 ? 'agent' : 'agents'}`,
      `- persona files: ${personas.length} across ${agents.size} ${agents.size === 1 ? 'agent' : 'agents'}`, '',
      '## What it leaves out', '',
      '- The store\'s raw conversation logs (`conversations/`), its `vectors.db`, its `metadata/`, `instances/` and `.backup/` folders, and every `.metadata/` folder: none of them is memory, and none is read.',
      '- Of each record: its `source_message_ids`, its `sessionKey` and every `metadata` member except the two activity instants. Every other fact the store states is kept.',
      '- Credential-shaped text: the token shapes listed in README.md are replaced with `[redacted]` in every file. A shape that list does not name is written as it stands.',
    ];
    const loose = gaps.map((gap) => gap.looseFolder).filter((folder): folder is string => typeof folder === 'string').sort();
    if (loose.length) lines.push(`- ${loose.length} profile folder${loose.length === 1 ? '' : 's'} whose name states no team and an agent: ${loose.join(', ')}`);
    if (gaps.length) {
      lines.push('', '## Gaps', '', `- ${gaps.length} source item${gaps.length === 1 ? ' is' : 's are'} not in the copy.`);
      for (const gap of gaps.sort((a, b) => a.what < b.what ? -1 : a.what > b.what ? 1 : 0).slice(0, 15)) lines.push(`- ${gap.what}: ${gap.why}`);
      if (gaps.length > 15) lines.push(`- ${gaps.length - 15} more source items are not copied.`);
    } else lines.push('', 'The copy has no known gaps.');
    lines.push('', `Last compared with everything the source lists: ${newest === '' ? 'never' : newest}`, '');
    return lines.join('\n');
  }

  private teach(): void {
    this.concepts.set({ name: 'MemoryTiers', category: 'shape', invariant: 'The store builds memory in three tiers and the import mirrors them: records/ is L1 episodes, scenes/ is L2 scene blocks, personas/ is L3 profiles, one file per item, named by the store\'s own id.', tags: ['memory', 'tiers', 'records', 'scenes', 'personas'], relevance: ['records/**', 'scenes/**', 'personas/**'], why: 'The store extracts L1 records from conversations, merges them into L2 scenes, and summarises those into L3 personas; the folder layout is the store\'s own.' });
    this.concepts.set({ name: 'MemoryEvidence', category: 'rule', invariant: 'A file here is what the store held at its instant, not what is true now: a later record may supersede an earlier one, and no file in the import states a current fact.', tags: ['memory', 'time', 'stale', 'evidence'], relevance: '**', why: 'The store is append-only: a changed fact is a new record beside the old one, so only the instants say which came first.', example: 'grep the two records for a changed endpoint and prefer the one whose `created` is later, then verify against the live system before acting.' });
    this.concepts.set({ name: 'RecordProvenance', category: 'shape', invariant: 'Every record states the session, task, team, agent and user it came from, and its file sits under the day it was created; quote a record by its id, and its provenance is the way back to the session that produced it.', tags: ['memory', 'provenance', 'session', 'citation'], relevance: 'records/**', example: 'read("memorycore://data/records/2026-01-07/m_1736233200000_aa01bb02.md") and cite session ses_fixture01.' });
    this.concepts.set({ name: 'MemoryFreshness', category: 'wisdom', invariant: 'Weigh a record by its `created` instant before relying on it, and check the live system or the code before acting on a memory of state.', tags: ['memory', 'verification', 'freshness'], relevance: '**', why: 'The failure memory systems measure is acting on an outdated fact even when the newer one is beside it; every file here carries the instant that tells the two apart.' });
    this.vocabulary.set({ term: 'L1 record', meaning: 'One memory the store extracted from a session, typed episodic, instruction or persona, kept under records/ by its creation day.', aliases: ['memory record', 'episode', 'episodic memory'], scope: 'records/**' });
    this.vocabulary.set({ term: 'scene block', meaning: 'A store-written narrative that merges related episodes for one agent, kept under scenes/.', aliases: ['scene', 'L2 scene'], scope: 'scenes/**' });
    this.vocabulary.set({ term: 'persona', meaning: 'The store\'s narrative profile of the user for one agent and one extraction plane, kept under personas/.', aliases: ['L3 profile', 'user profile'], scope: 'personas/**' });
  }
}
