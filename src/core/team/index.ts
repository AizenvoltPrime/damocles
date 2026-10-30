import * as crypto from 'crypto';
import { platform } from '../platform-host';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { TeamRunner } from './team-runner';
import { TeamPersistence } from './persistence';
import type { AgentFailure, AgentFailureKind, TeamConfig, AgentSpec, TeamPermissionMode, TeamEngine, ResolvedTeamModel, TeamRole, TeamRunResult, TeamEventLog, TeamStop, MemberTranscript } from './types';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { SteerTargetInfo } from '../../shared/types/subagents';
import type { ImageBlock } from '../../shared/types/content';
import type { TeamState as WebviewTeamState } from '../../shared/types/team';
import { agentInvocationsOnBranch, indexTeamMemberFiles, teamEventLogPath, teamMembersDir, type AgentInvocationData } from '../pi-session/agent-records';
import { piSessionDirOf } from '../pi-session/session-store';
import { agentFileHeldElsewhere } from '../pi-session/agent-file-owner';
import { formatTeamUserSteerPrefix } from '../../shared/steer';
import { oneLine } from '../pi-session/untrusted-text';
import type { InterruptionCause } from '../pi-session/interruption-notice';

/** Team ids are exactly what `crypto.randomUUID()` returns; `isValidTeamId` checks that format. */
export function newTeamId(): string {
  return crypto.randomUUID();
}

const TEAM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isValidTeamId(id: string): boolean {
  return TEAM_ID.test(id);
}

const TEAM_STOP_CAUSE: Record<TeamStop, string> = {
  user: 'TEAM STOPPED BY THE USER before completion',
  parent: 'TEAM CANCELLED by your cancel_team call before completion',
  shutdown: 'TEAM STOPPED before completion because its chat panel closed, switched session or the editor window reloaded',
  reset: 'TEAM STOPPED before completion because the conversation was cleared',
};

/** Heads the result of a team that stopped on a cancel, so the parent knows why and whether it can offer to continue it. */
export function teamCancelledHeader(teamId: string, stop: TeamStop, resumable: boolean): string {
  const cause = TEAM_STOP_CAUSE[stop];
  if (stop === 'reset') return `(${cause}; results are partial and it cannot be resumed.)\n\n`;
  return resumable
    ? `(${cause}; results are partial. Resume it with resume_team({team_id:"${teamId}"}) if the user asks to continue.)\n\n`
    : `(${cause}; results are partial. Its resume state was not saved, so it cannot be resumed.)\n\n`;
}

const LEAD_ERROR_MAX_CHARS = 300;

const LEAD_FAILURE_CAUSE: Record<AgentFailureKind, string> = {
  start: 'its lead agent failed to start',
  model: "its lead agent's model call failed",
  run: "its lead agent's run stopped on an error",
};

/**
 * Heads the result of a team whose lead failed before any stop. The message is untrusted text, so it is flattened and
 * capped. A lead that failed to start is not offered for a resume, which would fail to start it the same way.
 */
export function teamFailedHeader(teamId: string, failure: AgentFailure, resumable: boolean): string {
  const detail = oneLine(failure.message, LEAD_ERROR_MAX_CHARS);
  const cause = `TEAM FAILED before completion because ${LEAD_FAILURE_CAUSE[failure.kind]}${detail ? ` (${detail})` : ''}`;
  if (failure.kind === 'start') return `(${cause}; results are partial.)\n\n`;
  return resumable
    ? `(${cause}; results are partial. Resume it with resume_team({team_id:"${teamId}"}) if the user asks to continue.)\n\n`
    : `(${cause}; results are partial. Its resume state was not saved, so it cannot be resumed.)\n\n`;
}

// Keyed by event log path, across every panel of this window: a team whose run has not settled, draining
// included, is still writing its files and must not get a second writer.
const unsettledTeams = new Set<string>();

/** Whether a run of the team, draining or still validating its resume included, holds its files in this process. */
export function isTeamRunningHere(cwd: string, sessionId: string, teamId: string): boolean {
  return unsettledTeams.has(teamEventLogPath(piSessionDirOf(cwd, sessionId), sessionId, teamId));
}

/**
 * The interruption notice's cause for a team. A live checkpoint of a team this process runs is no interruption: it
 * reads 'running', which a later check decides, since a stop's seal may not have landed yet. A sealed cause is
 * reported while the team still drains here.
 */
