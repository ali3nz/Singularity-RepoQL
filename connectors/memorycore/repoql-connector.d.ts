// The connector author API. `rql connector types` writes this file beside a connector, and the type check of a
// connector reads it. It declares the module 'repoql:connector'. help:///skills/writing-connectors/SKILL.md teaches it.

/** Lines the host logs with a failed call, and `rql connector test` prints under each call, in its text and JSON reports; nothing else reads them. */
declare var console: {
  log(...values: unknown[]): void;
  warn(...values: unknown[]): void;
  error(...values: unknown[]): void;
};

declare module 'repoql:connector' {
  /** Any JSON value: what a record holds, what a query returns, and what a parameter takes. */
  export type Json = string | number | boolean | null | Json[] | { [member: string]: Json };

  /** The host's number for one committed call. 0 is before the first. */
  export type Generation = number;

  /**
   * A connector: up to three pipeline handlers, each optional. The host runs an import's handlers one call at a time,
   * in a fresh sandbox: fetch until fetching settles, then analyze, then render. fetch, analyze and render may be async;
   * every member of the class returns its value at once, so a handler awaits only what it computes itself. No state
   * survives a call except what `this.db` holds.
   */
  export abstract class Connector {
    /**
     * fetch, openEvents and functions: HTTPS to the URLs the manifest's network entries allow. No request count; the envelope
     * paces. There is no secrets API: the host attaches the credential an entry's `auth` declares, so a module never
     * holds one. For example, in manifest.yaml:
     *
     *     network:
     *       hosts:
     *         - url: https://api.github.com/repos/**
     *           auth: [{ bearer: GITHUB_TOKEN }]
     *         - url: https://acme.atlassian.net/rest/api/3/**
     *           auth: [{ basic: { user: JIRA_EMAIL, password: JIRA_API_TOKEN } }]
     *         - url: https://api.example.com/v2/**
     *           auth: [{ header: { name: X-Api-Key, secret: EXAMPLE_API_KEY } }]
     *         - url: https://maps.example.com/api/**
     *           auth: [{ query: { name: key, secret: MAPS_KEY } }]
     *         - url: https://oauth2.googleapis.com/token
     *         - url: https://bigquery.googleapis.com/bigquery/v2/**
     *           auth: [{ oauth2: { tokenUrl: https://oauth2.googleapis.com/token, clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, refreshToken: GOOGLE_REFRESH_TOKEN } }]
     *
     * A request that sets the header or query parameter its entry's credential uses throws, on any hop, and so does a
     * response or a redirect that echoes a credential the host attached.
     */
    readonly http: Http;
    /** fetch only, when the manifest asks for source roots: the granted folder, read-only, at `/source`. */
    readonly source: SourceFolder;
    /**
     * Every handler and functions; not mapEvent. Writes (`put`, `remove`, `touch`) are fetch's and analyze's only, each
     * to its own collections: a collection belongs to the handler that first writes it. render and functions only read.
     */
    readonly db: Database;
    /** fetch, analyze and render. */
    readonly blobs: Blobs;
    /** render only. */
    readonly files: Files;
    /** fetch, analyze and render, when the operator granted inference. The host records each answer per request. */
    readonly llm: Llm;
    /** render only. */
    readonly concepts: Concepts;
    /** render only. */
    readonly vocabulary: Vocabulary;
    /** fetch, analyze, render and functions. */
    readonly settings: Settings;
    /** Every handler but mapEvent: the call's frozen instant. In render it is the time of the newest generation its changes reach. */
    readonly clock: Clock;
    /** `aborted` reads `true` once a fifth of the call's five minutes is left: return a cursor that resumes. */
    readonly signal: StopSignal;
    /** The import the call serves, as `parse` answered for its URI; for a function, the import its first argument names. mapEvent and openEvents are given none, and read `this.partition`. */
    readonly import?: Import;
    /**
     * When the manifest declares `partitioned: true`: the partition the import's secrets and events are kept under, the
     * import URI's authority unless `parse` names another. In mapEvent it is the partition whose webhook URL or stream the
     * event arrived on, and in openEvents the partition the stream is dialled for, so `scheme://${this.partition}/<key>` names a record of that import.
     */
    readonly partition?: string;
    /** fetch only: the pass the call belongs to; absent for a call that fetches only the keys pushed events named. */
    readonly pass?: Pass;
    /** fetch only: the keys of records pushed events named, relative to the import's root, such as `PAY-123`. Up to 1,000. */
    readonly keys?: readonly string[];

