import * as fs from 'fs';
import * as path from 'path';
import { log } from '../logger';
import { piSessionDirOf } from '../pi-session/session-store';
import { DAMOCLES_TEAM_DELIVERED_ENTRY } from '../pi-session/session-store/constants';
import {
  indexTeamMemberFiles,
  listTeamCheckpoints,
  readAgentFile,
  teamCheckpointPath,
  teamCheckpointsDir,
  teamEventLogPath,
  teamMembersDir,
} from '../pi-session/agent-records';
import { memberHistoryMessages } from './content-blocks';
import { CheckpointWriter } from './checkpoint-writer';
import { TeamRunLog } from './runs';
import type {
  AgentFailureKind,
  AgentSpec,
  ResumableCheckpoint,
  ScratchpadUpdateEvent,
  TeamAgent,
  TeamCheckpoint,
  TeamEventLog,
  TeamLogSpawn,
  TeamMessage,
  TeamPersistenceWriter,
  TeamCheckpointCause,
  TeamStatus,
} from './types';
import { isImageBlock } from '../../shared/types/content';
import type { TeamState as WebviewTeamState, TeamAgent as WebviewTeamAgent, TeamMessage as WebviewTeamMessage, ScratchpadEntry as WebviewScratchpadEntry, TeamAgentHistoryMessage } from '../../shared/types/team';

/**
 * The team event log (`teams/<teamId>.jsonl`) and the readers that rebuild a team card from it and from
 * each member's pi session files. Appends are synchronous, like pi's own session writes, so the log is
 * complete at any cancel or reload point.
 */
export class TeamPersistence implements TeamPersistenceWriter {
  private readonly cwd: string;
  private readonly persistenceSessionId: string;
  private sessionDir: string | null = null;
  private writeErrors: Error[] = [];

  constructor(cwd: string, persistenceSessionId: string) {
    this.cwd = cwd;
    this.persistenceSessionId = persistenceSessionId;
  }

  private ensureDir(): string {
    this.sessionDir ??= piSessionDirOf(this.cwd, this.persistenceSessionId);
    return this.sessionDir;
  }

  private eventLogPath(teamId: string): string {
    return teamEventLogPath(this.ensureDir(), this.persistenceSessionId, teamId);
  }

  initTeamFile(teamId: string): void {
    const filePath = this.eventLogPath(teamId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const entry = {
      type: 'queue-operation',
      operation: 'dequeue',
      timestamp: new Date().toISOString(),
      teamId,
    };
    fs.writeFileSync(filePath, JSON.stringify(entry) + '\n');
  }

  /** A failed write is collected and reported by `flush()`, so one bad entry never stops the team. */
  appendTeamEntry(entry: Record<string, unknown>): boolean {
    const teamId = entry['teamId'];
    if (typeof teamId !== 'string' || !teamId) return false;
    try {
      fs.appendFileSync(this.eventLogPath(teamId), JSON.stringify(entry) + '\n');
      return true;
    } catch (err) {
      this.writeErrors.push(err instanceof Error ? err : new Error(String(err)));
      return false;
    }
  }

  /** The writer of one run's checkpoint; a failed write is logged and collected for `flush()`. */
  createCheckpointWriter(teamId: string, key: number, snapshot: () => TeamCheckpoint): CheckpointWriter {
    return new CheckpointWriter({
      filePath: teamCheckpointPath(this.ensureDir(), this.persistenceSessionId, teamId, key),
      snapshot,
      onError: (err) => {
        log('[TeamPersistence] writing the resume checkpoint %d of team %s failed: %O', key, teamId, err);
        this.writeErrors.push(err);
      },
    });
  }

  /** Null when there is none. An unreadable checkpoint is logged and also reads as none. */
  async readCheckpoint(teamId: string, cancelledAt: number): Promise<TeamCheckpoint | null> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(teamCheckpointPath(this.ensureDir(), this.persistenceSessionId, teamId, cancelledAt), 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      log('[TeamPersistence] the resume checkpoint %d of team %s is not JSON: %O', cancelledAt, teamId, err);
      return null;
    }
    if (!isTeamCheckpoint(parsed) || parsed.teamId !== teamId || parsed.cancelledAt !== cancelledAt) {
      log('[TeamPersistence] the resume checkpoint %d of team %s has an invalid shape', cancelledAt, teamId);
      return null;
    }
    return parsed;
  }

