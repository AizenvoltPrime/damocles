import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { log } from '../logger';
import { TeamRunner } from './team-runner';
import { TeamPersistence } from './persistence';
import { createTeamMainMcpServer, createTeamAgentMcpServer } from './mcp-server';
import type { TeamConfig, AgentSpec, TeamPermissionMode } from './types';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { TeamState } from '../../shared/types/team';

type SdkCreateServer = typeof import('@anthropic-ai/claude-agent-sdk').createSdkMcpServer;
type SdkTool = typeof import('@anthropic-ai/claude-agent-sdk').tool;
type ZodZ = typeof import('zod').z;

interface McpModules {
  createSdkMcpServer: SdkCreateServer;
  tool: SdkTool;
  z: ZodZ;
}

export class TeamService {
  private readonly cwd: string;
  private mcpModules: McpModules | null = null;
  private onMessageCallback: ((msg: ExtensionToWebviewMessage) => void) | null = null;
  private pendingToolUseIds: string[] = [];
  private activeRunner: TeamRunner | null = null;
  private activeTeamId: string | null = null;
  private getSessionId: (() => string | null) | null = null;
  private getModel: (() => string) | null = null;
  private getPermissionMode: (() => string) | null = null;
  private compassMcpServer: unknown | null = null;
  private compassPromptSuffix: string | null = null;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  get isEnabled(): boolean {
    return vscode.workspace.getConfiguration('damocles').get<boolean>('team.enabled', false);
  }

  setOnMessage(callback: (msg: ExtensionToWebviewMessage) => void): void {
    this.onMessageCallback = callback;
  }

  setPendingToolUseId(toolUseId: string): void {
    this.pendingToolUseIds.push(toolUseId);
  }

  setSessionIdGetter(getter: () => string | null): void {
    this.getSessionId = getter;
  }

  setModelGetter(getter: () => string): void {
    this.getModel = getter;
  }

  setPermissionModeGetter(getter: () => string): void {
    this.getPermissionMode = getter;
  }

  setCompassMcp(mcpServer: unknown, promptSuffix: string): void {
    this.compassMcpServer = mcpServer;
    this.compassPromptSuffix = promptSuffix;
  }

  getMcpServerConfig(): unknown {
    if (!this.isEnabled) return null;

    try {
      if (!this.mcpModules) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const sdk = require('@anthropic-ai/claude-agent-sdk') as typeof import('@anthropic-ai/claude-agent-sdk');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const zod = require('zod') as typeof import('zod');
        this.mcpModules = { createSdkMcpServer: sdk.createSdkMcpServer, tool: sdk.tool, z: zod.z };
      }
      const { createSdkMcpServer, tool, z } = this.mcpModules;

      return createTeamMainMcpServer(
        {
          createTeam: (config) => this.createTeam(config),
          getTeamStatus: (teamId) => this.getTeamStatus(teamId),
          cancelTeam: (teamId) => this.cancelTeam(teamId),
        },
        createSdkMcpServer,
        tool,
        z,
      );
    } catch {
      return null;
    }
  }

  async createTeam(config: {
    title: string;
    agents: Array<{ name: string; role: 'lead' | 'specialist'; model: string | undefined }>;
  }): Promise<string> {
    if (this.activeRunner) {
      throw new Error('A team is already running in this panel');
    }

    const teamId = crypto.randomUUID();
    const toolUseId = this.pendingToolUseIds.shift() ?? '';
    const sessionId = this.getSessionId?.() ?? '';

    if (!sessionId) {
      throw new Error('Cannot create team without an active session');
    }
    const currentModel = this.getModel?.() ?? '';

    const agents: AgentSpec[] = config.agents.map(a => ({
      name: a.name,
      role: a.role,
      model: a.model ?? currentModel,
    }));

    const rawMode = this.getPermissionMode?.() ?? 'default';
    const permissionMode: TeamPermissionMode =
      (rawMode === 'plan' || rawMode === 'acceptEdits' || rawMode === 'auto')
        ? rawMode
        : 'default';

    const teamConfig: TeamConfig = {
      teamId,
      toolUseId,
      title: config.title,
      agents,
      cwd: this.cwd,
      persistenceSessionId: sessionId,
      permissionMode,
      ...(this.compassMcpServer ? { additionalMcpServers: { 'damocles-compass': this.compassMcpServer } } : {}),
      ...(this.compassPromptSuffix ? { systemPromptSuffix: this.compassPromptSuffix } : {}),
    };

    const onMessage = (msg: ExtensionToWebviewMessage) => {
      this.onMessageCallback?.(msg);
    };

    if (!this.mcpModules) {
      throw new Error('MCP modules not loaded');
    }
    const { createSdkMcpServer, tool, z } = this.mcpModules;

    const runner = new TeamRunner(
      teamConfig,
      onMessage,
      (ctx) => createTeamAgentMcpServer(ctx, createSdkMcpServer, tool, z),
    );

    this.activeRunner = runner;
    this.activeTeamId = teamId;

    try {
      if (sessionId && toolUseId) {
        const persistence = new TeamPersistence(this.cwd, sessionId);
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

  async loadTeamFromHistory(teamId: string, explicitSessionId?: string): Promise<TeamState | null> {
    const sessionId = explicitSessionId ?? this.getSessionId?.() ?? '';
    if (!sessionId) {
      log('[TeamService] loadTeamFromHistory: no session ID available for team %s', teamId);
      return null;
    }
    const persistence = new TeamPersistence(this.cwd, sessionId);
    return persistence.loadTeamState(teamId);
  }

  async loadAgentConversation(teamId: string, agentId: string, explicitSessionId?: string): Promise<import('../../shared/types/team').TeamAgentContentBlock[][]> {
    const sessionId = explicitSessionId ?? this.getSessionId?.() ?? '';
    if (!sessionId) {
      log('[TeamService] loadAgentConversation: no session ID available for agent %s in team %s', agentId, teamId);
      return [];
    }
    const persistence = new TeamPersistence(this.cwd, sessionId);
    return persistence.loadAgentConversation(teamId, agentId);
  }

  cancelAgent(teamId: string, agentId: string): void {
    if (this.activeTeamId === teamId && this.activeRunner) {
      this.activeRunner.cancelAgent(agentId);
    }
  }

  resolvePermission(requestId: string, behavior: 'allow' | 'deny'): void {
    if (this.activeRunner) {
      this.activeRunner.resolvePermission(requestId, behavior);
    }
  }

  dispose(): void {
    if (this.activeRunner) {
      this.activeRunner.cancel();
      this.activeRunner = null;
      this.activeTeamId = null;
    }
    this.pendingToolUseIds.length = 0;
  }
}
