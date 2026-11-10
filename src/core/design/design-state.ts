// The state folder of a design (PD-24, PD-27): link.json, the version records and the brief outbox. Core alone writes it,
// every write is atomic, and every read-modify-write runs under the folder's lock, which other processes honour too.
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as lockfile from 'proper-lockfile';
import { isSafeAgentPathId } from '../../shared/agent-path-id';
import type { DesignChange, DesignCheckIssue, DesignJourneyRecord, DesignResultDecision } from '../../shared/types/design';
import { renameWithRetry } from '../config/json-config-write';
import { log } from '../logger';

// The stale and wait settings of memory-outbox.ts: a holder that stops refreshing for 20 s is gone; waits run past that.
const LOCK_STALE_MS = 20_000;
const LOCK_UPDATE_MS = 2_000;
const LOCK_WAIT = { retries: 150, factor: 1.3, minTimeout: 5, maxTimeout: 250, randomize: true };

const LINK_FILE = 'link.json';
const VERSIONS_DIR = 'versions';
const BRIEFS_DIR = 'briefs';
const VERSION_FILE = /^v([1-9][0-9]{0,8})\.json$/;

/** `link.json`: which session is the current design chat; `designSessionId` null until a new chat claims it. */
export interface DesignLinkFile {
  readonly schemaVersion: 1;
  readonly designId: string;
  readonly folder: string;
  readonly title: string;
  readonly parentSessionId: string | null;
  readonly designSessionId: string | null;
  readonly superseded: readonly string[];
}

/** `versions/v<n>.json`, the outbox record of a finished version. */
export interface DesignVersionRecord {
  readonly schemaVersion: 1;
  readonly version: number;
  readonly designId: string;
  readonly title: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly contentHash: string;
  /** The current decisions at the finish. */
  readonly decisions: readonly DesignResultDecision[];
  /** Decisions the user approved while their conflict check could not run; absent when there were none. */
  readonly uncheckedDecisions?: readonly string[];
  readonly screens: readonly string[];
  /** Each screen's content hash by screen id, which the next version's `changedSinceLast` compares. */
  readonly screenHashes?: Readonly<Record<string, string>>;
  /**
   * Each screen's `renderInputHashes` entry by screen file, which DesignParity compares; absent from a record that predates it,
   * and without RENDER_HASH_SCHEME in one of an earlier formula, which DesignParity judges by `contentHash`.
   */
  readonly renderHashes?: Readonly<Record<string, string>>;
  readonly check: { readonly errors: 0; readonly warnings: readonly DesignCheckIssue[] };
  /** Each screen's journey or waiver (PD-21); empty for a static design and on REDUCED. */
  readonly journeys: readonly DesignJourneyRecord[];
  readonly summary: string;
  /** English, for a reader of the folder; a view's changes come from this record and the one before it (`changesFromPrevious`). */
  readonly changedSinceLast: readonly string[];
  readonly finishedAt: string;
}

/** Why a new design chat starts where it does: files an earlier chat left (PD-43), or a fork's inherited design (PD-37). */
export type DesignBriefContext = { readonly kind: 'takeover' } | { readonly kind: 'fork'; readonly folder: string };

/** `briefs/<briefId>.json`; `designSessionId` names the chat it is for, null for the new chat that has yet to claim it. */
export interface DesignBriefRecord {
  readonly schemaVersion: 1;
  readonly briefId: string;
  /** Write order within the state folder, assigned under its lock; briefs are delivered in this order. */
  readonly seq: number;
  readonly parentSessionId: string;
  readonly designSessionId: string | null;
  readonly text: string;
  readonly reopened: boolean;
  readonly context?: DesignBriefContext;
  readonly createdAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const missing = (err: unknown): boolean => (err as NodeJS.ErrnoException).code === 'ENOENT';

async function readJson(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (missing(err)) return undefined;
    throw err;
  }
  return JSON.parse(text) as unknown;
}

