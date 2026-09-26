/**
 * agent-records.ts — On-disk layout, custom entry payloads and readers for subagent and team-member
 * pi session files, plus the parent-session invocation index that points at them.
 *
 * Layout under `<piSessionDir>/<parentSessionId>/`:
 *   subagents/<ts>_<agentId>.jsonl                           pi session per subagent
 *   teams/<teamId>.jsonl                                     team event log
 *   teams/<teamId>/members/<ts>_<memberId>.a<attempt>.jsonl  pi session per member attempt
 *   teams/<teamId>/checkpoints/<cancelledAt>.json            team resume checkpoint, one per cancel
 *
 * Everything read back from disk is untrusted and validated here before use.
 */

import { createReadStream } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { initPiLoader, type PiCodingAgentModule } from './pi-loader';
import { log } from '../logger';
import {
  DAMOCLES_AGENT_INVOCATION_ENTRY,
  DAMOCLES_AGENT_LAUNCH_ENTRY,
  DAMOCLES_AGENT_SEGMENT_ENTRY,
  DAMOCLES_AGENT_STATUS_ENTRY,
} from './session-store/constants';
import { SUBAGENT_RESULTS_CUSTOM_TYPE } from './subagents/background-results';
import { TOOL_AGENT } from '../../shared/tool-names';
import type { AgentRecord } from './subagents/types';
import { addAgentUsage, agentUsageOf, emptyAgentUsage, usageOfEntry, type AgentUsageTotals } from '../../shared/usage-accounting';

// ---- layout ----------------------------------------------------------------

/** pi's session id rule (`assertValidSessionId`); also keeps every id a single safe path segment. */
const SAFE_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function isSafeAgentPathId(id: string): boolean {
  return SAFE_ID.test(id);
}

function assertSafeId(label: string, id: string): void {
  if (!SAFE_ID.test(id)) throw new Error(`Invalid ${label} "${id}"`);
}

/** The parent session's agent-data root. `sessionDir` is the workspace pi session dir. */
export function agentDataRoot(sessionDir: string, parentSessionId: string): string {
  assertSafeId('parent session id', parentSessionId);
  return join(sessionDir, parentSessionId);
}

export function subagentsDir(sessionDir: string, parentSessionId: string): string {
  return join(agentDataRoot(sessionDir, parentSessionId), 'subagents');
}

export function teamsDir(sessionDir: string, parentSessionId: string): string {
  return join(agentDataRoot(sessionDir, parentSessionId), 'teams');
}

export function teamEventLogPath(sessionDir: string, parentSessionId: string, teamId: string): string {
  assertSafeId('team id', teamId);
  return join(teamsDir(sessionDir, parentSessionId), `${teamId}.jsonl`);
}

export function teamCheckpointsDir(sessionDir: string, parentSessionId: string, teamId: string): string {
  assertSafeId('team id', teamId);
  return join(teamsDir(sessionDir, parentSessionId), teamId, 'checkpoints');
}

const CHECKPOINT_FILE = /^(\d+)\.json$/;

/** One checkpoint per cancel, named by its cancel time in epoch ms. */
export function teamCheckpointPath(sessionDir: string, parentSessionId: string, teamId: string, cancelledAt: number): string {
  if (!Number.isSafeInteger(cancelledAt) || cancelledAt < 0) throw new Error(`Invalid checkpoint time ${cancelledAt}`);
  return join(teamCheckpointsDir(sessionDir, parentSessionId, teamId), `${cancelledAt}.json`);
}

/** The cancel times of the checkpoints in `dir`, oldest first; none when the folder does not exist. */
export async function listTeamCheckpoints(dir: string): Promise<number[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const times: number[] = [];
  for (const name of names) {
    const match = CHECKPOINT_FILE.exec(name);
    const ms = match ? Number(match[1]) : NaN;
    if (Number.isSafeInteger(ms)) times.push(ms);
  }
  return times.sort((a, b) => a - b);
}

export function teamMembersDir(sessionDir: string, parentSessionId: string, teamId: string): string {
  assertSafeId('team id', teamId);
  return join(teamsDir(sessionDir, parentSessionId), teamId, 'members');
}