export async function teamInterruptionCause(cwd: string, sessionId: string, teamId: string): Promise<InterruptionCause | 'running' | null> {
  const cause = await new TeamPersistence(cwd, sessionId).resumableStop(teamId);
  return cause === 'interrupted' && isTeamRunningHere(cwd, sessionId, teamId) ? 'running' : cause;
}

/**
 * Per-panel team coordinator (US-024d). Constructed on the pi path by `session-manager.ts` and handed to
 * `PiSession` via `SessionOptions.teamService`; the `create_team` tool drives `createTeam`, which awaits
 * `TeamRunner.run()` and returns the synthesis as the tool result (BLOCKING contract). One team per panel
 * (the `activeTeamId` claim throws), and `resumeTeam` continues a stopped or failed one the same blocking way. PiSession supplies the pi-native engine + model resolvers via `deps`
 * — this module is provider-agnostic (no SDK, no Anthropic-only lead model).
 */
export interface TeamServiceDeps {
  cwd: string;
  onMessage: (msg: ExtensionToWebviewMessage) => void;
  /** The panel's current session id (team transcripts are scoped under it). */
  getSessionId: () => string | null;
  /** The panel's current permission mode (default/acceptEdits/plan). */
  getPermissionMode: () => string;
  /** Resolve a team role's model + reasoning depth from the user's per-role settings (lead / implementor
   *  / reviewer). A configured-but-unresolvable/unauthed slot returns `{ error }`. */
  resolveRoleModel: (role: TeamRole) => ResolvedTeamModel;
  /** Build the pi-native session/tools/gate/cost engine for a team run. */
  buildEngine: () => TeamEngine;
  /** Index a team invocation on the parent session branch, which is how a reopened card finds its team. */
  recordInvocation: (data: AgentInvocationData) => void;
  /** The parent session's current branch: the only index of the teams this conversation started. */
  parentBranch: () => readonly SessionEntry[];
  /** Throw the resume error unless the model recorded in the member session file at `path` is usable. */
  assertResumableModel: (path: string, agentId: string) => void;
  /** Have the parent tell its model, before the next user prompt, which agents were interrupted. */
  requestInterruptionCheck: () => void;
}

export class TeamService {
  private pendingToolUseId: string | null = null;
  private activeRunner: TeamRunner | null = null;
  // Set with `activeRunner`, and alone while a resume validates: the claim that keeps a second team out.
  private activeTeamId: string | null = null;
  // The resume holding the claim, so a resume that outlived a dispose never releases a newer claim. `stop` is the
  // first stop that landed since the claim was taken, so a resume still validating never launches.
  private resumeClaim: { stop: TeamStop | null } | null = null;
  // Settles only after the team's drain and final event-log writes, or a resume's validation, so it is what a folder delete waits on.
  private lastRun: Promise<unknown> = Promise.resolve();
  private readonly deps: TeamServiceDeps;
  /** Called whenever `running` flips. Supplied by the owning PiSession's state publisher. */
  private runListener: (() => void) | null = null;

  constructor(deps: TeamServiceDeps) {
    this.deps = deps;
  }

  setRunListener(listener: (() => void) | null): void {
    this.runListener = listener;
  }

  /** A team holds this panel's claim: it runs, or a resume of one is validating. */
  get running(): boolean {
    return this.activeTeamId !== null;
  }

  private setActiveTeam(teamId: string | null, runner: TeamRunner | null): void {
    this.activeTeamId = teamId;
    this.activeRunner = runner;
    this.runListener?.();
  }

  get isEnabled(): boolean {
    return platform().settings.get<boolean>('damocles.team.enabled', false);
  }

  setPendingToolUseId(toolUseId: string): void {
    this.pendingToolUseId = toolUseId;
  }