  /**
   * The checkpoint a resume of `log`'s team continues from: its newest, unless the log ends completed, a
   * `team-resumed` entry already used it, or a reset sealed it. An older checkpoint is never offered, since
   * the team ran on past it.
   */
  async resumableCheckpoint(log: TeamEventLog): Promise<ResumableCheckpoint | null> {
    if (log.finalStatus === 'completed') return null;
    const newest = (await listTeamCheckpoints(teamCheckpointsDir(this.ensureDir(), this.persistenceSessionId, log.teamId))).at(-1);
    if (newest === undefined || log.resumedCheckpoints.has(newest)) return null;
    const checkpoint = await this.readCheckpoint(log.teamId, newest);
    return checkpoint !== null && isResumable(checkpoint) ? checkpoint : null;
  }

  /**
   * Why the team stopped, when `resume_team` would find a checkpoint to continue from and the team is offered for
   * one, else null; a team with no event log has none, and a team whose lead failed to start is not offered, since
   * a resume would not start it either. 'interrupted' for a live checkpoint, whose run never sealed it: the caller
   * rules out a team this process still runs. 'unrecorded' for a checkpoint written before the cause was recorded.
   */
  async resumableStop(teamId: string): Promise<TeamCheckpointCause | 'interrupted' | 'unrecorded' | null> {
    let teamLog: TeamEventLog;
    try {
      teamLog = await this.readEventLog(teamId);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    const checkpoint = await this.resumableCheckpoint(teamLog);
    if (checkpoint === null || (checkpoint.stoppedBy === 'failed' && checkpoint.leadFailure === 'start')) return null;
    if (checkpoint.live) return 'interrupted';
    return checkpoint.stoppedBy ?? 'unrecorded';
  }

  /** The event log as a resume needs it. Throws when the log is missing or a line is malformed. */
  async readEventLog(teamId: string): Promise<TeamEventLog> {
    const content = await fs.promises.readFile(this.eventLogPath(teamId), 'utf-8');
    return parseTeamEventLog(teamId, content);
  }

  async flush(): Promise<void> {
    if (this.writeErrors.length > 0) {
      const errors = this.writeErrors.splice(0);
      throw new AggregateError(errors, `${errors.length} persistence write(s) failed`);
    }
  }

  private membersDir(teamId: string): string {
    return teamMembersDir(this.ensureDir(), this.persistenceSessionId, teamId);
  }

  async loadTeamState(teamId: string): Promise<WebviewTeamState | null> {
    try {
      const content = await fs.promises.readFile(this.eventLogPath(teamId), 'utf-8');
      const memberFiles = await indexTeamMemberFiles(this.membersDir(teamId));
      const lines = content.trim().split('\n').filter(Boolean);

      const agents: WebviewTeamAgent[] = [];
      const messages: WebviewTeamMessage[] = [];
      const scratchpad: WebviewScratchpadEntry[] = [];
      let title = '';
      let toolUseId = '';
      let status: 'running' | 'completed' | 'failed' | 'cancelled' = 'completed';
      let result: string | null = null;
      let startTime = Date.now();
      let endTime: number | null = null;
      // True from a run's start until its team-completed.
      let runOpen = false;
      let lastTime: number | null = null;
      const runLog = new TeamRunLog();

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          runLog.add(entry);
          const entryType = entry['type'] as string;
          const time = Date.parse(entry['timestamp'] as string);
          if (Number.isFinite(time)) lastTime = time;

          if (entryType === 'team-created') {
            runOpen = true;
            title = entry['title'] as string;
            toolUseId = (entry['toolUseId'] as string) ?? '';
            startTime = new Date(entry['timestamp'] as string).getTime();
            const specs = entry['agents'] as Array<{ name: string; role: string; model?: string }>;
            for (const spec of specs) {
              agents.push({
                agentId: '',
                name: spec.name,
                role: spec.role as 'lead' | 'specialist',
                description: null,
                task: null,
                model: spec.model ?? '',
                profileId: null,
                attempt: 0,
                status: 'pending',
                activeMs: 0,
                runningSince: null,
                toolCount: 0,
                lastToolName: null,
                totalInputTokens: 0,
                totalOutputTokens: 0,
                cacheReadTokens: 0,
                cacheCreationTokens: 0,
                costUsd: 0,
                // Until the agent-spawned entry names the resolved model, bill as a charge, since
                // understating a real cost is the worse error.
                dollarBilled: true,
                effort: null,
                progressSummary: null,
                result: null,
                logFilePath: null,
              });
            }
          } else if (entryType === 'agent-spawned') {
            const agent = agents.find(a => a.name === entry['name']);
            if (agent) {
              agent.agentId = entry['agentId'] as string;
              agent.description = typeof entry['description'] === 'string' ? entry['description'] : null;
              agent.task = spawnedTask(entry);
              agent.model = (entry['model'] as string) ?? '';
              if (typeof entry['dollarBilled'] === 'boolean') agent.dollarBilled = entry['dollarBilled'];
              agent.profileId = (entry['profileId'] as string) ?? null;
              // A log written before the attempt counter existed carries no field, and every spawn it
              // recorded belongs to the agent's first attempt.
              agent.attempt = typeof entry['attempt'] === 'number' ? entry['attempt'] : 0;
              // A launch restarts the work fields, so a dead attempt's count and result never outlive it.
              agent.status = 'running';
              agent.toolCount = 0;
              agent.lastToolName = null;
              agent.result = null;
              agent.progressSummary = null;
              // The spawned attempt's own file; it does not exist until pi commits the attempt's task prompt.
              agent.logFilePath = memberFiles.get(agent.agentId)?.find((f) => f.attempt === agent.attempt)?.path ?? null;
            }
          } else if (entryType === 'agent-message') {
            const senderAgent = agents.find(a => a.name === entry['from']);
            const recipientAgent = entry['to'] ? agents.find(a => a.name === entry['to']) : null;
            messages.push({
              messageId: entry['messageId'] as string,
              senderAgentId: senderAgent?.agentId ?? '',
              senderName: entry['from'] as string,
              recipientAgentId: recipientAgent?.agentId ?? null,
              recipientName: (entry['to'] as string) ?? null,
              content: entry['content'] as string,
              timestamp: new Date(entry['timestamp'] as string).getTime(),
            });
          } else if (entryType === 'scratchpad-update') {
            const authorAgent = agents.find(a => a.name === entry['author']);
            scratchpad.push({
              section: entry['section'] as string,
              content: entry['content'] as string,
              agentId: authorAgent?.agentId ?? '',
              agentName: entry['author'] as string,
              version: entry['version'] as number,
              timestamp: new Date(entry['timestamp'] as string).getTime(),
            });
          } else if (entryType === 'agent-completed') {
            const entryName = entry['name'] as string | undefined;
            const agent = (entryName ? agents.find(a => a.name === entryName) : undefined)
              ?? agents.find(a => a.agentId === entry['agentId']);
            if (agent) {
              agent.status = entry['status'] as WebviewTeamAgent['status'];
              agent.result = (entry['result'] as string) ?? null;
              if (typeof entry['toolCallCount'] === 'number') {
                agent.toolCount = entry['toolCallCount'];
              }
              // Each entry holds one attempt's own usage, so the totals add up over a redispatch while
              // the fields above describe only the attempt that settled last.
              if (typeof entry['totalInputTokens'] === 'number') agent.totalInputTokens += entry['totalInputTokens'];
              if (typeof entry['totalOutputTokens'] === 'number') agent.totalOutputTokens += entry['totalOutputTokens'];
              if (typeof entry['cacheReadTokens'] === 'number') agent.cacheReadTokens += entry['cacheReadTokens'];
              if (typeof entry['cacheCreationTokens'] === 'number') agent.cacheCreationTokens += entry['cacheCreationTokens'];
              if (typeof entry['costUsd'] === 'number') agent.costUsd += entry['costUsd'];
            }
          } else if (entryType === 'team-completed') {
            runOpen = false;
            status = entry['status'] as typeof status;
            result = (entry['synthesizedResult'] as string) ?? null;
            endTime = new Date(entry['timestamp'] as string).getTime();
            // The finalize forces a member it gave up on terminal and records that only here, not in an agent-completed.
            const agentResults = entry['agentResults'];
            for (const recorded of Array.isArray(agentResults) ? agentResults : []) {
              if (!isRecord(recorded) || !isString(recorded['status']) || !AGENT_STATUSES.has(recorded['status'])) continue;
              const agent = agents.find(a => a.agentId !== '' && a.agentId === recorded['agentId']) ?? agents.find(a => a.name === recorded['name']);
              if (agent && !TERMINAL_STATUSES.has(agent.status)) agent.status = recorded['status'] as WebviewTeamAgent['status'];
            }
          } else if (entryType === 'team-resumed') {
            runOpen = true;
            status = 'running';
            result = null;
            endTime = null;
          } else if (entryType === 'agent-resumed') {
            const agent = agents.find(a => a.name === entry['name']);
            if (agent) {
              agent.status = entry['status'] as WebviewTeamAgent['status'];
              agent.progressSummary = null;
              // A resumed member is live again, and only its next settle records a result.
              agent.result = null;
              if (typeof entry['attempt'] === 'number') agent.attempt = entry['attempt'];
              agent.logFilePath = memberFiles.get(agent.agentId)?.find((f) => f.attempt === agent.attempt)?.path ?? null;
            }
          }
        } catch {
          // skip malformed lines
        }
      }

      // A run with no team-completed was stopped before its drain finished, since a live team's card
      // comes from its runner rather than from here. It reads as a cancel whose drain stopped every member.
      if (runOpen) {
        status = 'cancelled';
        endTime = lastTime;
        for (const agent of agents) {
          if (agent.status !== 'running' && agent.status !== 'standby' && agent.status !== 'awaiting-review' && agent.status !== 'monitoring') continue;
          agent.status = 'cancelled';
        }
      }

      for (const agent of agents) {
        agent.effort = runLog.memberEffort(agent.agentId);
        agent.activeMs = runLog.memberActiveMs(agent.agentId);
      }
      const totalToolCount = agents.reduce((sum, a) => sum + a.toolCount, 0);

      return {
        teamId,
        toolUseId,
        title,
        status,
        phase: 'complete',
        agents,
        messages,
        scratchpad,
        result,
        startTime,
        endTime,
        totalToolCount,
        runs: runLog.runs(),
      };
    } catch (err) {
      log('[TeamPersistence] loadTeamState failed for team %s (session %s): %O', teamId, this.persistenceSessionId, err);
      return null;
    }
  }

  /** A member's card messages, every attempt in order, mapped from its pi session files. */
  async loadAgentConversation(teamId: string, agentId: string): Promise<TeamAgentHistoryMessage[]> {
    return this.loadAgentAttempts(teamId, agentId);
  }

  /**
   * The card messages of a member's attempts, each id `<attempt>:<entry id>`, as a running member's transcript read from memory
   * gives its own; with `before`, only the attempts before that one, which that transcript follows.
   */
  async loadAgentAttempts(teamId: string, agentId: string, before?: number): Promise<TeamAgentHistoryMessage[]> {
    try {
      const files = (await indexTeamMemberFiles(this.membersDir(teamId))).get(agentId) ?? [];
      const history: TeamAgentHistoryMessage[] = [];
      for (const { attempt, path: filePath } of files) {
        if (before !== undefined && attempt >= before) break;
        const file = await readAgentFile(filePath);
        if (!file) continue;
        // Each segment is one run of the member's runner, which starts with no batch an abort could cut.
        for (const segment of file.segments) {
          // Entry ids are unique only within one file, and the card keys its messages by id.
          for (const message of memberHistoryMessages(segment.messages, file.entryIds, file.stoppedToolCallIds, file.windDownMessages)) history.push({ ...message, id: `${attempt}:${message.id}` });
        }
      }
      return history;
    } catch (err) {
      log('[TeamPersistence] loadAgentAttempts failed for agent %s (team %s): %O', agentId, teamId, err);
      return [];
    }
  }
}

