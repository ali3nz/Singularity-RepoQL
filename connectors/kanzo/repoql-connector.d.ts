// Type declarations for a connector written as two files: connector.ts, whose default export extends the
// Connector class of the built-in module 'repoql:connector', and manifest.yaml beside it, which states what the
// connector asks for. rql builds the two into a connector module; no code of the file runs while it is built.
// Nothing here runs. `rql connector test` and `rql connector pack` check a connector's types against this file, with
// the TypeScript compiler rql carries, and refuse a file with a type error. A host that loads a connector checks no
// type. A read of a member this file does not declare, on a member of the class or on a reply, also throws at run
// time, naming the member: that finds a read the compiler cannot see behind `any`. The host checks every shape it is
// handed and refuses anything else, naming the member.
//
// Write this file and a tsconfig.json beside a connector, for an editor:  rql connector types
// Reference it from the first line of a connector:                       /// <reference path="./repoql-connector.d.ts" />
// Test the connector with no host and no network:                        rql connector test connector.ts --fixtures lifecycle.json

/** The lines a connector logs. The host bounds a line and replaces the call's secrets in it. */
declare var console: {
  log(...values: unknown[]): void;
  warn(...values: unknown[]): void;
  error(...values: unknown[]): void;
};

declare module 'repoql:connector' {
  /** Any JSON value: a target, a reply, a JSON response body. */
  export type Json = string | number | boolean | null | Json[] | { [member: string]: Json };

  /**
   * A connector: one TypeScript file whose default export extends this class. What the connector asks for is in
   * `manifest.yaml`; a class that declares `static manifest` is refused. The host calls only the operations the
   * manifest names under `calls`.
   *
   * Every call runs once, in a fresh sandbox, synchronously: no method is `async`, and every member below returns
   * its value at once. No state survives a call: keep a position in the cursor, or in a file under `.state/`.
   * `Date` and `this.clock.now()` read one frozen instant in a call, `performance.now()` returns 0 and
   * `Math.random()` throws, so the same source data always gives the same files.
   *
   * A connector brings a workspace up to date by writing files into it. RepoQL indexes the workspace like any
   * folder: nothing reaches the index except by being a file there.
   */
  export abstract class Connector {
    /** An HTTPS client that reaches only the hosts the manifest names under `network.hosts`. */
    readonly http: Http;
    /** The values of the secret names the manifest lists under `secrets`. */
    readonly secrets: Secrets;
    /** The call's frozen instant. */
    readonly clock: Clock;
    /** Whether the host asks this call to finish and return. A `sync` that has more to do reads it between items. */
    readonly signal: StopSignal;
    /**
     * The import's files, at `/workspace`. Present in `sync` and `prune`, and in a function that takes an import: read
     * and write when an `execute` script's member calls it, read-only from a query, where every change throws the
     * read-only message. In any other call every member throws.
     */
    readonly workspace: Workspace;
    /** The folder of the source root the import's URI names as its authority, read-only, at `/source`. Only when the manifest asks for source roots. */
    readonly source: Folder;
    /** RepoQL's inference, when the manifest declares `inference: true` and the operator granted it. */
    readonly llm: Llm;
    /** Where a reader finds a workspace file in the source system. */
    readonly origin: Origin;
    /** What the connector teaches about its import: how to use or think about a set of its files. Works in `sync` and `prune`, and in a function a script's member calls; from a query `set` and `remove` throw the read-only message; in any other call every member throws. */
    readonly concepts: Concepts;
    /** The source's own terms, with the words that should recall them. Works in `sync` and `prune`, and in a function a script's member calls; from a query `set` and `remove` throw the read-only message; in any other call every member throws. */
    readonly vocabulary: Vocabulary;
    /**
     * In `sync` and `prune`, and in a function that takes an import: the import this call serves, as `parse` answered
     * its root, the same in each. In a function that takes no import, reading it throws, naming `import: true`.
     */
    readonly import?: Import;
    /** The partition whose credentials this call reads, when the manifest says `partitioned: true`. */
    readonly partition?: string;

    /**
     * Brings the workspace up to date. Called with no cursor, then with each answer's `nextCursor` until an answer
     * has none. The files a call wrote are published when it returns, all or none; a thrown error publishes nothing.
     */
    abstract sync(request: SyncRequest): SyncResult | void;