  async createTeam(config: {
    title: string;
    brief: string;
    agents: Array<{ name: string; role: 'lead' | 'specialist' }>;
  }): Promise<string> {
    if (this.activeTeamId !== null) {
      throw new Error('A team is already running in this panel');
    }

    const teamId = newTeamId();
    const toolUseId = this.pendingToolUseId ?? '';
    this.pendingToolUseId = null;
    const sessionId = this.deps.getSessionId() ?? '';

    if (!sessionId) {
      throw new Error('Cannot create team without an active session');
    }

    const agents: AgentSpec[] = config.agents.map(a => ({ name: a.name, role: a.role }));

    // Fail-fast validation: resolve all three role slots up front so a configured-but-unresolvable/
    // unauthed slot (even a reviewer that may never spawn) blocks team creation before any agent starts.
    // The create_team tool wraps the thrown error into a TeamToolError surfaced to the calling model.
    for (const role of (['lead', 'implementor', 'reviewer'] as const)) {
      const resolution = this.deps.resolveRoleModel(role);
      if (resolution.error) throw new Error(resolution.error);
    }

    const permissionMode = this.permissionMode();

    const teamConfig: TeamConfig = {
      teamId,
      toolUseId,
      title: config.title,
      brief: config.brief,
      agents,
      cwd: this.deps.cwd,
      persistenceSessionId: sessionId,
      permissionMode,
      resolveRoleModel: (role) => this.deps.resolveRoleModel(role),
      engine: this.deps.buildEngine(),
    };

    const runner = new TeamRunner(teamConfig, (msg) => this.deps.onMessage(msg));

    this.setActiveTeam(teamId, runner);
    const unsettledKey = teamEventLogPath(piSessionDirOf(this.deps.cwd, sessionId), sessionId, teamId);
    unsettledTeams.add(unsettledKey);

    try {
      if (toolUseId) this.deps.recordInvocation({ kind: 'team', id: teamId, toolCallId: toolUseId, resume: false });

      const run = runner.run();
      this.lastRun = run;
      return this.formatResult(teamId, runner, await run);
    } finally {
      unsettledTeams.delete(unsettledKey);
      if (this.activeRunner === runner) {
        this.setActiveTeam(null, null);
      }
    }
  }

  /**
   * Continue a team this conversation started and a stop or lead failure interrupted, blocking until its synthesis
   * like `createTeam`. The id is claimed before the first await, so a parallel resume or create is
   * refused. Throws the validation errors verbatim.
   */
  async resumeTeam(teamId: string, message: string | undefined, toolCallId: string): Promise<string> {
    if (!isValidTeamId(teamId)) throw new Error(`"${teamId}" is not a valid team id.`);
    const known = agentInvocationsOnBranch(this.deps.parentBranch()).some((inv) => inv.kind === 'team' && inv.id === teamId);
    if (!known) throw new Error(`No team "${teamId}" in this conversation.`);
    if (this.activeTeamId === teamId) throw new Error(`Team "${teamId}" is still running.`);
    if (this.activeTeamId !== null) {
      throw new Error(`Another team is running in this panel; wait for it or cancel it before resuming "${teamId}".`);
    }
    const sessionId = this.deps.getSessionId();
    if (!sessionId) throw new Error('Cannot resume a team without an active session');
    const unsettledKey = teamEventLogPath(piSessionDirOf(this.deps.cwd, sessionId), sessionId, teamId);
    if (unsettledTeams.has(unsettledKey)) {
      throw new Error(`Team "${teamId}" is still running in another panel or shutting down; try again shortly.`);
    }
    unsettledTeams.add(unsettledKey);
    this.setActiveTeam(teamId, null);
    const claim: { stop: TeamStop | null } = { stop: null };
    this.resumeClaim = claim;
    const resumed = this.continueResume(teamId, sessionId, unsettledKey, claim, message, toolCallId);
    this.lastRun = resumed;
    return resumed;
  }