const AGENT_STATUSES: ReadonlySet<string> = new Set<TeamAgent['status']>([
  'pending', 'running', 'completed', 'failed', 'cancelled', 'awaiting-review', 'standby', 'monitoring',
]);

const TERMINAL_STATUSES: ReadonlySet<string> = new Set<TeamAgent['status']>(['completed', 'failed', 'cancelled']);
const SEAL_CAUSES: ReadonlySet<string> = new Set<TeamCheckpointCause | 'reset'>(['user', 'parent', 'shutdown', 'failed', 'reset']);
const FAILURE_KINDS: ReadonlySet<string> = new Set<AgentFailureKind>(['start', 'model', 'run']);

const isResumable = (checkpoint: TeamCheckpoint): checkpoint is ResumableCheckpoint => checkpoint.stoppedBy !== 'reset';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isString);

/** The task an `agent-spawned` entry gave its attempt. A log written before `task` was recorded holds a specialist's task as its `specialization`. */
export function spawnedTask(entry: Record<string, unknown>): string | null {
  if (isString(entry['task'])) return entry['task'];
  return entry['role'] === 'specialist' && isString(entry['specialization']) ? entry['specialization'] : null;
}

function isPairArray(v: unknown, second: (x: unknown) => boolean): boolean {
  return Array.isArray(v) && v.every((p) => Array.isArray(p) && p.length === 2 && isString(p[0]) && second(p[1]));
}