/** Writes `value` as JSON through a temporary file and a rename, so a reader never sees half a file. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    await renameWithRetry(temp, file);
  } catch (err) {
    await fs.rm(temp, { force: true });
    throw err;
  }
}

/** Writes `text` through a temporary file and a rename. */
export async function writeTextAtomic(file: string, text: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, text);
  try {
    await renameWithRetry(temp, file);
  } catch (err) {
    await fs.rm(temp, { force: true });
    throw err;
  }
}

/** Runs `body` holding the state folder's lock. */
export async function withDesignStateLock<T>(stateDir: string, body: () => Promise<T>): Promise<T> {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  let compromised: Error | undefined;
  const release = await lockfile.lock(stateDir, {
    realpath: false,
    stale: LOCK_STALE_MS,
    update: LOCK_UPDATE_MS,
    retries: LOCK_WAIT,
    onCompromised: (err) => {
      compromised = err;
    },
  });
  try {
    const result = await body();
    if (compromised) throw new Error(`The lock on ${stateDir} was lost while it was held: ${compromised.message}`);
    return result;
  } finally {
    if (!compromised) await release();
  }
}

const isSessionId = (value: unknown): value is string => typeof value === 'string' && isSafeAgentPathId(value);
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');

function linkFileOf(value: unknown): DesignLinkFile | undefined {
  if (!isRecord(value) || value['schemaVersion'] !== 1) return undefined;
  const { designId, folder, title, parentSessionId, designSessionId, superseded } = value;
  if (!isSessionId(designId) || typeof folder !== 'string' || typeof title !== 'string') return undefined;
  if (parentSessionId !== null && !isSessionId(parentSessionId)) return undefined;
  if (designSessionId !== null && !isSessionId(designSessionId)) return undefined;
  if (!isStringList(superseded)) return undefined;
  return { schemaVersion: 1, designId, folder, title, parentSessionId, designSessionId, superseded };
}

/** The design's `link.json`; undefined when there is none. Throws for one that does not parse, which nothing overwrites. */
export async function readDesignLink(stateDir: string): Promise<DesignLinkFile | undefined> {
  const value = await readJson(path.join(stateDir, LINK_FILE));
  if (value === undefined) return undefined;
  const link = linkFileOf(value);
  if (!link) throw new Error(`${path.join(stateDir, LINK_FILE)} is not a design link`);
  return link;
}

/** Replaces `link.json` with what `change` makes of it, under the lock. */
export function updateDesignLink(stateDir: string, change: (current: DesignLinkFile | undefined) => DesignLinkFile): Promise<DesignLinkFile> {
  return withDesignStateLock(stateDir, async () => {
    const next = change(await readDesignLink(stateDir));
    await writeJsonAtomic(path.join(stateDir, LINK_FILE), next);
    return next;
  });
}

/**
 * The design chat `sessionId` takes the link (a new chat, or a takeover, PD-43): the chat it replaces becomes superseded,
 * and the briefs no chat claimed yet become its own.
 */
export function claimDesignLink(stateDir: string, sessionId: string, base: Omit<DesignLinkFile, 'designSessionId' | 'superseded' | 'schemaVersion'>): Promise<DesignLinkFile> {
  return withDesignStateLock(stateDir, async () => {
    const current = await readDesignLink(stateDir);
    const previous = current?.designSessionId;
    const superseded = [...(current?.superseded ?? [])];
    if (previous && previous !== sessionId && !superseded.includes(previous)) superseded.push(previous);
    const next: DesignLinkFile = { schemaVersion: 1, ...base, designSessionId: sessionId, superseded };
    await writeJsonAtomic(path.join(stateDir, LINK_FILE), next);
    for (const brief of await readBriefRecords(stateDir)) {
      if (brief.designSessionId === null) await writeJsonAtomic(briefFile(stateDir, brief.briefId), { ...brief, designSessionId: sessionId });
    }
    return next;
  });
}