  /** The claimed part of `resumeTeam`: validation, the restored state's write, the launch and the wait for its synthesis. */
  private async continueResume(
    teamId: string,
    sessionId: string,
    unsettledKey: string,
    claim: { stop: TeamStop | null },
    message: string | undefined,
    toolCallId: string,
  ): Promise<string> {
    // Read through a call, so a stop that lands during an await is seen.
    const stopSoFar = (): TeamStop | null => claim.stop;
    const stoppedBeforeStart = (): Error => new Error(`The resume of team "${teamId}" was stopped before it started; it can still be resumed.`);
    try {
      const persistence = new TeamPersistence(this.deps.cwd, sessionId);
      const cannotResume = new Error(`Team "${teamId}" has no resume state (a conversation clear stopped it, or its checkpoint is missing) and cannot be resumed; start a new team.`);
      let log: TeamEventLog;
      try {
        log = await persistence.readEventLog(teamId);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw cannotResume;
        throw err;
      }
      if (log.finalStatus === 'completed') throw new Error(`Team "${teamId}" completed and cannot be resumed.`);
      const checkpoint = await persistence.resumableCheckpoint(log);
      if (!checkpoint) throw cannotResume;
      const files = await indexTeamMemberFiles(teamMembersDir(piSessionDirOf(this.deps.cwd, sessionId), sessionId, teamId));
      // A live checkpoint can trail the log, so a member's attempt is its latest spawn's when that is newer.
      const spawnAttempts = new Map(log.spawns.map((s) => [s.agentId, s.attempt]));
      const sessionFiles = new Map<string, string>();
      for (const member of checkpoint.members) {
        const attempt = checkpoint.live ? Math.max(member.attempt, spawnAttempts.get(member.agentId) ?? member.attempt) : member.attempt;
        const path = files.get(member.agentId)?.find((f) => f.attempt === attempt)?.path;
        if (path) sessionFiles.set(member.agentId, path);
      }

      const candidate = new TeamRunner({
        teamId,
        toolUseId: log.toolUseId,
        title: log.title,
        brief: log.brief,
        agents: log.agents,
        cwd: this.deps.cwd,
        persistenceSessionId: sessionId,
        permissionMode: this.permissionMode(),
        resolveRoleModel: (role) => this.deps.resolveRoleModel(role),
        engine: this.deps.buildEngine(),
      }, (msg) => this.deps.onMessage(msg));
      candidate.restore(log, checkpoint, sessionFiles);
      await candidate.dropDeliveredMessages();
      for (const [agentId, path] of candidate.reopenedSessionFiles()) this.deps.assertResumableModel(path, agentId);
      // Refused here, before the restored state is written, so the team stays resumable; the open's own check guards a later taker.
      const heldElsewhere = candidate.resumedMemberFiles().find(({ store }) => agentFileHeldElsewhere(store));
      if (heldElsewhere) {
        throw new Error(`Team "${teamId}" cannot resume yet: the session file of "${heldElsewhere.name}" is still open in another Damocles window, whose stopped run has not finished. Wait for that run to stop or close that window, then resume the team again.`);
      }
      // Before the first write: the checkpoint it came from stays the newest, as resumable as before, and nothing
      // under the session's folder is created after a delete removed it.
      if (stopSoFar() !== null) throw stoppedBeforeStart();
      if (!(await candidate.persistResumeCheckpoint())) {
        throw new Error(`Team "${teamId}" cannot resume: its resume state could not be saved under the new run.`);
      }

      // No await from here to the launch, so a cancel either stops the resume here or cancels the live team.
      const stop = stopSoFar();
      if (stop !== null) {
        // The restored state is the newest checkpoint now, so it carries the stop that cancelled the resume.
        await candidate.sealUnlaunchedResume(stop);
        throw stoppedBeforeStart();
      }
      this.deps.recordInvocation({ kind: 'team', id: teamId, toolCallId, resume: true });
      this.activeRunner = candidate;
      return this.formatResult(teamId, candidate, await candidate.resume(toolCallId, message));
    } finally {
      unsettledTeams.delete(unsettledKey);
      if (this.resumeClaim === claim) {
        this.resumeClaim = null;
        this.setActiveTeam(null, null);
      }
    }
  }

  private formatResult(teamId: string, runner: TeamRunner, result: TeamRunResult): string {
    const header = result.status === 'cancelled' ? teamCancelledHeader(teamId, result.stop, result.resumable)
      : result.status === 'failed' ? teamFailedHeader(teamId, result.failure, result.resumable)
        : '';
    return header + formatTeamUserSteerPrefix(runner.getOperatorSteers()) + result.text;
  }

  private permissionMode(): TeamPermissionMode {
    const rawMode = this.deps.getPermissionMode();
    return (rawMode === 'plan' || rawMode === 'acceptEdits') ? rawMode : 'default';
  }

  getTeamStatus(teamId: string): Record<string, unknown> | null {
    if (this.activeTeamId === teamId && this.activeRunner) {
      return this.activeRunner.getTeamStatus();
    }
    return null;
  }

  /**
   * A member of the team running in this panel whose run is subscribed: the attempt its run holds and a reader of its
   * transcript from the messages pi holds, which a caller reads in the same synchronous step as it posts them. The reader
   * gives undefined once no run of that attempt is subscribed. Null otherwise.
   */
  liveMember(teamId: string, agentId: string): { readonly attempt: number; read: () => MemberTranscript | undefined } | null {
    const runner = this.activeTeamId === teamId ? this.activeRunner : null;
    const source = runner?.memberTranscript(agentId);
    if (!runner || !source) return null;
    return {
      attempt: source.attempt,
      read: () => {
        const now = this.activeRunner === runner ? runner.memberTranscript(agentId) : undefined;
        return now?.attempt === source.attempt ? now.read() : undefined;
      },
    };
  }

