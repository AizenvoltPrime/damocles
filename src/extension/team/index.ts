import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { TeamRunner } from './team-runner';
import { TeamPersistence } from './persistence';
import type { TeamConfig, AgentSpec, TeamPermissionMode, TeamEngine, ResolvedTeamModel, TeamRole, TeamRunResult, TeamEventLog } from './types';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { SteerTargetInfo } from '../../shared/types/subagents';
import type { TeamState as WebviewTeamState } from '../../shared/types/team';
import { agentInvocationsOnBranch, indexTeamMemberFiles, teamEventLogPath, teamMembersDir, type AgentInvocationData } from '../pi-session/agent-records';
import { piSessionDir } from '../pi-session/session-store';
import { formatTeamUserSteerPrefix } from '../../shared/steer';

/** Team ids are exactly what `crypto.randomUUID()` returns; `isValidTeamId` checks that format. */
export function newTeamId(): string {
  return crypto.randomUUID();
}

const TEAM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isValidTeamId(id: string): boolean {
  return TEAM_ID.test(id);
}

/** Heads the result of a team that stopped on a cancel, so the parent knows whether it can offer to continue it. */
export function teamCancelledHeader(teamId: string, resumable: boolean): string {
  return resumable
    ? `(TEAM CANCELLED before completion; results are partial. Resume it with resume_team({team_id:"${teamId}"}) if the user asks to continue.)\n\n`
    : '(TEAM CANCELLED before completion; results are partial. Its resume state was not saved, so it cannot be resumed.)\n\n';
}

// Keyed by event log path, across every panel of this window: a team whose run has not settled, draining
// included, is still writing its files and must not get a second writer.
const unsettledTeams = new Set<string>();