    /**
     * Optional, with `prune` under the manifest's `calls` — which of the files older than `retentionDays` to
     * remove. A candidate the answer does not name is kept.
     */
    prune?(candidates: string[]): PruneResult;

    /** Optional, with `openEvents` under `calls` — where the host dials the event stream, asked afresh at every connect. */
    openEvents?(): EventStream;

    /**
     * Optional, with `mapEvent` under `calls` — maps one pushed CloudEvent to the files the host should bring up to
     * date. It carries no content: the `sync` it causes fetches what changed. It has 5 seconds.
     */
    mapEvent?(event: CloudEvent): EventOutcome;

    // With `invoke` under `calls`, the class also declares one instance method for each function the manifest declares
    // under `functions`, named after it, such as `balance(customer: string): number | null`. It takes one row's
    // arguments in order and returns that row's value; a table function's method returns an array of row objects whose
    // members are the declared columns. It has HTTP, secrets and `llm` as a `sync` has, and 30 seconds for every row
    // of one call. A function that takes an import (every function of a partitioned connector, and one that declares
    // `import: true`) reads that import as `this.import` and its `workspace` and `source`; any other function has none of them. Called by an
    // `execute` script's member, it writes the workspace as `sync` does, and each change is published when it
    // completes. Called from a query, every change it tries throws "This file system is read-only while a function
    // answers a query: write files from sync instead.": the workspace's writes, `saveTo`, `origin.set`, and setting
    // or removing concepts and vocabulary. See help:///connectors/functions.md.
  }

  /**
   * With `parse` under `calls`, the class also declares `static parse(uri: ImportUri): ImportTarget`, which maps
   * an import URI to its target. It is pure: it has no clock, no directory and no capability, and one second.
   * To reject a URI, throw `InvalidImport`.
   *
   * Only the root of an import is kept. The host asks `parse` about the root again before every sweep, and `sync`
   * is given that answer. So `parse` of the root must answer what `parse` of the URI answered: the same root,
   * `target`, `partition` and `title`. An import or a suite whose URI is answered otherwise is refused.
   */
  export interface ConnectorClass {
    new (): Connector;
    parse?(uri: ImportUri): ImportTarget;
  }

  /** Thrown from `static parse` to reject an import URI. The message reaches the user, followed by the manifest's `uri.example`. */
  export class InvalidImport extends Error {
    readonly invalidImport: true;
    constructor(message: string);
  }

  /** An import URI in its canonical parts. */
  export interface ImportUri {
    scheme: string;
    authority: string;
    path: string[];
    /**
     * A root has no query, so no sweep is given one. Read the query only to choose the root or to reject the URI:
     * what `target`, `partition` or `title` needs goes in the root's path.
     */
    query: [name: string, value: string][];
  }

  /** What `parse` answers. */
  export interface ImportTarget {
    /**
     * The canonical identity of the import, such as `notes://team/`: the URI's scheme and authority, then any path,
     * ending in `/`, with no query. Everything else in the answer comes from the root alone.
     */
    root: string;
    /** Only with `partitioned: true`: whose credentials the import reads. Absent means the root's authority. */
    partition?: string;
    /** At most 200 characters. */
    title?: string;
    /** At most 4 KiB of JSON, handed to every `sync`, `prune` and function that takes an import as `this.import.target`. Never stored: every call has the one `parse` of the root answers. */
    target?: Json;
  }

  /** The import a `sync`, a `prune` or a function that takes an import serves. */
  export interface Import {
    root: string;
    target: Json;
    partition: string;
  }

  /**
   * The host's request that a call finish what it is doing and return. A `sync` or a `prune` is asked when less than
   * a fifth of its deadline is left: the last minute of five. Nothing stops a call that is asked. One that reads
   * `aborted` true returns `nextCursor` for what is left, and what it wrote is published. One that runs on is
   * stopped by its deadline, and nothing it wrote is kept.
   */
  export interface StopSignal {
    /** True once the call is asked to stop, and for the rest of the call. Read it after an item, never before the first. */
    readonly aborted: boolean;
  }