/**
 * A rewind takeover (PD-36): design chat `sessionId` takes the link from `from`, which must hold it now and joins `superseded`.
 * The briefs addressed to `from` that its branch never delivered (`deliveredToFrom` lacks them) become the new chat's; the
 * ones it delivered stay its own, so the new branch keeps exactly the briefs it inherited. The link is written first, so a
 * failure after it leaves `from` superseded and never two chats current.
 */
export function takeOverDesignLink(stateDir: string, from: string, sessionId: string, deliveredToFrom: ReadonlySet<string>): Promise<DesignLinkFile> {
  return withDesignStateLock(stateDir, async () => {
    const current = await readDesignLink(stateDir);
    if (!current || current.designSessionId !== from) throw new Error(`design chat ${from} no longer holds the design ${path.basename(stateDir)}`);
    const next: DesignLinkFile = { ...current, designSessionId: sessionId, superseded: current.superseded.includes(from) ? current.superseded : [...current.superseded, from] };
    await writeJsonAtomic(path.join(stateDir, LINK_FILE), next);
    for (const brief of await readBriefRecords(stateDir)) {
      if ((brief.designSessionId === from || brief.designSessionId === null) && !deliveredToFrom.has(brief.briefId)) {
        await writeJsonAtomic(briefFile(stateDir, brief.briefId), { ...brief, designSessionId: sessionId });
      }
    }
    return next;
  });
}

/**
 * A main chat's conversation rewind carries its design (D70): main chat `sessionId` becomes the design's parent in place of
 * `from`, which must be its parent now. The caller writes it last, once the new chat's branched file holds its own link entry.
 */
export function takeOverDesignParent(stateDir: string, from: string, sessionId: string): Promise<DesignLinkFile> {
  return withDesignStateLock(stateDir, async () => {
    const current = await readDesignLink(stateDir);
    if (!current || current.parentSessionId !== from) throw new Error(`chat ${from} is no longer the main chat of the design ${path.basename(stateDir)}`);
    const next: DesignLinkFile = { ...current, parentSessionId: sessionId };
    await writeJsonAtomic(path.join(stateDir, LINK_FILE), next);
    return next;
  });
}

/** A design fork's new state folder (PD-36): its link names fork `sessionId` and no parent. Refuses a design that has a link already. */
export function createForkDesignLink(stateDir: string, sessionId: string, base: Pick<DesignLinkFile, 'designId' | 'folder' | 'title'>): Promise<DesignLinkFile> {
  return withDesignStateLock(stateDir, async () => {
    if (await readDesignLink(stateDir)) throw new Error(`the design ${base.designId} already has a link`);
    const link: DesignLinkFile = { schemaVersion: 1, ...base, parentSessionId: null, designSessionId: sessionId, superseded: [] };
    await writeJsonAtomic(path.join(stateDir, LINK_FILE), link);
    return link;
  });
}

function briefFile(stateDir: string, briefId: string): string {
  if (!isSafeAgentPathId(briefId)) throw new Error(`Not a brief id: ${JSON.stringify(briefId)}`);
  return path.join(stateDir, BRIEFS_DIR, `${briefId}.json`);
}

function briefRecordOf(value: unknown): DesignBriefRecord | undefined {
  if (!isRecord(value) || value['schemaVersion'] !== 1) return undefined;
  const { briefId, seq, parentSessionId, designSessionId, text, reopened, createdAt } = value;
  if (!isSessionId(briefId) || !Number.isSafeInteger(seq) || (seq as number) < 1 || !isSessionId(parentSessionId)) return undefined;
  if (designSessionId !== null && !isSessionId(designSessionId)) return undefined;
  if (typeof text !== 'string' || typeof reopened !== 'boolean' || typeof createdAt !== 'string') return undefined;
  const context = briefContextOf(value['context']);
  if (context === null) return undefined;
  return { schemaVersion: 1, briefId, seq: seq as number, parentSessionId, designSessionId, text, reopened, ...(context ? { context } : {}), createdAt };
}