/**
 * Per-panel team coordinator (US-024d). Constructed on the pi path by `session-manager.ts` and handed to
 * `PiSession` via `SessionOptions.teamService`; the `create_team` tool drives `createTeam`, which awaits
 * `TeamRunner.run()` and returns the synthesis as the tool result (BLOCKING contract). One team per panel
 * (the `activeTeamId` claim throws), and `resumeTeam` continues a cancelled one the same blocking way. PiSession supplies the pi-native engine + model resolvers via `deps`
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
  // Identifies the resume holding the claim, so a resume that outlived a dispose never releases a newer claim.
  private resumeClaim: object | null = null;
  // Bumped by every cancel, so a resume that was validating when the user cancelled never launches.
  private cancelEpoch = 0;
  // Settles only after the team's drain and final event-log writes, so it is what a folder delete waits on.
  private lastRun: Promise<unknown> = Promise.resolve();
  private readonly deps: TeamServiceDeps;

  constructor(deps: TeamServiceDeps) {
    this.deps = deps;
  }

  get isEnabled(): boolean {
    return vscode.workspace.getConfiguration('damocles').get<boolean>('team.enabled', false);
  }

  setPendingToolUseId(toolUseId: string): void {
    this.pendingToolUseId = toolUseId;
  }

  /**
   * Team-agent permission responses (`teamAgentPermissionResponse`) are handled by the central permission
   * gate (inherit-parent-mode), so there is no per-team prompt to resolve — this is a no-op.
   */
  resolvePermission(_requestId: string, _behavior: 'allow' | 'deny'): void {
    // Intentionally empty — pi team permissions are handled by the central gate.
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

    this.activeRunner = runner;
    this.activeTeamId = teamId;
    const unsettledKey = teamEventLogPath(piSessionDir(this.deps.cwd), sessionId, teamId);
    unsettledTeams.add(unsettledKey);

    try {
      if (toolUseId) this.deps.recordInvocation({ kind: 'team', id: teamId, toolCallId: toolUseId, resume: false });

      const run = runner.run();
      this.lastRun = run;
      return this.formatResult(teamId, runner, await run);
    } finally {
      unsettledTeams.delete(unsettledKey);
      if (this.activeRunner === runner) {
        this.activeRunner = null;
        this.activeTeamId = null;
      }
    }
  }

  /**
   * Continue a team this conversation started and a cancel interrupted, blocking until its synthesis
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
    const unsettledKey = teamEventLogPath(piSessionDir(this.deps.cwd), sessionId, teamId);
    if (unsettledTeams.has(unsettledKey)) {
      throw new Error(`Team "${teamId}" is still running in another panel or shutting down; try again shortly.`);
    }
    unsettledTeams.add(unsettledKey);
    this.activeTeamId = teamId;
    const claim = {};
    this.resumeClaim = claim;
    const epoch = this.cancelEpoch;
    try {
      const persistence = new TeamPersistence(this.deps.cwd, sessionId);
      const cannotResume = new Error(`Team "${teamId}" did not end in a user cancel (or its resume state is missing) and cannot be resumed; start a new team.`);
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
      const files = await indexTeamMemberFiles(teamMembersDir(piSessionDir(this.deps.cwd), sessionId, teamId));
      const sessionFiles = new Map<string, string>();
      for (const member of checkpoint.members) {
        const path = files.get(member.agentId)?.find((f) => f.attempt === member.attempt)?.path;
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
      for (const [agentId, path] of candidate.reopenedSessionFiles()) this.deps.assertResumableModel(path, agentId);

      // No await from here to the launch, so a cancel either stops the resume here or cancels the live team.
      if (epoch !== this.cancelEpoch) {
        throw new Error(`The resume of team "${teamId}" was stopped before it started; it can still be resumed.`);
      }
      this.deps.recordInvocation({ kind: 'team', id: teamId, toolCallId, resume: true });
      this.activeRunner = candidate;
      const run = candidate.resume(toolCallId, message);
      this.lastRun = run;
      return this.formatResult(teamId, candidate, await run);
    } finally {
      unsettledTeams.delete(unsettledKey);
      if (this.resumeClaim === claim) {
        this.resumeClaim = null;
        this.activeRunner = null;
        this.activeTeamId = null;
      }
    }
  }

  private formatResult(teamId: string, runner: TeamRunner, result: TeamRunResult): string {
    const header = result.status === 'cancelled' ? teamCancelledHeader(teamId, result.resumable) : '';
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

  /** The card of the team running in this panel, or null when `teamId` is not it. */
  liveTeamState(teamId: string): WebviewTeamState | null {
    return this.activeTeamId === teamId && this.activeRunner ? this.activeRunner.getTeamState() : null;
  }

  /** The `cancel_team` tool's result. Throws when the team is not the one running here. */
  cancelTeam(teamId: string): string {
    if (this.activeTeamId !== teamId) throw new Error(`Team "${teamId}" is not running.`);
    const runner = this.activeRunner;
    if (!this.cancelActiveTeam()) return `Team "${teamId}" had already finished, so nothing was cancelled.`;
    this.deps.requestInterruptionCheck();
    // With no runner the resume was still validating, so the checkpoint it read is unused.
    return `${teamCancelledHeader(teamId, runner?.hasCheckpoint() ?? true)}Team "${teamId}" cancelled.`;
  }

  /**
   * True when it stopped an unfinished team, or a resume before it launched. A 'user' stop keeps the team
   * resumable; a 'reset' stop discards the conversation that could resume it, so it writes no checkpoint.
   */
  cancelActiveTeam(stop: 'user' | 'reset' = 'user'): boolean {
    this.cancelEpoch++;
    if (this.activeRunner) return this.activeRunner.cancel(stop);
    return this.activeTeamId !== null;
  }

  /** Settles once the latest team run, cancelled or not, has finished writing its files. */
  whenRunSettled(): Promise<void> {
    return this.lastRun.then(() => undefined, () => undefined);
  }

  listSteerTargets(): SteerTargetInfo[] {
    return this.activeRunner?.listSteerTargets() ?? [];
  }

  /** `null` when no running team has this member, so the caller can report its own not-found. */
  steerMember(agentId: string, message: string): { status: 'steered' | 'finished' | 'not-found'; teamId: string; teamTitle: string; memberName: string; role: 'lead' | 'specialist' } | null {
    const runner = this.activeRunner;
    if (!runner || !this.activeTeamId) return null;
    const member = runner.getMember(agentId);
    if (!member) return null;
    return {
      status: runner.steerMember(agentId, message),
      teamId: this.activeTeamId,
      teamTitle: runner.getTitle(),
      memberName: member.name,
      role: member.role,
    };
  }

  cancelAgent(teamId: string, agentId: string): void {
    if (this.activeTeamId === teamId && this.activeRunner) {
      this.activeRunner.cancelAgent(agentId);
    }
  }

  dispose(): void {
    this.cancelActiveTeam();
    this.activeRunner = null;
    this.activeTeamId = null;
    this.resumeClaim = null;
    this.pendingToolUseId = null;
  }
}