function isUsage(v: unknown): boolean {
  return isRecord(v) && ['totalInputTokens', 'totalOutputTokens', 'cacheReadTokens', 'cacheCreationTokens', 'costUsd']
    .every((k) => typeof v[k] === 'number' && Number.isFinite(v[k]));
}

function isCheckpointMember(v: unknown): boolean {
  return isRecord(v)
    && isString(v['agentId']) && v['agentId'].length > 0
    && isString(v['name'])
    && (v['role'] === 'lead' || v['role'] === 'specialist')
    && isCount(v['attempt'])
    && isCount(v['resumeCount'])
    && isString(v['status']) && AGENT_STATUSES.has(v['status'])
    && Array.isArray(v['undelivered'])
    && v['undelivered'].every((m) => isRecord(m) && isString(m['text']) && typeof m['echoed'] === 'boolean'
      && (m['images'] === undefined || (Array.isArray(m['images']) && m['images'].every(isImageBlock)))
      && (m['ids'] === undefined || isStringArray(m['ids'])))
    && isUsage(v['usage'])
    && isCount(v['toolCallCount']);
}

const isStamp = (v: unknown): boolean => isRecord(v) && isCount(v['attempt']) && isCount(v['round']);

const isSignoff = (v: unknown): boolean => isRecord(v)
  && (v['stamp'] === null || isStamp(v['stamp']))
  && (v['verdict'] === 'approve' || v['verdict'] === 'changes_requested');