/** The pi session id for one member attempt; `SessionManager.create` names the file after it. */
export function teamMemberSessionId(memberId: string, attempt: number): string {
  const id = `${memberId}.a${attempt}`;
  assertSafeId('member session id', id);
  return id;
}

// ---- payloads ----------------------------------------------------------------

export type AgentStopReason = 'user' | 'budget' | 'shutdown' | 'reset';
export type AgentTerminalStatus = Exclude<AgentRecord['status'], 'queued' | 'running'>;

const STOP_REASONS: ReadonlySet<string> = new Set<AgentStopReason>(['user', 'budget', 'shutdown', 'reset']);
const TERMINAL_STATUSES: ReadonlySet<string> = new Set<AgentTerminalStatus>(['completed', 'steered', 'aborted', 'stopped', 'error']);
const THINKING_LEVELS: ReadonlySet<string> = new Set<ThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export function isAgentTerminalStatus(value: unknown): value is AgentTerminalStatus {
  return typeof value === 'string' && TERMINAL_STATUSES.has(value);
}

/** The status of a record whose run has ended: one still queued or running by then was stopped. */
export function terminalAgentStatus(status: AgentRecord['status']): AgentTerminalStatus {
  return status === 'queued' || status === 'running' ? 'stopped' : status;
}

/** Parent session: one per `Agent` spawn or resume, `create_team` or `resume_team`. */
export interface AgentInvocationData {
  kind: 'subagent' | 'team';
  id: string;
  toolCallId: string;
  resume: boolean;
}

export interface SubagentLaunchData {
  agentId: string;
  kind: 'subagent';
  agentType: string;
  description: string;
  prompt: string;
  background: boolean;
  thinkingOverride?: ThinkingLevel;
  templatePath?: string;
  /** Short model label shown on the card, when the spawn resolved one. */
  modelLabel?: string;
  /** Whether the model bills real dollars. Absent in records written before the flag existed. */
  dollarBilled?: boolean;
}

export interface TeamMemberLaunchData {
  agentId: string;
  kind: 'team-member';
  teamId: string;
  attempt: number;
  memberName: string;
  role: string;
  task: string;
}

export type AgentLaunchData = SubagentLaunchData | TeamMemberLaunchData;

export interface AgentSegmentData {
  toolCallId: string;
  message?: string;
  /** Whether the resumed run's model bills real dollars. Absent in records written before the flag existed. */
  dollarBilled?: boolean;
}

export interface AgentStatusData {
  status: AgentTerminalStatus;
  stopReason?: AgentStopReason;
  result: string;
}

/** `details` of the parent's `Agent` tool result. `async_launched` is the background acknowledgement. */
export interface AgentToolDetails {
  agentId: string;
  status: AgentTerminalStatus | 'async_launched';
  stopReason?: AgentStopReason;
}

/** One agent in the keep-alive injection's `details`. */
export interface InjectedAgentResult {
  agentId: string;
  toolCallId: string;
  status: AgentTerminalStatus;
  stopReason?: AgentStopReason;
  result: string;
}

