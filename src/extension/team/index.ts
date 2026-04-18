import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { TeamRunner, LEAD_MODEL } from './team-runner';
import { TeamPersistence } from './persistence';
import { createTeamMainMcpServer, createTeamAgentMcpServer } from './mcp-server';
import type { TeamConfig, AgentSpec, TeamPermissionMode } from './types';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';

type SdkCreateServer = typeof import('@anthropic-ai/claude-agent-sdk').createSdkMcpServer;
type SdkTool = typeof import('@anthropic-ai/claude-agent-sdk').tool;
type ZodZ = typeof import('zod').z;

interface McpModules {
  createSdkMcpServer: SdkCreateServer;
  tool: SdkTool;
  z: ZodZ;
}

export interface TeamServiceDeps {
  cwd: string;
  onMessage: (msg: ExtensionToWebviewMessage) => void;
  getSessionId: () => string | null;
  getModel: () => string;
  getPermissionMode: () => string;
  getCompassContext?: () => { mcpServer: unknown; promptSuffix: string } | null;
}

export class TeamService {
  private mcpModules: McpModules | null = null;
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
    const toolUseId = this.pendingToolUseId ?? '';
    this.pendingToolUseId = null;
    const sessionId = this.deps.getSessionId() ?? '';

    if (!sessionId) {
      throw new Error('Cannot create team without an active session');
    }
    const currentModel = this.deps.getModel();

    const agents: AgentSpec[] = config.agents.map(a => ({
      name: a.name,
      role: a.role,
      model: a.role === 'lead' ? LEAD_MODEL : (a.model ?? currentModel),
    }));

    const rawMode = this.deps.getPermissionMode();
    const permissionMode: TeamPermissionMode =
      (rawMode === 'plan' || rawMode === 'acceptEdits' || rawMode === 'auto')
        ? rawMode
        : 'default';

    const compass = this.deps.getCompassContext?.() ?? null;

    const teamConfig: TeamConfig = {
      teamId,
      toolUseId,
      title: config.title,
      agents,
      cwd: this.deps.cwd,
      persistenceSessionId: sessionId,
      permissionMode,
      ...(compass ? { additionalMcpServers: { 'damocles-compass': compass.mcpServer } } : {}),
      ...(compass ? { systemPromptSuffix: compass.promptSuffix } : {}),
    };

    const onMessage = (msg: ExtensionToWebviewMessage) => {
      this.deps.onMessage(msg);
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
    this.pendingToolUseId = null;
  }
}