const isDismissal = (v: unknown): boolean => isRecord(v) && isStamp(v['stamp']) && isString(v['reason']) && isString(v['why']);

function isCoverage(v: unknown): boolean {
  return isRecord(v)
    && isPairArray(v['landed'], isStamp)
    && isPairArray(v['signoffs'], (s) => isPairArray(s, isSignoff))
    && isPairArray(v['dismissals'], (d) => isPairArray(d, isDismissal))
    && isStringArray(v['reReviewOwed']);
}

export function isTeamCheckpoint(value: unknown): value is TeamCheckpoint {
  if (!isRecord(value) || value['version'] !== 1 || !isString(value['teamId']) || !isCount(value['cancelledAt'])) return false;
  if (value['stoppedBy'] !== undefined && !SEAL_CAUSES.has(value['stoppedBy'] as string)) return false;
  if (value['live'] !== undefined && value['live'] !== true) return false;
  // A failure seal names how the lead failed, and a seal of a resume that never launched carries it on.
  if (value['leadFailure'] === undefined ? value['stoppedBy'] === 'failed' : !(FAILURE_KINDS.has(value['leadFailure'] as string) && value['live'] === undefined)) return false;
  if (value['interrupted'] !== undefined && !(value['interrupted'] === true && value['live'] === undefined)) return false;
  if (value['asOf'] !== undefined && !isCount(value['asOf'])) return false;
  if (value['messagesThrough'] !== undefined && !isString(value['messagesThrough'])) return false;
  if (!Array.isArray(value['members']) || !value['members'].every(isCheckpointMember)) return false;
  if (!isPairArray(value['readerCursors'], (s) => isPairArray(s, isCount))) return false;
  const review = value['review'];
  if (!isRecord(review)) return false;
  const reviewOk = isPairArray(review['specialistReviewRounds'], isCount)
    && isStringArray(review['reviewedSpecialists'])
    && isStringArray(review['confirmedComplete'])
    && isPairArray(review['reportedSummaries'], isString)
    && isStringArray(review['pendingStandby'])
    && isStringArray(review['owedTerminalAction'])
    && isStringArray(review['nudgeDelivered'])
    && isStringArray(review['terminalNudgeDelivered'])
    && isPairArray(review['briefConflicts'], isString)
    && isCount(review['conflictNudges'])
    && isCount(review['leadReviewStalls'])
    && (review['lastReviewRoundNotification'] === null || isString(review['lastReviewRoundNotification']))
    && (review['coverage'] === undefined || isCoverage(review['coverage']));
  if (!reviewOk) return false;
  const steers = value['operatorSteers'];
  return Array.isArray(steers) && steers.every((s) => isRecord(s) && isString(s['memberName']) && isString(s['message'])
    && (s['imageCount'] === undefined || isCount(s['imageCount']))
    && (s['attempt'] === undefined || isCount(s['attempt'])));
}