export interface SubagentResultsDetails {
  agents: InjectedAgentResult[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isOptional(value: unknown, check: (v: unknown) => boolean): boolean {
  return value === undefined || check(value);
}

const isString = (v: unknown): boolean => typeof v === 'string';
const isStopReason = (v: unknown): boolean => typeof v === 'string' && STOP_REASONS.has(v);

export function isAgentInvocationData(value: unknown): value is AgentInvocationData {
  return (
    isRecord(value) &&
    (value['kind'] === 'subagent' || value['kind'] === 'team') &&
    isNonEmptyString(value['id']) &&
    isSafeAgentPathId(value['id']) &&
    isNonEmptyString(value['toolCallId']) &&
    typeof value['resume'] === 'boolean'
  );
}

export function isAgentLaunchData(value: unknown): value is AgentLaunchData {
  if (!isRecord(value) || !isNonEmptyString(value['agentId'])) return false;
  if (value['kind'] === 'subagent') {
    return (
      isNonEmptyString(value['agentType']) &&
      isString(value['description']) &&
      isString(value['prompt']) &&
      typeof value['background'] === 'boolean' &&
      isOptional(value['thinkingOverride'], (v) => typeof v === 'string' && THINKING_LEVELS.has(v)) &&
      isOptional(value['templatePath'], isString) &&
      isOptional(value['modelLabel'], isString) &&
      isOptional(value['dollarBilled'], (v) => typeof v === 'boolean')
    );
  }
  if (value['kind'] === 'team-member') {
    return (
      isNonEmptyString(value['teamId']) &&
      Number.isInteger(value['attempt']) &&
      isString(value['memberName']) &&
      isString(value['role']) &&
      isString(value['task'])
    );
  }
  return false;
}

export function isAgentSegmentData(value: unknown): value is AgentSegmentData {
  return (
    isRecord(value) &&
    isNonEmptyString(value['toolCallId']) &&
    isOptional(value['message'], isString) &&
    isOptional(value['dollarBilled'], (v) => typeof v === 'boolean')
  );
}

export function isAgentStatusData(value: unknown): value is AgentStatusData {
  return (
    isRecord(value) &&
    isAgentTerminalStatus(value['status']) &&
    isOptional(value['stopReason'], isStopReason) &&
    isString(value['result'])
  );
}

export function isAgentToolDetails(value: unknown): value is AgentToolDetails {
  return (
    isRecord(value) &&
    isNonEmptyString(value['agentId']) &&
    (value['status'] === 'async_launched' || isAgentTerminalStatus(value['status'])) &&
    isOptional(value['stopReason'], isStopReason)
  );
}

function isInjectedAgentResult(value: unknown): value is InjectedAgentResult {
  return (
    isRecord(value) &&
    isNonEmptyString(value['agentId']) &&
    isNonEmptyString(value['toolCallId']) &&
    isAgentTerminalStatus(value['status']) &&
    isOptional(value['stopReason'], isStopReason) &&
    isString(value['result'])
  );
}

// ---- parent-branch readers -----------------------------------------------------

/** The invocation entries on a parent branch, in branch order. */
export function agentInvocationsOnBranch(branch: readonly SessionEntry[]): AgentInvocationData[] {
  const out: AgentInvocationData[] = [];
  for (const entry of branch) {
    if (entry.type !== 'custom' || entry.customType !== DAMOCLES_AGENT_INVOCATION_ENTRY) continue;
    if (isAgentInvocationData(entry.data)) out.push(entry.data);
  }
  return out;
}

/** `details` of every `Agent` tool result on a parent branch, keyed by tool call id. */
export function agentToolDetailsOnBranch(branch: readonly SessionEntry[]): Map<string, AgentToolDetails> {
  const out = new Map<string, AgentToolDetails>();
  for (const entry of branch) {
    if (entry.type !== 'message') continue;
    const message: unknown = entry.message;
    if (!isRecord(message) || message['role'] !== 'toolResult' || message['toolName'] !== TOOL_AGENT) continue;
    const toolCallId = message['toolCallId'];
    if (typeof toolCallId === 'string' && isAgentToolDetails(message['details'])) out.set(toolCallId, message['details']);
  }
  return out;
}

/** The arguments the parent's assistant passed to tool call `toolCallId`, or undefined when absent. */
export function toolCallArgumentsOnBranch(branch: readonly SessionEntry[], toolCallId: string): Record<string, unknown> | undefined {
  for (const entry of branch) {
    if (entry.type !== 'message') continue;
    const message: unknown = entry.message;
    if (!isRecord(message) || message['role'] !== 'assistant' || !Array.isArray(message['content'])) continue;
    for (const block of message['content']) {
      if (isRecord(block) && block['type'] === 'toolCall' && block['id'] === toolCallId) {
        return isRecord(block['arguments']) ? block['arguments'] : undefined;
      }
    }
  }
  return undefined;
}

/** The team a `create_team` or `resume_team` call on this branch invoked, or null. */
export function teamIdForToolCall(branch: readonly SessionEntry[], toolCallId: string): string | null {
  return agentInvocationsOnBranch(branch).find((inv) => inv.kind === 'team' && inv.toolCallId === toolCallId)?.id ?? null;
}

/** Background results injected on a parent branch, keyed by the invoking tool call id (latest wins). */
export function injectedAgentResultsOnBranch(branch: readonly SessionEntry[]): Map<string, InjectedAgentResult> {
  const out = new Map<string, InjectedAgentResult>();
  for (const entry of branch) {
    if (entry.type !== 'custom_message' || entry.customType !== SUBAGENT_RESULTS_CUSTOM_TYPE) continue;
    const details: unknown = entry.details;
    if (!isRecord(details) || !Array.isArray(details['agents'])) continue;
    for (const agent of details['agents']) {
      if (isInjectedAgentResult(agent)) out.set(agent.toolCallId, agent);
    }
  }
  return out;
}

// ---- agent-file readers ----------------------------------------------------------

/** A persisted pi message; only `role` is checked, consumers read the rest defensively. */
export type PersistedAgentMessage = Record<string, unknown> & { role: string };

/** The messages between one launch or resume and the next. `toolCallId` is null for the launch. */
export interface AgentFileSegment {
  toolCallId: string | null;
  message?: string;
  /** The resume segment's billing flag; the launch segment's is the launch entry's. */
  dollarBilled?: boolean;
  messages: PersistedAgentMessage[];
  /** Every billed entry of the segment, compaction and cache warms included, by pi's session-total rule. */
  usage: AgentUsageTotals;
  status?: AgentStatusData;
  startTimestamp?: number;
  endTimestamp?: number;
}

export interface AgentFile {
  path: string;
  launch: AgentLaunchData;
  segments: AgentFileSegment[];
  /** The latest segment's status. */
  status?: AgentStatusData;
  messages: PersistedAgentMessage[];
  /** Each message's pi session entry id. Unique within this file only. */
  entryIds: ReadonlyMap<PersistedAgentMessage, string>;
}

async function requirePi(): Promise<PiCodingAgentModule> {
  const pi = await initPiLoader();
  if (!pi) throw new Error('The pi runtime is unavailable, so agent records cannot be read.');
  return pi;
}

function isPersistedMessage(value: unknown): value is PersistedAgentMessage {
  return isRecord(value) && typeof value['role'] === 'string';
}

function entryTimestamp(entry: Record<string, unknown>): number | undefined {
  const raw = entry['timestamp'];
  if (typeof raw !== 'string') return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Split parsed agent-file entries into segments. Returns null when there is no valid launch entry. */
export function parseAgentEntries(path: string, entries: readonly unknown[]): AgentFile | null {
  let launch: AgentLaunchData | undefined;
  const segments: AgentFileSegment[] = [];
  let current: AgentFileSegment | undefined;
  const entryIds = new Map<PersistedAgentMessage, string>();
  // Agent sessions never branch, so file order is the branch.
  for (const entry of entries) {
    if (!isRecord(entry) || entry['type'] === 'session') continue;
    const ts = entryTimestamp(entry);
    if (entry['type'] === 'custom') {
      const data = entry['data'];
      if (entry['customType'] === DAMOCLES_AGENT_LAUNCH_ENTRY && !launch && isAgentLaunchData(data)) {
        launch = data;
        current = { toolCallId: null, messages: [], usage: emptyAgentUsage() };
        segments.push(current);
      } else if (entry['customType'] === DAMOCLES_AGENT_SEGMENT_ENTRY && current && isAgentSegmentData(data)) {
        current = {
          toolCallId: data.toolCallId,
          ...(data.message !== undefined ? { message: data.message } : {}),
          ...(data.dollarBilled !== undefined ? { dollarBilled: data.dollarBilled } : {}),
          messages: [],
          usage: emptyAgentUsage(),
        };
        segments.push(current);
      } else if (entry['customType'] === DAMOCLES_AGENT_STATUS_ENTRY && current && isAgentStatusData(data)) {
        current.status = data;
      }
    } else if (entry['type'] === 'message' && current && isPersistedMessage(entry['message'])) {
      current.messages.push(entry['message']);
      if (typeof entry['id'] === 'string') entryIds.set(entry['message'], entry['id']);
    }
    if (!current) continue;
    const billed = usageOfEntry(entry);
    if (billed) current.usage = addAgentUsage(current.usage, agentUsageOf(billed));
    if (ts !== undefined) {
      if (current.startTimestamp === undefined || ts < current.startTimestamp) current.startTimestamp = ts;
      if (current.endTimestamp === undefined || ts > current.endTimestamp) current.endTimestamp = ts;
    }
  }
  if (!launch) return null;
  const last = segments.at(-1);
  return {
    path,
    launch,
    segments,
    ...(last?.status ? { status: last.status } : {}),
    messages: segments.flatMap((s) => s.messages),
    entryIds,
  };
}

/** Read one agent pi session file. Null when it carries no valid launch entry. */
export async function readAgentFile(path: string): Promise<AgentFile | null> {
  const pi = await requirePi();
  const content = await readFile(path, 'utf8');
  return parseAgentEntries(path, pi.parseSessionEntries(content));
}

/** The segment an invocation rendered: the launch segment, or the resume segment it opened. */
export function segmentForInvocation(file: AgentFile, invocation: Pick<AgentInvocationData, 'toolCallId' | 'resume'>): AgentFileSegment | undefined {
  return invocation.resume ? file.segments.find((s) => s.toolCallId === invocation.toolCallId) : file.segments[0];
}

/** Read a file only up to its launch entry, which pi writes before the agent's first response. */
async function readLaunchEntry(pi: PiCodingAgentModule, path: string): Promise<AgentLaunchData | null> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      for (const entry of pi.parseSessionEntries(line)) {
        const e = entry as unknown;
        if (!isRecord(e)) continue;
        if (e['type'] === 'custom' && e['customType'] === DAMOCLES_AGENT_LAUNCH_ENTRY) {
          return isAgentLaunchData(e['data']) ? e['data'] : null;
        }
        if (e['type'] === 'message' && isRecord(e['message']) && e['message']['role'] === 'assistant') return null;
      }
    }
    return null;
  } finally {
    lines.close();
    stream.destroy();
  }
}