  /** The card of the team running in this panel, or null when `teamId` is not it. */
  liveTeamState(teamId: string): WebviewTeamState | null {
    return this.activeTeamId === teamId && this.activeRunner ? this.activeRunner.getTeamState() : null;
  }

  /** The user's Stop team, from the team's card or overlay or the lead's Stop. */
  stopTeam(teamId: string): boolean {
    return this.stopRunningTeam(teamId, 'user');
  }

  /** The `cancel_team` tool's result. Rejects when the team is not the one running here. */
  async cancelTeam(teamId: string): Promise<string> {
    if (this.activeTeamId !== teamId) throw new Error(`Team "${teamId}" is not running.`);
    const runner = this.activeRunner;
    if (!this.stopRunningTeam(teamId, 'parent')) return `Team "${teamId}" had already finished, so nothing was cancelled.`;
    // With no runner the resume was still validating, and it leaves the team as resumable as it found it.
    const resumable = runner ? await runner.resumableCheckpointLanded() : true;
    return `${teamCancelledHeader(teamId, 'parent', resumable)}Team "${teamId}" cancelled.`;
  }

  /**
   * The one stop of a named team, shared by the user's Stop team and the `cancel_team` tool. It leaves the
   * team resumable, and its blocked `create_team` or `resume_team` call returns the partial results, so
   * the parent turn goes on. False when `teamId` is not running here or had already finished.
   */
  private stopRunningTeam(teamId: string, stop: 'user' | 'parent'): boolean {
    if (this.activeTeamId !== teamId || !this.cancelActiveTeam(stop)) return false;
    this.deps.requestInterruptionCheck();
    return true;
  }

  /**
   * True when it stopped an unfinished team, or a resume before it launched. The first stop of a run names
   * its cause. Every stop but 'reset' keeps the team resumable; a 'reset' stop discards the conversation
   * that could resume it, so its seal is one no resume accepts.
   */
  cancelActiveTeam(stop: TeamStop): boolean {
    if (this.resumeClaim) this.resumeClaim.stop ??= stop;
    if (this.activeRunner) return this.activeRunner.cancel(stop);
    return this.activeTeamId !== null;
  }

  /** Settles once the latest team run, cancelled or not, or a resume still validating, has finished writing its files. */
  whenRunSettled(): Promise<void> {
    return this.lastRun.then(() => undefined, () => undefined);
  }

  listSteerTargets(): SteerTargetInfo[] {
    return this.activeRunner?.listSteerTargets() ?? [];
  }

  /** The running team that has member `agentId`, with its title and the member's name; null when none has. */
  memberOf(agentId: string): { teamId: string; teamTitle: string; agentName: string } | null {
    const { activeTeamId: teamId, activeRunner: runner } = this;
    const member = teamId ? runner?.getMember(agentId) : undefined;
    return teamId && runner && member ? { teamId, teamTitle: runner.getTitle(), agentName: member.name } : null;
  }

  /** `null` when no running team has this member, so the caller can report its own not-found. */
  steerMember(agentId: string, message: string, images?: ImageBlock[]): { status: 'steered' | 'finished' | 'not-found'; teamId: string; teamTitle: string; memberName: string; role: 'lead' | 'specialist' } | null {
    const runner = this.activeRunner;
    if (!runner || !this.activeTeamId) return null;
    const member = runner.getMember(agentId);
    if (!member) return null;
    return {
      status: runner.steerMember(agentId, message, images),
      teamId: this.activeTeamId,
      teamTitle: runner.getTitle(),
      memberName: member.name,
      role: member.role,
    };
  }

  /** Stops one specialist; the lead stops only with its team, through `stopTeam`. */
  cancelAgent(teamId: string, agentId: string): void {
    if (this.activeTeamId === teamId && this.activeRunner) {
      this.activeRunner.cancelAgent(agentId);
    }
  }

  /**
   * Stops the team as a 'shutdown' and resolves once its seal is on disk, or once a resume still validating has
   * settled. VS Code's `deactivate` and desktop's quit await a panel's dispose, so the cause lands before the process exits.
   */
  async dispose(): Promise<void> {
    const runner = this.activeRunner;
    this.cancelActiveTeam('shutdown');
    this.setActiveTeam(null, null);
    this.resumeClaim = null;
    this.pendingToolUseId = null;
    await (runner ? runner.flushCheckpoint() : this.whenRunSettled());
  }
}