// undefined: none; null: not a context.
function briefContextOf(value: unknown): DesignBriefContext | undefined | null {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  if (value['kind'] === 'takeover') return { kind: 'takeover' };
  if (value['kind'] === 'fork' && typeof value['folder'] === 'string') return { kind: 'fork', folder: value['folder'] };
  return null;
}

type NewBrief = Omit<DesignBriefRecord, 'schemaVersion' | 'briefId' | 'seq' | 'createdAt'>;

// The caller holds the state folder's lock, so no other writer takes the same seq.
async function writeNewBrief(stateDir: string, brief: NewBrief): Promise<DesignBriefRecord> {
  const seq = (await readBriefRecords(stateDir)).reduce((max, record) => Math.max(max, record.seq), 0) + 1;
  const record: DesignBriefRecord = { schemaVersion: 1, briefId: `b${seq}-${randomUUID().slice(0, 8)}`, seq, createdAt: new Date().toISOString(), ...brief };
  await writeJsonAtomic(briefFile(stateDir, record.briefId), record);
  return record;
}

/** Writes a brief's outbox record before anything delivers it. */
export function writeBriefRecord(stateDir: string, brief: NewBrief): Promise<DesignBriefRecord> {
  return withDesignStateLock(stateDir, () => writeNewBrief(stateDir, brief));
}

/**
 * Writes a brief addressed to the design chat `link.json` names, read under the lock a takeover writes it under, so a brief is
 * never addressed to a chat a takeover just superseded (PD-36). Undefined, writing nothing, when no chat holds the link.
 */
export function writeBriefToCurrentChat(stateDir: string, brief: Omit<NewBrief, 'designSessionId'>): Promise<DesignBriefRecord | undefined> {
  return withDesignStateLock(stateDir, async () => {
    const designSessionId = (await readDesignLink(stateDir))?.designSessionId ?? null;
    if (designSessionId === null) return undefined;
    return writeNewBrief(stateDir, { ...brief, designSessionId });
  });
}

/** Every brief record, oldest first; a file that is not JSON (logged) or not a brief record is skipped. */
export async function readBriefRecords(stateDir: string): Promise<DesignBriefRecord[]> {
  let names: string[];
  try {
    names = await fs.readdir(path.join(stateDir, BRIEFS_DIR));
  } catch (err) {
    if (missing(err)) return [];
    throw err;
  }
  const records: DesignBriefRecord[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(stateDir, BRIEFS_DIR, name);
    let value: unknown;
    try {
      value = await readJson(file);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      log('[design-state] skipping the brief %s, which is not JSON: %s', file, err.message);
      continue;
    }
    const record = briefRecordOf(value);
    if (record) records.push(record);
  }
  return records.sort((a, b) => a.seq - b.seq);
}

function versionRecordOf(value: unknown): DesignVersionRecord | undefined {
  if (!isRecord(value) || value['schemaVersion'] !== 1) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v['version'] !== 'number' || !Number.isInteger(v['version']) || v['version'] < 1) return undefined;
  if (!isSessionId(v['designId']) || typeof v['title'] !== 'string' || typeof v['sessionId'] !== 'string' || typeof v['toolCallId'] !== 'string') return undefined;
  if (typeof v['contentHash'] !== 'string' || typeof v['summary'] !== 'string' || typeof v['finishedAt'] !== 'string') return undefined;
  if (!Array.isArray(v['decisions']) || !isStringList(v['screens']) || !Array.isArray(v['journeys']) || !isStringList(v['changedSinceLast'])) return undefined;
  const check = v['check'];
  if (!isRecord(check) || check['errors'] !== 0 || !Array.isArray(check['warnings'])) return undefined;
  return value as unknown as DesignVersionRecord;
}