    /** Resumable: absent `cursor` on a pass's first call. Writes source records to fetch's own collections. */
    fetch?(cursor?: string): FetchResult | void | Promise<FetchResult | void>;
    /** Optional and resumable: runs once fetching settles, reads the whole database, and derives records into its own collections. No network. */
    analyze?(changes: Changes, cursor?: string): AnalyzeResult | void | Promise<AnalyzeResult | void>;
    /** One call: writes the files for `changes` from the database, which it reads only. It returns nothing. */
    render?(changes: Changes): void | Promise<void>;
    // A function the manifest declares is a method named after it. A scalar function's method takes a call's
    // argument rows together, up to its `batch`, and returns one answer for each in the same order, so it can ask
    // the source for all of them in one request. A table function's method takes one call's arguments and returns
    // an array of row objects whose members are the declared columns.
    /**
     * When the manifest declares `events: { stream: true }`: the socket the host dials and holds. It may ask the source
     * for the URL with `this.http`, as Slack's Socket Mode hands out a single-use one, and reaches nothing else.
     */
    openEvents?(): EventStream;
    /** Under a five-second deadline, with the event alone: no database, network, model or settings. */
    mapEvent?(event: CloudEvent): EventOutcome;
  }

  /** The class a connector's module exports as its default. */
  export interface ConnectorClass {
    /** A fresh instance for each call: no field survives the call. */
    new (): Connector;
    /** Named `parse` in the manifest's calls: turns an import's URI into its root and target, or throws InvalidImport. */
    parse?(uri: ImportUri): ImportTarget;
  }

  /** Thrown by `parse` for a URI the connector does not take: its message says what a valid URI looks like. */
  export class InvalidImport extends Error {
    /** Marks the error as the connector's refusal of the URI. */
    readonly invalidImport: true;
    /** `message`: what a valid URI looks like, such as `An import names one account, such as tracker://acme.` */
    constructor(message: string);
  }

  /** An import's URI, as `parse` is given it: `tracker://acme/PAY?state=open` is `tracker`, `acme`, `['PAY']`, `[['state', 'open']]`. */
  export interface ImportUri { scheme: string; authority: string; path: string[]; query: [name: string, value: string][] }
  /**
   * What `parse` answers: the import's `root`, a URI that ends with `/` and under which its files are served; the `target`
   * fetch, analyze, render and an import's function read as `this.import.target`; a `partition` its secrets are kept under; and a `title` status shows.
   */
  export interface ImportTarget { root: string; partition?: string; title?: string; target?: Json }
  /** The import a call serves: its root, its target, and its partition. */
  export interface Import { root: string; target: Json; partition: string }
  /** Asked afresh at every read. */
  export interface StopSignal { readonly aborted: boolean }
  /** `now()` answers an ISO 8601 instant in UTC to the millisecond, such as `2026-03-04T05:06:07.000Z`: take `slice(0, 19) + 'Z'` for whole seconds. */
  export interface Clock { now(): string }

  // ---- The handlers --------------------------------------------------------------------------------------------

  /** The pass a fetch call belongs to. */
  export interface Pass {
    /** `true` on every call of a full pass: list everything the source holds, and end with `removeUnseen: true`. */
    full: boolean;
  }
  /** What a fetch call returns; returning nothing ends the pass. */
  export interface FetchResult {
    /** Present: call again. Absent: the pass is done. At most 16,384 characters. */
    cursor?: string;
    /** Whole seconds, 1 through 86,400, only beside a cursor. */
    wait?: number;
    /**
     * `true` on the last call of a full pass whose listing was whole: the host removes every record of fetch's
     * collections that this pass did not put, touch or read by key. The host ignores it on any other call.
     */
    removeUnseen?: boolean;
  }