async function listJsonl(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** A file that cannot be read or holds no valid launch entry is logged and reads as null, so one bad
 *  file never hides the others in its folder. */
async function readLaunchEntryOrSkip(pi: PiCodingAgentModule, path: string): Promise<AgentLaunchData | null> {
  let launch: AgentLaunchData | null;
  try {
    launch = await readLaunchEntry(pi, path);
  } catch (err) {
    log('[agent-records] skipping agent file %s: reading it failed: %O', path, err);
    return null;
  }
  if (!launch) log('[agent-records] skipping agent file %s: it holds no valid launch entry', path);
  return launch;
}

/** Map every agent file in `dir` to its launch `agentId`. A missing dir is empty. */
export async function indexAgentFiles(dir: string): Promise<Map<string, string>> {
  const pi = await requirePi();
  const out = new Map<string, string>();
  for (const name of await listJsonl(dir)) {
    const path = join(dir, name);
    const launch = await readLaunchEntryOrSkip(pi, path);
    if (launch && !out.has(launch.agentId)) out.set(launch.agentId, path);
  }
  return out;
}

export interface TeamMemberFile {
  attempt: number;
  path: string;
}

/** Every team-member file in `dir`, keyed by member id and sorted by attempt. A missing dir is empty. */
export async function indexTeamMemberFiles(dir: string): Promise<Map<string, TeamMemberFile[]>> {
  const pi = await requirePi();
  const out = new Map<string, TeamMemberFile[]>();
  for (const name of await listJsonl(dir)) {
    const path = join(dir, name);
    const launch = await readLaunchEntryOrSkip(pi, path);
    if (launch?.kind !== 'team-member') continue;
    const files = out.get(launch.agentId) ?? [];
    files.push({ attempt: launch.attempt, path });
    out.set(launch.agentId, files);
  }
  for (const files of out.values()) files.sort((a, b) => a.attempt - b.attempt);
  return out;
}

/** Locate an agent's file in `dir` by its launch entry. Null when none matches. */
export async function findAgentFile(dir: string, agentId: string): Promise<string | null> {
  const pi = await requirePi();
  for (const name of await listJsonl(dir)) {
    const path = join(dir, name);
    const launch = await readLaunchEntryOrSkip(pi, path);
    if (launch?.agentId === agentId) return path;
  }
  return null;
}

// ---- status resolution -------------------------------------------------------------

export interface ResolvedAgentStatus {
  status: AgentTerminalStatus | 'interrupted';
  stopReason?: AgentStopReason;
  /** Final text (result plus status note) when the source recorded one. */
  result?: string;
  source: 'agent-file' | 'tool-result' | 'injection' | 'none';
}

/**
 * An invocation's status, first recorded source wins: the agent file's status entry, the `Agent` tool
 * result `details`, the keep-alive injection `details`. With none of them the agent was killed before
 * any status was recorded, so it is interrupted.
 */
export function resolveAgentStatus(sources: {
  file?: AgentStatusData | undefined;
  toolResult?: AgentToolDetails | undefined;
  injection?: InjectedAgentResult | undefined;
}): ResolvedAgentStatus {
  const { file, toolResult, injection } = sources;
  if (file) {
    return { status: file.status, ...(file.stopReason ? { stopReason: file.stopReason } : {}), result: file.result, source: 'agent-file' };
  }
  if (toolResult && toolResult.status !== 'async_launched') {
    return { status: toolResult.status, ...(toolResult.stopReason ? { stopReason: toolResult.stopReason } : {}), source: 'tool-result' };
  }
  if (injection) {
    return {
      status: injection.status,
      ...(injection.stopReason ? { stopReason: injection.stopReason } : {}),
      result: injection.result,
      source: 'injection',
    };
  }
  return { status: 'interrupted', source: 'none' };
}

// ---- resumability ---------------------------------------------------------------------

/** A subagent's status as its in-memory record knows it, tied to the invocation that ran it. */
export interface LiveAgentStatus {
  toolCallId: string;
  status: AgentRecord['status'];
  stopReason?: AgentStopReason;
}

/** The parent-branch sources for subagent status, read once per lookup. */
export interface SubagentBranchIndex {
  invocations: AgentInvocationData[];
  toolDetails: Map<string, AgentToolDetails>;
  injected: Map<string, InjectedAgentResult>;
}

export function subagentBranchIndex(branch: readonly SessionEntry[]): SubagentBranchIndex {
  return {
    invocations: agentInvocationsOnBranch(branch).filter((inv) => inv.kind === 'subagent'),
    toolDetails: agentToolDetailsOnBranch(branch),
    injected: injectedAgentResultsOnBranch(branch),
  };
}

export interface SubagentLatestState {
  /** The spawn invocation, whose `Agent` arguments re-run an agent that has no file. */
  spawn: AgentInvocationData | undefined;
  latest: AgentInvocationData;
  status: AgentRecord['status'] | 'interrupted';
  stopReason?: AgentStopReason;
}

/**
 * The latest invocation of subagent `id` on the branch and its status. An in-memory record for that same
 * invocation outranks the persisted sources, which miss an agent that stopped before it had a file.
 * Null when the branch never invoked `id`.
 */
export function subagentLatestState(
  index: SubagentBranchIndex,
  id: string,
  file: AgentFile | null,
  live: LiveAgentStatus | undefined,
): SubagentLatestState | null {
  const mine = index.invocations.filter((inv) => inv.id === id);
  const latest = mine.at(-1);
  if (!latest) return null;
  const spawn = mine.find((inv) => !inv.resume);
  if (live && live.toolCallId === latest.toolCallId) {
    return { spawn, latest, status: live.status, ...(live.stopReason ? { stopReason: live.stopReason } : {}) };
  }
  const resolved = resolveAgentStatus({
    file: file ? segmentForInvocation(file, latest)?.status : undefined,
    toolResult: index.toolDetails.get(latest.toolCallId),
    injection: index.injected.get(latest.toolCallId),
  });
  return { spawn, latest, status: resolved.status, ...(resolved.stopReason ? { stopReason: resolved.stopReason } : {}) };
}

/** Resumable: stopped by the user or a panel shutdown, or killed before any status was recorded. */
export function isResumableSubagentStatus(state: Pick<SubagentLatestState, 'status' | 'stopReason'>): boolean {
  if (state.status === 'interrupted') return true;
  return state.status === 'stopped' && (state.stopReason === 'user' || state.stopReason === 'shutdown');
}