  /** The members of a `sync` call's input document. */
  export interface SyncRequest {
    /** Whether this sweep must visit everything: the first sweep, one after the workspace was lost, and each authoritative sweep. */
    full: boolean;
    /** The `nextCursor` of the call before this one. */
    cursor?: string;
    /** In a sync an event caused: the files to bring up to date, as `mapEvent` named them. */
    keys?: string[];
  }

  export interface SyncResult {
    /** Present when there is more to do: the next call's `cursor`, at most 16,384 characters. */
    nextCursor?: string;
    /** Beside `nextCursor`: how long the host waits before the next call, 0 through 86,400. */
    retryAfterSeconds?: number;
    /**
     * Only on the answer that ends a sweep, the one with no `nextCursor`: what the copy lacks, at most 16 gaps. It
     * describes the whole copy as it stands after this sweep, not only what this sweep read: a sweep that rewrites part of
     * the copy accounts for what earlier sweeps left, keeping what its files do not say under `.state`. The import is
     * then partial until a later sweep ends naming nothing: `rql import list`, `rql connector status` and the
     * footer of every read of its files say so, with the command that reads the rest.
     */
    missing?: Missing[];
  }

  /** One part of the source that the copy lacks, and why. */
  export interface Missing {
    /** What the copy lacks, 1 to 200 characters, such as `Revenue and margin for every customer`. Each gap's `what` is its own. */
    what: string;
    /** Why it was not read, 1 to 1,000 characters, such as `STRIPE_API_KEY may not read Charges and Customers`. */
    why: string;
    /** One of the manifest's `secrets`, when a value of it that may read more is the fix. The host names the command that sets it. */
    secret?: string;
  }

  export interface PruneResult {
    /** The candidates to remove. A path that was not a candidate fails the call. */
    remove: string[];
  }

  export interface EventStream {
    url: string;
    headers?: Record<string, string>;
  }

  /** A pushed event in the CloudEvents shape. */
  export interface CloudEvent {
    id: string;
    source: string;
    type: string;
    data?: Json;
    [attribute: string]: Json | undefined;
  }

  export interface EventOutcome {
    /** At most 1,000 URIs of files to bring up to date. */
    sync?: string[];
    /** Run a sweep after the event sync. */
    sweep?: boolean;
    /** What the host sends back on the stream, at most 64 KiB. */
    reply?: Json;
    /** Close the stream and dial again. */
    reconnect?: boolean;
  }

  export interface Clock {
    /** The call's frozen instant, as ISO 8601 text. A `parse` has no clock, and there this throws. */
    now(): string;
  }

  export interface HttpRequest {
    /** Default `GET`. */
    method?: string;
    url: string;
    headers?: Record<string, string>;
    /** At most 1 MiB. Send a larger body from a file with `bodyFrom`. */
    body?: string | Uint8Array;
    /** How `body` is read from the response. Default `json`. */
    responseType?: 'json' | 'text' | 'bytes';
    /**
     * The host writes the response body straight to this file, and the response then holds `bytesWritten` in
     * place of `body`. A path under the workspace, such as `.state/raw/report.pdf`. The host makes the directories above it.
     */
    saveTo?: string;
    /** The host sends this file as the body: a path under the workspace, or `/source/...` for a file of the source folder. */
    bodyFrom?: string;
  }

  export interface HttpResponse {
    status: number;
    /** Lower-case header names. */
    headers: Record<string, string>;
    /** JSON, text or bytes as `responseType` asked. Absent with `saveTo`. */
    body?: Json | Uint8Array;
    /** With `saveTo`: the bytes written to the file, which is 0 for a status outside 200 through 299. */
    bytesWritten?: number;
  }

  export interface Http {
    /** Sends one request and returns its response whatever the status. At most 20 requests a call: a 21st fails the call, even when its error is caught. */
    request(options: HttpRequest): HttpResponse;
    /** A `GET` that returns the JSON body, and throws for a status outside 200 through 299. */
    get(url: string): Json;
  }

  export interface Secrets {
    /**
     * Reads a declared secret. With `{ forUpdate: true }` it first takes that secret's lock across every process
     * on the machine: read a value you are about to spend, such as a one-time refresh token, this way.
     */
    get(name: string, options?: { forUpdate?: boolean }): string;
    /** Stores a rotated value. A token never belongs in a workspace file. */
    update(name: string, value: string): void;
  }

  export interface FileEntry {
    name: string;
    directory: boolean;
  }