  /**
   * What analyze or render is given: the records that changed or were removed after generation `since` and up to
   * `until`, which `this.db.changes(collection, { since, until })` pages through. `full: true` asks for every record,
   * with `since` 0: in render, the host then removes every published file the call did not write, once a full pass has
   * completed in the import's database. `keys` is present only when the host split a render by key range: the call
   * renders the keys after `keys.after` and through `keys.through`, an absent bound leaving that end open. `list` and
   * `changes` already show the call only its range; a query sees every row, so a render that queries reads the bounds.
   */
  export interface Changes { full: boolean; since: Generation; until: Generation; keys?: KeyRange }
  /** One slice of a split render: the key the slice starts after, and its last key, in collection and then key order. */
  export interface KeyRange { after?: RecordKey; through?: RecordKey }
  /** A record's address: its collection and its key within it. */
  export interface RecordKey { collection: string; key: string }
  /** What an analyze call returns; returning nothing ends the run. */
  export interface AnalyzeResult {
    /** Present: call again with it. Absent: the run is done. At most 16,384 characters. */
    cursor?: string;
    /** Whole seconds, 1 through 86,400, only beside a cursor. */
    wait?: number;
  }

  // ---- The import database -------------------------------------------------------------------------------------

  /** One record: its key, its value, and its own time; the staged files its value names by `blob:sha256:<hex>` live with it. */
  export interface Row<T = Json> { key: string; value: T; time?: string }

  /** A page of `list`. Pass `next` as `after` for the next page. */
  export interface Page<T = Json> { rows: Row<T>[]; next?: string }

  /** A page of what changed between two generations. A key is never in both lists. */
  export interface ChangePage<T = Json> { changed: Row<T>[]; removed: string[]; next?: string }

  /** The import's database: records in collections, and full SQL over them. */
  export interface Database {
    /**
     * A value, including this call's own writes, or `undefined` for a key with no record: a record that holds `null`
     * reads as `null`. In fetch, a row put under another `recordsVersion` reads as absent, and a key read during a pass
     * counts as seen by it.
     */
    get<T = Json>(collection: string, key: string): T | undefined;
    /** The values of the keys that exist, read as `get` reads them, for up to 10,000 keys. */
    getMany<T = Json>(collection: string, keys: string[]): Record<string, T>;
    /**
     * fetch and analyze, each to its own collections. A put of the value and time already kept changes nothing. A value
     * is at most 16 KiB of JSON, or the manifest's `maxValueBytes`, at most 128 KiB, which grows the import's memory:
     * stage a larger body and put its `blob:sha256:<hex>` identifier in the value instead.
     */
    put<T = Json>(collection: string, key: string, value: T, options?: { time?: string | Date }): void;
    /** fetch and analyze. */
    remove(collection: string, key: string): void;
    /** fetch only: this pass saw these keys, without reading or changing them. */
    touch(collection: string, keys: string[]): void;
    /** A page of a collection in key order, at most 1,000 rows and 1,000 when `limit` is absent, with this call's own writes. Reads nothing as seen. */
    list<T = Json>(collection: string, options?: { prefix?: string; after?: string; limit?: number }): Page<T>;
    /**
     * fetch, analyze and render: the collection's committed changes after `since` and up to `until`, in key order,
     * at most 1,000 a page. The call's own writes commit after every window, so they are never in one.
     */
    changes<T = Json>(collection: string, options: { since: Generation; until: Generation; after?: string; limit?: number }): ChangePage<T>;
    /**
     * Any one statement, reads and writes alike, inside the call's one transaction: a SELECT over
     * `kv(collection, key, value, time)` and the connector's own tables, or a statement that creates or writes a table
     * of its own. Parameters are `$1`, `$2` and so on. A parameter that is an array or an object arrives as JSON text:
     * decode it as JSON first, as in `$1::JSON::VARCHAR[]`. A direct `$1::VARCHAR[]` drops the backslash of every escape
     * but `\"` and `\\`, so `\u00e9` reads as `u00e9`. DuckDB's locked settings bound it: no file, extension or
     * network, and memory spills inside the import. A statement that would begin or end a transaction, attach or
     * detach a database, SET, RESET or USE anything but a variable, run a bare PRAGMA, or reach enable_logging, is
     * refused, and one whose failure aborts the transaction fails the call. It returns at
     * most 10,000 rows and 16 MiB of JSON, and the call's deadline interrupts it. `render` and functions only read.
     */
    query(sql: string, params?: Json[]): Record<string, Json>[];
  }

