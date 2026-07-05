import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { TeamRunner } from './team-runner';
import { TeamPersistence } from './persistence';
import type { TeamConfig, AgentSpec, TeamPermissionMode, TeamEngine, ResolvedTeamModel, SpecialistKind } from './types';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';

/**
 * Per-panel team coordinator (US-024d). Constructed on the pi path by `session-manager.ts` and handed to
 * `PiSession` via `SessionOptions.teamService`; the `create_team` tool drives `createTeam`, which awaits
 * `TeamRunner.run()` and returns the synthesis as the tool result (BLOCKING contract). One team per panel
 * (the `activeRunner` guard throws). PiSession supplies the pi-native engine + model resolvers via `deps`
 * — this module is provider-agnostic (no SDK, no Anthropic-only lead model).
 */
export interface TeamServiceDeps {
  cwd: string;
  onMessage: (msg: ExtensionToWebviewMessage) => void;
  /** The panel's current session id (team transcripts are scoped under it). */
  getSessionId: () => string | null;
  /** The panel's current permission mode (default/acceptEdits/plan). */
  getPermissionMode: () => string;
  /** Resolve the lead model — the flagship authed model of the active provider (US-024c). */
  resolveLeadModel: () => ResolvedTeamModel;
  /** Resolve a specialist model — explicit (if authed) else the active panel model (US-024c). `kind`
   *  sets the Anthropic thinking depth; ignored on other backends. */
  resolveSpecialistModel: (value: string | undefined, kind?: SpecialistKind) => ResolvedTeamModel;
  /** The curated specialist model values the spawn tool advertises/validates for the active provider. */
  allowedSpecialistModels: () => readonly string[];
  /** Whether specialist models are policy-forced (Anthropic): the spawn tool ignores an explicit `model`. */
  specialistModelForced: () => boolean;
  /** Build the pi-native session/tools/gate/cost engine for a team run. */
  buildEngine: () => TeamEngine;
}

export class TeamService {
  private pendingToolUseId: string | null = null;
  private activeRunner: TeamRunner | null = null;
  private activeTeamId: string | null = null;
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
    agents: Array<{ name: string; role: 'lead' | 'specialist'; model: string | undefined }>;
  }): Promise<string> {
    if (this.activeRunner) {
      throw new Error('A team is already running in this panel');
    }

    const teamId = crypto.randomUUID();
    const toolUseId = this.pendingToolUseId ?? '';
    this.pendingToolUseId = null;
    const sessionId = this.deps.getSessionId() ?? '';

    if (!sessionId) {
      throw new Error('Cannot create team without an active session');
    }

    const agents: AgentSpec[] = config.agents.map(a => ({
      name: a.name,
      role: a.role,
      // The lead model is resolved at spawn time by the runner (flagship-per-provider); specialists carry
      // their explicit value (or undefined → active model), resolved per-spawn.
      ...(a.role === 'specialist' && a.model !== undefined ? { model: a.model } : {}),
    }));

    const rawMode = this.deps.getPermissionMode();
    const permissionMode: TeamPermissionMode =
      (rawMode === 'plan' || rawMode === 'acceptEdits')
        ? rawMode
        : 'default';

    const teamConfig: TeamConfig = {
      teamId,
      toolUseId,
      title: config.title,
      brief: config.brief,
      agents,
      cwd: this.deps.cwd,
      persistenceSessionId: sessionId,
      permissionMode,
      resolveLeadModel: () => this.deps.resolveLeadModel(),
      resolveSpecialistModel: (value, kind) => this.deps.resolveSpecialistModel(value, kind),
      allowedSpecialistModels: this.deps.allowedSpecialistModels(),
      specialistModelForced: this.deps.specialistModelForced(),
      engine: this.deps.buildEngine(),
    };

    const runner = new TeamRunner(teamConfig, (msg) => this.deps.onMessage(msg));

    this.activeRunner = runner;
    this.activeTeamId = teamId;

    try {
      if (sessionId && toolUseId) {
        const persistence = new TeamPersistence(this.deps.cwd, sessionId);
        await persistence.writeTeamCorrelation(sessionId, toolUseId, teamId);
      }

      const result = await runner.run();
      return result;
    } finally {
      this.activeRunner = null;
      this.activeTeamId = null;
    }
  }

  getTeamStatus(teamId: string): Record<string, unknown> | null {
    if (this.activeTeamId === teamId && this.activeRunner) {
      return this.activeRunner.getTeamStatus();
    }
    return null;
  }

  cancelTeam(teamId: string): void {
    if (this.activeTeamId === teamId && this.activeRunner) {
      this.activeRunner.cancel();
    }
  }

  cancelActiveTeam(): void {
    if (this.activeRunner) {
      this.activeRunner.cancel();
    }
  }

  cancelAgent(teamId: string, agentId: string): void {
    if (this.activeTeamId === teamId && this.activeRunner) {
      this.activeRunner.cancelAgent(agentId);
    }
  }

  dispose(): void {
    if (this.activeRunner) {
      this.activeRunner.cancel();
      this.activeRunner = null;
      this.activeTeamId = null;
    }
    this.pendingToolUseId = null;
  }
}