  export interface FileStat {
    size: number;
    /** ISO 8601 text. */
    modified: string;
    directory: boolean;
  }

  /** The reading members of a directory. Every path is relative to the directory, such as `eng/general.md`. */
  export interface Folder {
    /**
     * The whole file as text, read as UTF-8. The call holds the file's bytes while it reads, and then the string: one
     * byte a character when every character is at or below U+00FF, two bytes a character otherwise. A file that does
     * not fit in the memory the call has left throws; `memoryMiB` in manifest.yaml raises the call's memory ceiling.
     */
    readText(path: string): string;
    /** The whole file as bytes. The call holds the file twice while it reads, and once afterwards. */
    readBytes(path: string): Uint8Array;
    exists(path: string): boolean;
    /** Throws when nothing is at the path. */
    stat(path: string): FileStat;
    /** The entries of a directory, in the byte order of their names; of the directory itself with no path. */
    list(path?: string): FileEntry[];
  }

  /**
   * The import's files. A file under `.state/` is the connector's own and is never indexed. A file's modified
   * time is the call's instant unless the connector sets it.
   */
  export interface Workspace extends Folder {
    /** Writes a file, making the directories above it. */
    writeText(path: string, text: string): void;
    /** Writes a file, making the directories above it. */
    writeBytes(path: string, bytes: Uint8Array): void;
    /** Removes a file, or a directory that is empty. */
    remove(path: string): void;
    /** Renames a file or a directory, making the directories above its new name. */
    rename(from: string, to: string): void;
    /** Makes a directory with the directories above it. One that exists is no failure. */
    makeDirectory(path: string): void;
    /** Sets a file's modified time: ISO 8601 text, a `Date`, or milliseconds since the epoch. */
    setModified(path: string, instant: string | Date | number): void;
  }

  export interface CompletionRequest {
    prompt: string;
    context?: string;
    system?: string;
    effort?: 'low' | 'balanced' | 'high';
    /** 0 through 16,384, where 0 leaves the length to the host. */
    maxTokens?: number;
  }

  export interface Completion {
    content: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  }

  /**
   * What a question asks, or what one of its outcomes means: plain words, or an object or an array that sets
   * them out in parts, such as `{ what, not_for, examples }`. The names of the parts are yours to choose.
   */
  export type Description = string | Json[] | { [part: string]: Json };

  /**
   * One question of a decision. `type` names its form, and `criteria` describes its outcomes.
   * A `choice` takes 1 to 255 named options. A `score` takes 2 to 10 descriptions, lowest level first.
   * A `noul` asks yes or no, and its `criteria` may describe what `true` and `false` mean.
   * A description that is `null` leaves its option or level undescribed.
   */
  export type Question =
    | { type: 'choice'; instructions?: Description | null; criteria: Record<string, Description | null> }
    | { type: 'score'; instructions?: Description | null; criteria: (Description | null)[] }
    | { type: 'noul'; instructions?: Description | null; criteria?: { true?: Description | null; false?: Description | null } | null };

  /**
   * The answer to one question. `type` names its form, which is the form of its question. A score's levels are counted from 0, the first
   * description, and `score` is the mean of the level numbers, each weighted by its probability. `legend` gives
   * each level its description, when the decision service sent one. `noul` is the probability of yes, from 0 to 1.
   */
  export type Answer =
    | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
    | { type: 'score'; score: number; confidence: number; probabilities: Record<string, number>; legend?: Record<string, Json> }
    | { type: 'noul'; noul: number };

  export interface Decision {
    model: string;
    answers: Record<string, Answer>;
    usage: { input_tokens: number; output_tokens: number };
  }

  /**
   * A decision request. Its shape and the shape of its reply are those of TypeSafe AI's Jev decision API,
   * except that the host chooses the model.
   */
  export interface DecisionRequest {
    /** The content the questions are about. */
    state: Json;
    /** At most 32 questions. */
    questions: Record<string, Question>;
  }

  /**
   * Inference is never promised. When it is switched off, signed out, over its plan or unreachable, a request
   * throws an `Error` whose `unavailable` is `true`: catch it and write the raw text. A call makes at most 20
   * `complete` requests and at most 1,000 `decide` requests.
   */
  export interface Llm {
    complete(request: CompletionRequest): Completion;
    decide(request: DecisionRequest): Decision;
  }

