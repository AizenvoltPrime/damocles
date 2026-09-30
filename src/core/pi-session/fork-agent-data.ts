/**
 * fork-agent-data.ts — Copy the subagent and team data a forked branch invoked into the fork's own
 * session subtree, as it stood at the fork point. The fork then resumes and renders its copies, and the
 * source session's files are only read.
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from './pi-loader';
import {
  agentInvocationsOnBranch,
  indexAgentFiles,
  indexTeamMemberFiles,
  listTeamCheckpoints,
  subagentsDir,
  teamCheckpointPath,
  teamCheckpointsDir,
  teamEventLogPath,
  teamMembersDir,
} from './agent-records';

export interface ForkAgentDataInput {
  SessionManager: PiCodingAgentModule['SessionManager'];
  /** The workspace pi session dir holding both sessions. */
  sessionDir: string;
  sourceSessionId: string;
  targetSessionId: string;
  /** The fork's branch, root to leaf, as entries of the source session. */
  branch: readonly SessionEntry[];
  /** Epoch ms. Agent data recorded after it is not copied. */
  forkPointMs: number;
}

function isNotFound(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Copy an agent pi session up to its last entry at or before `forkPointMs` into `targetDir`, under a new
 * pi session id. Writes nothing when that prefix holds no assistant message, the same as pi's own
 * deferred first write, so the copy then reads as an agent stopped before its first response.
 */
function cutAgentSession(SessionManager: ForkAgentDataInput['SessionManager'], sourceFile: string, targetDir: string, forkPointMs: number): void {
  const sm = SessionManager.open(sourceFile, targetDir);
  let leafId: string | undefined;
  for (const entry of sm.getEntries()) {
    if (!(Date.parse(entry.timestamp) <= forkPointMs)) break;
    leafId = entry.id;
  }
  if (leafId) sm.createBranchedSession(leafId);
}

function lineTimestamp(line: string): number | undefined {
  const parsed: unknown = JSON.parse(line);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
  const raw = (parsed as Record<string, unknown>)['timestamp'];
  return typeof raw === 'string' ? Date.parse(raw) : undefined;
}

/** Copy the team event log's lines up to the first one recorded after `forkPointMs`, or the first unreadable one. */
async function cutEventLog(sourceFile: string, targetFile: string, forkPointMs: number): Promise<void> {
  let content: string;
  try {
    content = await readFile(sourceFile, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return;
    throw err;
  }
  const kept: string[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let ts: number | undefined;
    try {
      ts = lineTimestamp(line);
    } catch {
      // A resume rejects a log with a malformed line, so the copy ends before it.
      break;
    }
    if (ts !== undefined && !(ts <= forkPointMs)) break;
    kept.push(line);
  }
  if (kept.length === 0) return;
  await mkdir(dirname(targetFile), { recursive: true });
  await writeFile(targetFile, `${kept.join('\n')}\n`);
}

/**
 * The cancel times of the checkpoints taken at or before the fork point. The event log is cut at the
 * same point, so a checkpoint resumed after it is unused again in the fork.
 */
async function checkpointsAtForkPoint(sourceDir: string, forkPointMs: number): Promise<number[]> {
  return (await listTeamCheckpoints(sourceDir)).filter((cancelledAt) => cancelledAt <= forkPointMs);
}

/**
 * Copy every subagent and team the fork's branch invoked into the target session's subtree, cut at the
 * fork point. Each item is copied independently; the returned errors name the items that failed.
 */
export async function copyForkAgentData(input: ForkAgentDataInput): Promise<Error[]> {
  const { SessionManager, sessionDir, sourceSessionId, targetSessionId, forkPointMs } = input;
  const failures: Error[] = [];
  const attempt = async (label: string, run: () => Promise<void> | void): Promise<void> => {
    try {
      await run();
    } catch (err) {
      failures.push(new Error(`${label}: ${err instanceof Error ? err.message : String(err)}`, { cause: err }));
    }
  };

  const invocations = agentInvocationsOnBranch(input.branch);
  const subagentIds = new Set(invocations.filter((inv) => inv.kind === 'subagent').map((inv) => inv.id));
  const teamIds = new Set(invocations.filter((inv) => inv.kind === 'team').map((inv) => inv.id));

  const sourceSubagents = subagentsDir(sessionDir, sourceSessionId);
  const targetSubagents = subagentsDir(sessionDir, targetSessionId);
  let subagentFiles = new Map<string, string>();
  if (subagentIds.size > 0) {
    await attempt('subagent files', async () => {
      subagentFiles = await indexAgentFiles(sourceSubagents);
    });
  }
  for (const id of subagentIds) {
    const sourceFile = subagentFiles.get(id);
    if (sourceFile) await attempt(`subagent ${id}`, () => cutAgentSession(SessionManager, sourceFile, targetSubagents, forkPointMs));
  }

  for (const teamId of teamIds) {
    await attempt(`team ${teamId} event log`, () =>
      cutEventLog(teamEventLogPath(sessionDir, sourceSessionId, teamId), teamEventLogPath(sessionDir, targetSessionId, teamId), forkPointMs),
    );
    const targetMembers = teamMembersDir(sessionDir, targetSessionId, teamId);
    let memberFiles: string[] = [];
    await attempt(`team ${teamId} members`, async () => {
      const index = await indexTeamMemberFiles(teamMembersDir(sessionDir, sourceSessionId, teamId));
      memberFiles = [...index.values()].flat().map((f) => f.path);
    });
    for (const file of memberFiles) {
      await attempt(`team ${teamId} member file ${file}`, () => cutAgentSession(SessionManager, file, targetMembers, forkPointMs));
    }
    let checkpoints: number[] = [];
    await attempt(`team ${teamId} checkpoints`, async () => {
      checkpoints = await checkpointsAtForkPoint(teamCheckpointsDir(sessionDir, sourceSessionId, teamId), forkPointMs);
    });
    for (const cancelledAt of checkpoints) {
      await attempt(`team ${teamId} checkpoint ${cancelledAt}`, async () => {
        await mkdir(teamCheckpointsDir(sessionDir, targetSessionId, teamId), { recursive: true });
        await copyFile(teamCheckpointPath(sessionDir, sourceSessionId, teamId, cancelledAt), teamCheckpointPath(sessionDir, targetSessionId, teamId, cancelledAt));
      });
    }
  }
  return failures;
}