  /** fetch, analyze and render: reads a staged file a record names, as text, as JSON or as bytes. */
  export interface Blobs {
    /** A staged file by its `blob:sha256:<hex>` identifier. */
    read(blob: string, as: 'text'): string;
    read(blob: string, as: 'json'): Json;
    read(blob: string, as: 'bytes'): Uint8Array;
  }

  /** `origin`: the web address a person opens for the record. `time`: the record's own time. */
  export interface FileOptions { origin?: string; time?: string | Date }

  /** render only: the files it publishes, each at a path relative to the import's root with forward slashes, such as `issues/PAY-1.md`. */
  export interface Files {
    /** Writes a file. A file whose bytes, origin and time are unchanged is left alone and not indexed again. */
    write(path: string, content: string | Uint8Array, options?: FileOptions): void;
    /** Publishes a staged file at a path, as a file the import holds. */
    promote(blob: string, path: string, options?: FileOptions): void;
    /** Removes a published file. A path that holds no file is already removed, and its removal is no error. A full render removes every file it did not write, without this. */
    remove(path: string): void;
    /** The previous version of the file stays published, and status lists the path and the reason. */
    fail(path: string, reason: string): void;
  }

  /** A setting the manifest declares: the operator's stated value, else the manifest's default, else `undefined`. */
  export interface Settings { get(name: string): string | undefined }

  // ---- Shared by every handler ----------------------------------------------------------------------------------------

  /** One request `this.http.request` sends. */
  export interface HttpRequest {
    /** `GET` when absent. */
    method?: string;
    /** An absolute URL a network entry of the manifest allows. */
    url: string;
    /** Request headers. The credential's own header is the host's to attach, and setting it throws. */
    headers?: Record<string, string>;
    /** At most 1 MiB. */
    body?: string | Uint8Array;
    /** How `body` is read: `json`, the default, `text` or `bytes`. */
    responseType?: 'json' | 'text' | 'bytes';
    /**
     * fetch only: move the body into a staged file. The response then holds `blob` in place of `body`; one answered with
     * a status outside 2xx stages nothing and holds its body as a `Uint8Array`, whatever `responseType` says.
     */
    stage?: boolean;
  }
  /** A response of any status. `request` throws when the host refuses the request, when the source cannot be reached, and on a 429, as `RateLimited`. */
  export interface HttpResponse {
    /** The HTTP status. */
    status: number;
    /** Lowercase names. */
    headers: Record<string, string>;
    /** As `responseType` asked. */
    body?: Json | Uint8Array;
    /** With `stage`: the staged file's identifier, `blob:sha256:<hex>`. */
    blob?: string;
  }
  /**
   * Thrown when the source answers 429, and by every request after it until Retry-After has passed. Uncaught, the call
   * commits nothing and is called again after Retry-After. Caught, return `{ cursor, wait: retryAfterSeconds }`.
   */
  export class RateLimited extends Error {
    /** The whole seconds left of the source's Retry-After, at most 86,400: the `wait` to return. */
    readonly retryAfterSeconds: number;
  }

  /** fetch, openEvents and functions: HTTPS to the URLs the manifest's network entries allow, with the credential each declares attached. */
  export interface Http {
    /** Sends one request and answers its response, whatever its status. */
    request(options: HttpRequest): HttpResponse;
    /** A GET whose response body is JSON, typed as the caller states. It throws on a status outside 2xx. */
    get<T = Json>(url: string): T;
  }

  /** One entry of a folder `list` read. */
  export interface FileEntry { name: string; directory: boolean }
  /** A file's size in bytes, its modified instant, and whether it is a folder. */
  export interface FileStat { size: number; modified: string; directory: boolean }
  /** The granted folder, read-only. Every path is relative to it, with forward slashes. */
  export interface SourceFolder {
    /** A file's text, as UTF-8. */
    readText(path: string): string;
    /** A file's bytes. */
    readBytes(path: string): Uint8Array;
    /** Whether a file or folder is there. */
    exists(path: string): boolean;
    /** A file's size, modified instant and kind. */
    stat(path: string): FileStat;
    /** The entries of a folder; the granted folder itself when `path` is absent. */
    list(path?: string): FileEntry[];
    /** Copies one file of the folder into a staged file and returns its identifier. */
    stage(path: string): string;
  }