  export interface Origin {
    /** Records the URL of a workspace file in the source system. The file must exist, and is not one under `.state/`. */
    set(path: string, url: string): void;
  }

  /** One thing worth knowing about a set of the import's files. An agent gets it with the files `relevance` matches. */
  export interface Concept {
    /** A short CamelCase name, such as `TicketLifecycle`. One concept has one name: setting it again replaces it. */
    name: string;
    /** `rule` for what must hold, `shape` for where things are and the form they take, `wisdom` for a way to think about them. */
    category: 'rule' | 'shape' | 'wisdom';
    /** The idea in one sentence, at most 240 characters. */
    invariant: string;
    /** Words an agent would search by. At least one. */
    tags: string[];
    /** The files the concept is about, as patterns relative to the import's root: `'tickets/**'`, `'**\/*.thread.md'`, or `'**'` for the whole import. A pattern that starts with `!` excludes. */
    relevance: string | string[];
    /** Why the invariant holds. */
    why?: string;
    /** An example that makes it concrete. */
    example?: string;
    /** Further short points: distinctions, limits, what it is not. */
    depth?: string[];
  }

  /** What `concepts.list` returns for one concept: what its front matter states, without `why`, `example` and `depth`. */
  export interface ConceptListed {
    name: string;
    category: 'rule' | 'shape' | 'wisdom';
    invariant: string;
    tags: string[];
    relevance: string[];
  }

  /**
   * The import's concepts. RepoQL writes and stores them: a connector states values and never a file. A concept is
   * kept until it is removed, is published with the call that set it, and is discarded with a call that fails. A value
   * RepoQL refuses throws an `Error` that names the member and says what to write.
   */
  export interface Concepts {
    set(concept: Concept): void;
    /** Removes the concept of that name. Returns whether the import held one. */
    remove(name: string): boolean;
    /** The import's concepts, in name order, with what this call set or removed. */
    list(): ConceptListed[];
  }

  /** One of the source's own terms. */
  export interface Term {
    /** The name the source really uses, such as `SLA breach`. */
    term: string;
    /** One sentence that explains it. */
    meaning: string;
    /** Words from outside the source that should recall the term. */
    aliases?: string[];
    /** Tells two senses of one term apart, such as `billing`. */
    domain?: string;
    /** The files the term belongs to, as patterns relative to the import's root. Absent means the whole import. */
    scope?: string | string[];
  }

  /** The import's terms, kept, published and discarded as its concepts are. */
  export interface Vocabulary {
    set(term: Term): void;
    /** Removes the term, in `domain` when it was set in one. Returns whether the import held it. */
    remove(term: string, domain?: string): boolean;
    /** The import's terms, by term and then domain, with what this call set or removed. */
    list(): Term[];
  }
}

// The built-in libraries. A connector may import no other module. Each is imported by its name with or without the
// prefix 'repoql:'. The two declared here are typed. Every other built-in library is typed `any` by the last lines of
// this file, so a mistake in a call of one is not reported.
declare module 'repoql:yaml' {
  const yaml: { load(text: string): unknown; dump(value: unknown): string };
  export default yaml;
  export function load(text: string): unknown;
  export function dump(value: unknown): string;
}
declare module 'repoql:base64' {
  /** UTF-8 text as base64. */
  export function encode(text: string): string;
  /** Base64 back to UTF-8 text. */
  export function decode(base64: string): string;
  /** Bytes as base64. */
  export function fromUint8Array(bytes: Uint8Array): string;
  /** Base64 as bytes. */
  export function toUint8Array(base64: string): Uint8Array;
}
declare module 'repoql:*';
declare module 'yaml' {
  export * from 'repoql:yaml';
  export { default } from 'repoql:yaml';
}
declare module 'base64' {
  export * from 'repoql:base64';
}
declare module 'change-case';
declare module 'dayjs';
declare module 'diff';
declare module 'front-matter';
declare module 'fuse';
declare module 'ignore';
declare module 'ini';
declare module 'json5';
declare module 'microdiff';
declare module 'mustache';
declare module 'ohash';
declare module 'parse-diff';
declare module 'picomatch';
declare module 'radash';
declare module 'semver';
declare module 'toml';
declare module 'toposort';
declare module 'xml';