/** Every delivery id a member session file's `damocles-team-delivered` entries record. Rejects when the file cannot be read. */
export async function deliveredIdsInSessionFile(filePath: string): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const line of (await fs.promises.readFile(filePath, 'utf-8')).split('\n')) {
    if (!line.includes(DAMOCLES_TEAM_DELIVERED_ENTRY)) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // A line a crash tore records nothing, so its message is redelivered.
      continue;
    }
    if (!isRecord(entry) || entry['type'] !== 'custom' || entry['customType'] !== DAMOCLES_TEAM_DELIVERED_ENTRY) continue;
    const data = entry['data'];
    if (isRecord(data) && isStringArray(data['ids'])) for (const id of data['ids']) ids.add(id);
  }
  return ids;
}

class TeamLogError extends Error {
  constructor(teamId: string, line: number, detail: string) {
    super(`The event log of team "${teamId}" is unreadable at line ${line}: ${detail}`);
  }
}

/** Parse the event log a resume rebuilds the team from. Every line must be valid; a gap would desync the rebuild. */
export function parseTeamEventLog(teamId: string, content: string): TeamEventLog {
  let created: Pick<TeamEventLog, 'toolUseId' | 'title' | 'brief' | 'agents' | 'startTime'> | null = null;
  const spawns: TeamLogSpawn[] = [];
  const messages: TeamMessage[] = [];
  const scratchpad: ScratchpadUpdateEvent[] = [];
  const lastResults = new Map<string, string>();
  let finalStatus: TeamStatus | null = null;
  const resumedCheckpoints = new Set<number>();
  const runLog = new TeamRunLog();

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.trim();
    if (!text) continue;
    const lineNo = i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new TeamLogError(teamId, lineNo, err instanceof Error ? err.message : String(err));
    }
    if (!isRecord(parsed)) throw new TeamLogError(teamId, lineNo, 'not an object');
    const e = parsed;
    runLog.add(e);
    const str = (key: string): string => {
      const v = e[key];
      if (!isString(v)) throw new TeamLogError(teamId, lineNo, `"${key}" is not a string`);
      return v;
    };
    const time = (key: string): number => {
      const ms = Date.parse(str(key));
      if (!Number.isFinite(ms)) throw new TeamLogError(teamId, lineNo, `"${key}" is not a timestamp`);
      return ms;
    };
    const num = (key: string): number => {
      const v = e[key];
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new TeamLogError(teamId, lineNo, `"${key}" is not a number`);
      return v;
    };

    switch (e['type']) {
      case 'team-created': {
        const agents = e['agents'];
        if (!Array.isArray(agents) || !agents.every((a) => isRecord(a) && isString(a['name']) && (a['role'] === 'lead' || a['role'] === 'specialist'))) {
          throw new TeamLogError(teamId, lineNo, '"agents" is not a roster');
        }
        created = {
          toolUseId: str('toolUseId'),
          title: str('title'),
          brief: str('brief'),
          agents: agents.map((a) => ({ name: a['name'] as string, role: a['role'] as AgentSpec['role'] })),
          startTime: time('timestamp'),
        };
        break;
      }
      case 'agent-spawned': {
        const role = e['role'];
        if (role !== 'lead' && role !== 'specialist') throw new TeamLogError(teamId, lineNo, '"role" is invalid');
        const kind = e['kind'];
        if (kind !== undefined && kind !== 'implementor' && kind !== 'reviewer') throw new TeamLogError(teamId, lineNo, '"kind" is invalid');
        const reviews = e['reviews'];
        if (reviews !== undefined && !(kind === 'reviewer' && isStringArray(reviews))) {
          throw new TeamLogError(teamId, lineNo, '"reviews" is invalid');
        }
        const profileId = e['profileId'];
        const description = e['description'];
        const name = str('name');
        lastResults.delete(name);
        spawns.push({
          agentId: str('agentId'),
          name,
          role,
          specialization: str('specialization'),
          description: isString(description) ? description : null,
          task: spawnedTask(e),
          model: str('model'),
          dollarBilled: e['dollarBilled'] === true,
          profileId: isString(profileId) ? profileId : null,
          attempt: num('attempt'),
          timestamp: time('timestamp'),
          messagesBefore: messages.length,
          ...(kind ? { kind } : {}),
          // `[]` is a declared reviewer of nobody, distinct from an absent list.
          ...(isStringArray(reviews) ? { reviews: [...reviews] } : {}),
        });
        break;
      }
      case 'agent-completed': {
        const result = e['result'];
        if (isString(result)) lastResults.set(str('name'), result);
        else lastResults.delete(str('name'));
        break;
      }
      case 'agent-message': {
        const to = e['to'];
        const kind = e['kind'];
        if (to !== null && !isString(to)) throw new TeamLogError(teamId, lineNo, '"to" is invalid');
        if (kind !== undefined && kind !== 'scratchpad-notice' && kind !== 'ledger-notice') throw new TeamLogError(teamId, lineNo, '"kind" is invalid');
        messages.push({
          messageId: str('messageId'),
          teamId,
          timestamp: time('timestamp'),
          from: str('from'),
          to,
          content: str('content'),
          ...(kind ? { kind } : {}),
        });
        break;
      }
      case 'scratchpad-update':
        scratchpad.push({
          section: str('section'),
          content: str('content'),
          author: str('author'),
          version: num('version'),
          timestamp: time('timestamp'),
          immutable: e['immutable'] === true,
          appendOnly: e['appendOnly'] === true,
        });
        break;
      case 'team-completed': {
        const status = e['status'];
        if (status !== 'completed' && status !== 'cancelled' && status !== 'failed' && status !== 'running') {
          throw new TeamLogError(teamId, lineNo, '"status" is invalid');
        }
        finalStatus = status;
        break;
      }
      case 'team-resumed': {
        const checkpoint = e['checkpoint'];
        if (!isCount(checkpoint)) throw new TeamLogError(teamId, lineNo, '"checkpoint" is not a checkpoint time');
        resumedCheckpoints.add(checkpoint);
        finalStatus = null;
        break;
      }
      default:
        break;
    }
  }
  if (!created) throw new TeamLogError(teamId, 1, 'no team-created entry');
  return { teamId, ...created, spawns, messages, scratchpad, lastResults, finalStatus, resumedCheckpoints, runs: runLog.runs(), efforts: runLog.memberEfforts(), activeMs: runLog.memberActiveTimes() };
}