  /** The socket `openEvents` names: a URL a network entry allows, and headers beside the credential the host attaches. */
  export interface EventStream { url: string; headers?: Record<string, string> }
  /**
   * A pushed event, as CloudEvents 1.0 defines it. A webhook request whose body is not a CloudEvent arrives as type
   * `ai.repoql.webhook`, with the body, byte for byte, as base64 text in `data_base64`, and the headers the manifest
   * names as a JSON object, as text, in `repoqlheaders`. A folder change is type `ai.repoql.folder`, whose `subject`
   * is the changed path under the folder.
   */
  export interface CloudEvent { id: string; source: string; type: string; data?: Json; [attribute: string]: Json | undefined }
  /**
   * `keys`: the records to fetch, up to 1,000, each by its URI under an import's root, such as `tracker://acme/PAY-123`.
   * `pass`: ask for a pass of every import the event's partition serves instead. `reply`: the answer to the sender, sent in place of
   * a stream's declared acknowledgement, and only once the keys are stored.
   * `reconnect`: dial the stream again.
   */
  export interface EventOutcome { keys?: string[]; pass?: boolean; reconnect?: boolean; reply?: Json }

  /** What `complete` asks the model: the prompt, with context and a system prompt beside it. */
  export interface CompletionRequest { prompt: string; context?: string; system?: string; effort?: 'low' | 'balanced' | 'high'; maxTokens?: number }
  /** The model's answer to a completion. */
  export interface Completion { content: string; model: string; inputTokens: number; outputTokens: number }
  /** Words that describe a question or one of its criteria. */
  export type Description = string | Json[] | { [part: string]: Json };
  /** One question `decide` asks: a `choice` among named criteria, a `score` over ordered criteria, or a `noul`, answered as a number. */
  export type Question =
    | { type: 'choice'; instructions?: Description | null; criteria: Record<string, Description | null> }
    | { type: 'score'; instructions?: Description | null; criteria: (Description | null)[] }
    | { type: 'noul'; instructions?: Description | null; criteria?: { true?: Description | null; false?: Description | null } | null };
  /** The model's answer to one question, of the question's own type. */
  export type Answer =
    | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
    | { type: 'score'; score: number; confidence: number; probabilities: Record<string, number>; legend?: Record<string, Json> }
    | { type: 'noul'; noul: number };
  /** The model's answers to a `decide` request, by question name. */
  export interface Decision { model: string; answers: Record<string, Answer>; usage: { input_tokens: number; output_tokens: number } }
  /** What `decide` asks: the part of a record the questions are about, and the questions by name. */
  export interface DecisionRequest { state: Json; questions: Record<string, Question> }
  /** An answer, or `undefined` when the model cannot answer yet; the host records either per request. */
  export interface Llm {
    /** A completion of the prompt, or `undefined` when the model cannot answer yet. */
    complete(request: CompletionRequest): Completion | undefined;
    /** The answer to each question about `state`, or `undefined` when the model cannot answer yet. */
    decide(request: DecisionRequest): Decision | undefined;
  }

  /**
   * A concept render states: how to read a set of the import's files. `relevance` is the files it arrives with, as
   * patterns relative to the import's root; `invariant` is the one sentence that always holds.
   */
  export interface Concept {
    /** A CamelCase name, unique in the import. */
    name: string;
    /** `rule`: what always holds. `shape`: where things are and how they connect. `wisdom`: how to think about the records. */
    category: 'rule' | 'shape' | 'wisdom';
    /** One sentence that always holds. */
    invariant: string;
    /** Words an agent would search with. */
    tags: string[];
    /** The files it arrives with, as patterns relative to the import's root, such as `issues/**`. */
    relevance: string | string[];
    /** Why the invariant holds. */
    why?: string;
    /** A case that makes the invariant clear. */
    example?: string;
    /** Distinctions and boundaries, one a line. */
    depth?: string[];
  }
  /** A concept as `list` answers it. */
  export interface ConceptListed { name: string; category: 'rule' | 'shape' | 'wisdom'; invariant: string; tags: string[]; relevance: string[] }
  /** render only: the import's concepts. `set` with the value a concept already has changes nothing; `remove` answers whether one was there. */
  export interface Concepts { set(concept: Concept): void; remove(name: string): boolean; list(): ConceptListed[] }
  /** A term render states: what a word means in this import, the outside words that should find it, and the files it applies to, relative to the root. */
  export interface Term { term: string; meaning: string; aliases?: string[]; domain?: string; scope?: string | string[] }
  /** render only: the import's terms. `set` with the value a term already has changes nothing; `remove` answers whether one was there. */
  export interface Vocabulary { set(term: Term): void; remove(term: string, domain?: string): boolean; list(): Term[] }