/** The highest version number recorded, 0 when none is. */
async function latestVersionNumber(stateDir: string): Promise<number> {
  let names: string[];
  try {
    names = await fs.readdir(path.join(stateDir, VERSIONS_DIR));
  } catch (err) {
    if (missing(err)) return 0;
    throw err;
  }
  let latest = 0;
  for (const name of names) {
    const match = VERSION_FILE.exec(name);
    if (match) latest = Math.max(latest, Number(match[1]));
  }
  return latest;
}

/** The version record `version`; throws for one that is missing or does not parse. */
export async function readVersionRecord(stateDir: string, version: number): Promise<DesignVersionRecord> {
  const file = path.join(stateDir, VERSIONS_DIR, `v${version}.json`);
  const record = versionRecordOf(await readJson(file));
  if (!record || record.version !== version) throw new Error(`${file} is not a design version record`);
  return record;
}

/** The latest finished version, undefined before the first. */
export async function readLatestVersion(stateDir: string): Promise<DesignVersionRecord | undefined> {
  const latest = await latestVersionNumber(stateDir);
  return latest === 0 ? undefined : readVersionRecord(stateDir, latest);
}

/** What changed since `previous`: screens added, removed or edited, and decisions added; nothing for the first version. */
export function changesSince(
  previous: Pick<DesignVersionRecord, 'screenHashes' | 'decisions'> | undefined,
  screenHashes: Readonly<Record<string, string>>,
  decisions: readonly DesignResultDecision[],
): DesignChange[] {
  if (!previous) return [];
  const changes: DesignChange[] = [];
  const before = previous.screenHashes ?? {};
  for (const [screen, hash] of Object.entries(screenHashes)) {
    if (before[screen] === undefined) changes.push({ kind: 'screenAdded', screen });
    else if (before[screen] !== hash) changes.push({ kind: 'screenChanged', screen });
  }
  for (const screen of Object.keys(before)) if (screenHashes[screen] === undefined) changes.push({ kind: 'screenRemoved', screen });
  const earlier = new Set(previous.decisions.map((decision) => decision.id));
  for (const { id, title, chosen, replaces } of decisions) {
    if (!earlier.has(id)) changes.push({ kind: 'decisionAdded', id, title, chosen, ...(replaces?.length ? { replaces: [...replaces] } : {}) });
  }
  return changes;
}

/** The changes as the model reads them, one line each. */
export function describeChanges(changes: readonly DesignChange[]): string[] {
  return changes.map((change) => {
    switch (change.kind) {
      case 'screenAdded': return `${change.screen} added`;
      case 'screenChanged': return `${change.screen} changed`;
      case 'screenRemoved': return `${change.screen} removed`;
      case 'decisionAdded': return `${change.id} ${change.title} · ${change.chosen}${change.replaces?.length ? ` (replaces ${change.replaces.join(', ')})` : ''}`;
    }
  });
}

/** What changed from version `fromVersion` (0: before the first) to version `toVersion`, read from their records. */
export async function changesBetween(stateDir: string, fromVersion: number, toVersion: number): Promise<DesignChange[]> {
  const to = await readVersionRecord(stateDir, toVersion);
  const from = fromVersion > 0 ? await readVersionRecord(stateDir, fromVersion) : { screenHashes: {}, decisions: [] };
  return changesSince(from, to.screenHashes ?? {}, to.decisions);
}

/** What changed in `record` since the version before it, read from both records; nothing for the first or an unreadable one. */
export async function changesFromPrevious(stateDir: string, record: DesignVersionRecord): Promise<DesignChange[]> {
  if (record.version <= 1) return [];
  try {
    return changesSince(await readVersionRecord(stateDir, record.version - 1), record.screenHashes ?? {}, record.decisions);
  } catch (err) {
    log('[design-state] the changes in v%d are unknown: %s', record.version, err instanceof Error ? err.message : String(err));
    return [];
  }
}

const sameReplaces = (a: readonly string[] | undefined, b: readonly string[] | undefined): boolean => (a ?? []).join(' ') === (b ?? []).join(' ');