  // ---- Writing what a source said ------------------------------------------------------------------------------------

  /**
   * The address a record is linked by, from an address as a source wrote it: `&amp;`, `&lt;` and `&gt;` read as the
   * characters they escape, the scheme and the host lowercased, and the parameters that only track a click dropped
   * (`utm_*`, `fbclid`, `gclid`, `dclid`, `gbraid`, `wbraid`, `msclkid`, `mc_cid`, `mc_eid`, `_hsenc`, `_hsmi`, `igshid`,
   * `yclid` and `ref_src`). Every other parameter stays, in its order, and so does the fragment. It never throws for
   * text that is not an address: such text comes back with only those changes. A connector that knows its own system's
   * canonical form, such as a pull request's page without its tab, applies that after this.
   */
  export function canonicalAddress(url: string): string;

  /** Outside text written into a Markdown file as data: text a source holds, such as a title, a message or a comment. */
  export const markdown: Markdown;

  /**
   * Each member writes text as data that cannot become the file's own structure. Every line ending a source may write
   * (CR, CRLF, U+2028, U+2029, NEL, VT and FF) becomes `\n`, and control characters but the tab are dropped. A mark
   * that would open a block at the start of a line is escaped: a heading, a quote, a list, a numbered or lettered list,
   * a thematic break, a setext underline, frontmatter, a fence, a table row, a link definition or a definition. An `@`
   * that could start a reference read assembles is doubled, as `@@`, which read shows as one `@`. A member throws a
   * TypeError for a value that is not a string.
   */
  export interface Markdown {
    /**
     * Lines of text, as paragraphs whose emphasis, code and links still show. `<` and `|` are escaped wherever they stand,
     * with any backslashes just before them, so the text holds no HTML and no table. Put a blank line before and after it.
     */
    text(value: string): string;
    /** Lines of text escaped as `text` escapes them, as a blockquote, every line `> `-prefixed. End it with a blank line, or the next line joins the quote. */
    quote(value: string): string;
    /**
     * Text on one line, for a heading, a list item, a link's words or a table cell. Whitespace runs become one space. These
     * are escaped wherever they stand: the backslash, `` ` ``, `*`, `[`, `]`, `<`, `>`, `|` and `~`. An `&` is escaped where
     * it starts an entity, and a `#` where it starts the text or could close a heading. A run of `_`, `^`, `++` or `==` is
     * escaped wherever the host's Markdown could take it to open or close emphasis, superscript, inserted or marked text,
     * by Markdig's own delimiter rule. So `gemini_flash`, `#12` and `R&D` read as written.
     */
    inline(value: string): string;
    /**
     * A link to `url` with `label` as its words, escaped as `inline` escapes them but for the marks that open a block, which
     * a link's words cannot, or the address when `label` is empty.
     * Only an `http` or `https` address is linked: for any other, or none, the words come back alone. A character
     * that could end the destination or break a table, such as whitespace, a parenthesis or a pipe, is percent-encoded.
     */
    link(label: string, url: string | null | undefined): string;
  }

  /**
   * Orders two instants, earlier first, as `sort` takes them: negative, 0 or positive. Each is ISO 8601 text with a date,
   * a time to the second, from 0 to 9 digits of a fraction, and `Z` or an offset, such as `2026-03-01T09:30:00.5Z`; or a
   * Date. Text with mixed fractions does not sort as text: `12:00:00Z` sorts after `12:00:00.5Z`. It throws a TypeError
   * for any other value, such as a date that does not exist.
   */
  export function compareInstants(a: string | Date, b: string | Date): number;

  /**
   * The bytes `value` takes in the import database: the UTF-8 bytes of its JSON, as `this.db.put` stores it, which is
   * what the manifest's `maxValueBytes` bounds. A string counts its quotes and escapes. It throws a TypeError for a
   * value JSON cannot hold, such as `undefined`. `put` refuses a value that holds half a character, a lone surrogate,
   * whatever its size.
   */
  export function utf8Size<T = Json>(value: T): number;
}