// Both lists hold current decisions only, so a replacement changes them (D66).
const sameDecisions = (a: readonly DesignResultDecision[], b: readonly DesignResultDecision[]): boolean =>
  a.length === b.length && a.every((decision, i) => decision.id === b[i]!.id && decision.title === b[i]!.title && decision.chosen === b[i]!.chosen && sameReplaces(decision.replaces, b[i]!.replaces));

/** Why a design chat that is not the current one cannot finish its design. */
export const DESIGN_SUPERSEDED_FINISH = 'This design continues in another design chat, so this one cannot finish it.';

/** Why an approved version was not made: the folder or its versions moved while the user decided. */
export const DESIGN_MOVED_FINISH = 'The design changed while it waited for approval (its files were edited, or another version was made), so no version was made. Check it again and call FinishDesign again.';

/** The design chat that may stamp a version: the one `link.json` names, while its `stillCurrent` holds (PD-36). */
export interface DesignWriter {
  readonly sessionId: string;
  readonly stillCurrent: () => boolean;
}

/** What FinishDesign would stamp now: the latest version again, or the version after `previous` (undefined: the first). */
export type DesignVersionProbe =
  | { readonly kind: 'reuse'; readonly record: DesignVersionRecord }
  | { readonly kind: 'new'; readonly previous: DesignVersionRecord | undefined; readonly contentHash: string };

/** The latest record, read under the lock after link.json, else the refusal of a chat that is not `chat`. */
async function writableLatest(stateDir: string, chat: DesignWriter): Promise<DesignVersionRecord | undefined> {
  // Read under the lock a takeover writes link.json under.
  const link = await readDesignLink(stateDir);
  const latest = await latestVersionNumber(stateDir);
  const previous = latest === 0 ? undefined : await readVersionRecord(stateDir, latest);
  // After the last read, so a takeover the chat began meanwhile is seen too.
  if ((link?.designSessionId && link.designSessionId !== chat.sessionId) || !chat.stillCurrent()) throw new Error(DESIGN_SUPERSEDED_FINISH);
  return previous;
}

/**
 * Whether FinishDesign would stamp a new version (PD-24): the latest one again when the folder's content and the decisions are
 * unchanged, else a new one after it. Writes nothing; only the design chat `chat` gets an answer, so a superseded chat neither
 * stamps nor offers a version.
 */
export function probeDesignVersion(
  stateDir: string,
  chat: DesignWriter,
  contentHash: string,
  decisions: readonly DesignResultDecision[],
): Promise<DesignVersionProbe> {
  return withDesignStateLock(stateDir, async () => {
    const previous = await writableLatest(stateDir, chat);
    // whatever scheme its render hashes have, or none: DesignParity judges such a record by this same content hash
    if (previous && previous.contentHash === contentHash && sameDecisions(previous.decisions, decisions)) return { kind: 'reuse', record: previous };
    return { kind: 'new', previous, contentHash };
  });
}

/**
 * Stamps the new version `probe` found, numbered after it and written under the lock so two finishes never share one. Refuses,
 * writing nothing, when `chat` is no longer the design chat or when another version or `currentContentHash` moved since the probe.
 */
export function commitDesignVersion(
  stateDir: string,
  chat: DesignWriter,
  probe: Extract<DesignVersionProbe, { kind: 'new' }>,
  currentContentHash: () => Promise<string>,
  build: (version: number, previous: DesignVersionRecord | undefined) => DesignVersionRecord,
): Promise<DesignVersionRecord> {
  return withDesignStateLock(stateDir, async () => {
    const latest = await writableLatest(stateDir, chat);
    if (latest?.version !== probe.previous?.version || (await currentContentHash()) !== probe.contentHash) throw new Error(DESIGN_MOVED_FINISH);
    if (!chat.stillCurrent()) throw new Error(DESIGN_SUPERSEDED_FINISH);
    const record = build((latest?.version ?? 0) + 1, latest);
    await writeJsonAtomic(path.join(stateDir, VERSIONS_DIR, `v${record.version}.json`), record);
    return record;
  });
}
