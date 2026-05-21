import * as crypto from 'crypto';
import * as path from 'path';
import { getSessionDir } from '../session/paths';
import { MessageBus } from './message-bus';
import { Scratchpad } from './scratchpad';
import { AgentRunner } from './agent-runner';
import { TeamPersistence } from './persistence';
import { buildLeadSystemPrompt, buildSpecialistSystemPrompt } from './prompts';
import type { DomainProfile } from './prompts';
import {
  checkApprovalReadGate,
  formatReviewRoundReadyNotification,
} from './review-gate';
import { AGENT_PROFILE_MAP, AGENT_PROFILE_CATALOG } from './agent-profiles.generated';
import type {
  TeamConfig,
  AgentRunConfig,
  AgentResult,
  AgentMcpContext,
  TeamAgent,
  TeamPhase,
  TeamStatus,
} from './types';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { TeamState, TeamAgent as WebviewTeamAgent } from '../../shared/types/team';

const MAX_AGENTS = 5;
const SPECIALIST_DRAIN_TIMEOUT_MS = 30_000;
const MAX_SPECIALIST_REVIEW_ROUNDS = 2;
const KEEPALIVE_TIMEOUT_MS = 600_000;

/** Lead model auto-selected by panel backend. Suffix is Anthropic-only and stripped for OpenAI by resolveSdkModel(). */
export const ANTHROPIC_LEAD_MODEL = 'claude-opus-4-7[1m]';
export const OPENAI_LEAD_MODEL = 'gpt-5.5';

/** Tier-aligned specialist whitelist. Opus/Sonnet/Haiku ↔ gpt-5.5/gpt-5.4/gpt-5.4-mini. */
const ANTHROPIC_SPECIALIST_MODELS = ['claude-opus-4-7[1m]', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001'] as const;
const OPENAI_SPECIALIST_MODELS = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini'] as const;

export function resolveAllowedSpecialistModels(backend: 'anthropic' | 'openai'): readonly string[] {
  return backend === 'openai' ? OPENAI_SPECIALIST_MODELS : ANTHROPIC_SPECIALIST_MODELS;
}

interface CreateAgentMcpServer {
  (context: AgentMcpContext): unknown;
}

export class TeamRunner {
  private readonly config: TeamConfig;
  private readonly onMessage: (msg: ExtensionToWebviewMessage) => void;
  private readonly createAgentMcpServer: CreateAgentMcpServer;

  private messageBus!: MessageBus;
  private scratchpad!: Scratchpad;
  private persistence!: TeamPersistence;
  private agentRunner = new AgentRunner();

  private agents = new Map<string, TeamAgent>();
  private specialistPromises = new Map<string, Promise<AgentResult>>();
  private specialistAborts = new Map<string, AbortController>();
  private phase: TeamPhase = 'initializing';
  private status: TeamStatus = 'running';
  private teamAbort = new AbortController();
  private completionResolve: ((result: string) => void) | null = null;
  private completionResolved = false;
  private cachedSessionDir: string | null = null;
  private cancelAttempts = new Map<string, number>();
  private cancellationTimestamps = new Map<string, number>();
  private specialistReviewRounds = new Map<string, number>();
  private reviewedSpecialists = new Set<string>();
  private pendingStandby = new Set<string>();
  private confirmedComplete = new Set<string>();
  private pendingPermissions = new Map<string, { resolve: (behavior: 'allow' | 'deny') => void }>();

  private static readonly SAFE_TOOLS = new Set([
    'Read', 'Glob', 'Grep', 'ToolSearch', 'WebSearch', 'WebFetch',
  ]);

  constructor(
    config: TeamConfig,
    onMessage: (msg: ExtensionToWebviewMessage) => void,
    createAgentMcpServer: CreateAgentMcpServer,
  ) {
    this.config = config;
    this.onMessage = onMessage;
    this.createAgentMcpServer = createAgentMcpServer;
  }

  async run(): Promise<string> {
    this.messageBus = new MessageBus(this.config.teamId);
    this.scratchpad = new Scratchpad();
    this.persistence = new TeamPersistence(this.config.cwd, this.config.persistenceSessionId);

    await this.persistence.initTeamFile(this.config.teamId);
    this.cachedSessionDir = await getSessionDir(this.config.cwd);

    this.persistence.appendTeamEntry({
      type: 'team-created',
      teamId: this.config.teamId,
      toolUseId: this.config.toolUseId,
      title: this.config.title,
      agents: this.config.agents,
      timestamp: new Date().toISOString(),
    });

    this.messageBus.subscribe((msg) => {
      this.persistence.appendTeamEntry({
        type: 'agent-message',
        teamId: this.config.teamId,
        messageId: msg.messageId,
        from: msg.from,
        to: msg.to,
        content: msg.content,
        timestamp: new Date(msg.timestamp).toISOString(),
      });

      const senderAgent = this.findAgentByName(msg.from);
      const recipientAgent = msg.to ? this.findAgentByName(msg.to) : null;
      this.onMessage({
        type: 'teamMessage',
        teamId: this.config.teamId,
        message: {
          messageId: msg.messageId,
          senderAgentId: senderAgent?.agentId ?? '',
          senderName: msg.from,
          recipientAgentId: recipientAgent?.agentId ?? null,
          recipientName: msg.to,
          content: msg.content,
          timestamp: msg.timestamp,
        },
      });
    });

    this.scratchpad.subscribe((entry) => {
      this.persistence.appendTeamEntry({
        type: 'scratchpad-update',
        teamId: this.config.teamId,
        section: entry.section,
        content: entry.content,
        author: entry.author,
        version: entry.version,
        timestamp: new Date(entry.timestamp).toISOString(),
      });

      const authorAgent = this.findAgentByName(entry.author);
      this.onMessage({
        type: 'teamScratchpadUpdate',
        teamId: this.config.teamId,
        entry: {
          section: entry.section,
          content: entry.content,
          agentId: authorAgent?.agentId ?? '',
          agentName: entry.author,
          version: entry.version,
          timestamp: entry.timestamp,
        },
      });

      this.messageBus.broadcast(
        entry.author,
        `[Scratchpad update] "${entry.section}" updated by ${entry.author} (v${entry.version})`,
      );
    });

    this.scratchpad.subscribeRejection((rejection) => {
      this.persistence.appendTeamEntry({
        type: 'scratchpad-ownership-rejected',
        teamId: this.config.teamId,
        section: rejection.section,
        attemptedBy: rejection.attemptedBy,
        owner: rejection.owner,
        reason: rejection.reason,
        timestamp: new Date(rejection.timestamp).toISOString(),
      });
      console.error(
        `[Scratchpad] "${rejection.attemptedBy}" attempted to overwrite "${rejection.section}" owned by "${rejection.owner}" — rejected`,
      );
      this.messageBus.broadcast(
        'system',
        `[Scratchpad] "${rejection.attemptedBy}" attempted to overwrite "${rejection.section}" (owned by "${rejection.owner}") — rejected`,
      );
    });

    const leadModel = this.config.resolveLeadModel();

    const seenNames = new Set<string>();
    for (const spec of this.config.agents) {
      if (seenNames.has(spec.name)) {
        throw new Error(`Duplicate agent name: "${spec.name}"`);
      }
      if (spec.name.length === 0 || spec.name.length > 50) {
        throw new Error(`Agent name must be 1-50 characters: "${spec.name}"`);
      }
      seenNames.add(spec.name);

      this.agents.set(spec.name, {
        agentId: crypto.randomUUID(),
        teamId: this.config.teamId,
        name: spec.name,
        role: spec.role,
        specialization: spec.specialization ?? '',
        status: 'pending',
        model: spec.role === 'lead' ? leadModel : (spec.model ?? ''),
        profileId: null,
        startTime: null,
        endTime: null,
        toolCallCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        finalResponse: null,
        error: null,
        logFilePath: null,
      });
    }

    this.emitTeamStarted();

    const completionPromise = new Promise<string>((resolve) => {
      this.completionResolve = resolve;
    });

    const leadSpec = this.config.agents.find(a => a.role === 'lead');
    if (!leadSpec) {
      throw new Error('Team must have exactly one lead agent');
    }

    this.setPhase('spawning');

    const leadAgent = this.agents.get(leadSpec.name)!;
    const specialists = this.config.agents.filter(a => a.role === 'specialist');
    let leadPrompt = buildLeadSystemPrompt(this.config.title, specialists, AGENT_PROFILE_CATALOG || undefined, this.config.permissionMode);
    if (this.config.systemPromptSuffix) leadPrompt += '\n\n' + this.config.systemPromptSuffix;

    const leadMcp = this.createAgentMcpServer({
      agentId: leadAgent.agentId,
      agentName: leadSpec.name,
      role: 'lead',
      allowedSpecialistModels: this.config.allowedSpecialistModels,
      messageBus: this.messageBus,
      scratchpad: this.scratchpad,
      startSpecialist: (name, task, model, profileId) => this.startSpecialist(name, task, model, profileId),
      synthesizeResult: (result) => this.synthesizeResult(result),
      cancelSpecialist: (name) => this.cancelSpecialist(name),
      getActiveSpecialistNames: () => this.getActiveSpecialistNames(),
      getPendingSpecialistNames: () => this.getPendingSpecialistNames(),
      getTeamStatus: () => this.getTeamStatus(),
      getAgentNames: () => [...this.agents.keys()],
      requestRevision: (name, feedback) => this.requestRevision(name, feedback),
      approveSpecialist: (name) => this.approveSpecialist(name),
      getUnreviewedSpecialistNames: () => this.getUnreviewedSpecialistNames(),
      isReviewRoundReady: () => this.isReviewRoundReady(),
      getNonSettledSpecialistDetails: () => this.getNonSettledSpecialistDetails(),
      getAllAgents: () => [...this.agents.values()],
      enterStandby: () => { throw new Error('Lead cannot enter standby'); },
      reportComplete: () => { throw new Error('Lead cannot report complete'); },
      recordCancelAttempt: (name) => this.cancelAttempts.set(name, Date.now()),
      getCancelAttemptTimestamp: (name) => this.cancelAttempts.get(name),
      getRecentlyCancelledNames: () => {
        const now = Date.now();
        return [...this.cancellationTimestamps.entries()]
          .filter(([, ts]) => now - ts < 30_000)
          .map(([name]) => name);
      },
    });

    await this.persistence.initAgentFile(this.config.teamId, leadAgent.agentId);

    leadAgent.status = 'running';
    leadAgent.startTime = Date.now();
    if (this.cachedSessionDir) {
      leadAgent.logFilePath = path.join(
        this.cachedSessionDir, this.config.persistenceSessionId,
        'teams', 'agents', `${leadAgent.agentId}.jsonl`
      );
    }

    this.persistence.appendTeamEntry({
      type: 'agent-spawned',
      teamId: this.config.teamId,
      agentId: leadAgent.agentId,
      name: leadSpec.name,
      role: 'lead',
      specialization: `Lead: ${this.config.title}`,
      model: leadAgent.model,
      timestamp: new Date().toISOString(),
    });

    this.onMessage({
      type: 'teamAgentStatusUpdate',
      teamId: this.config.teamId,
      agentId: leadAgent.agentId,
      status: 'running',
      logFilePath: leadAgent.logFilePath,
    });

    this.setPhase('working');

    const leadPromise = this.agentRunner.startAgent({
      agentId: leadAgent.agentId,
      name: leadSpec.name,
      role: 'lead',
      specialization: `Begin your mission. Research the problem space, establish contracts on the scratchpad, then spawn and coordinate your specialists.`,
      model: leadAgent.model,
      systemPrompt: leadPrompt,
      cwd: this.config.cwd,
      mcpServer: leadMcp,
      ...(this.config.additionalMcpServers ? { additionalMcpServers: this.config.additionalMcpServers } : {}),
      abortSignal: this.teamAbort.signal,
      messageBus: this.messageBus,
      onMessage: this.onMessage,
      teamId: this.config.teamId,
      persistence: this.persistence,
      resolveModelInfo: this.config.resolveModelInfo,
      ...(this.config.openaiBridgeDeps ? { openaiBridgeDeps: this.config.openaiBridgeDeps } : {}),
      bridgePanelId: this.buildBridgePanelId(leadAgent.agentId),
      onTurnEnd: () => {
        leadAgent.status = 'monitoring';
        this.onMessage({
          type: 'teamAgentStatusUpdate',
          teamId: this.config.teamId,
          agentId: leadAgent.agentId,
          status: 'monitoring',
          progressSummary: 'Waiting for specialists',
        });
      },
      onKeepAliveResume: () => {
        leadAgent.status = 'running';
        this.onMessage({
          type: 'teamAgentStatusUpdate',
          teamId: this.config.teamId,
          agentId: leadAgent.agentId,
          status: 'running',
        });
      },
      shouldDeliverMessage: (msg) => msg.to !== null,
      keepAliveTimeoutMs: KEEPALIVE_TIMEOUT_MS,
      keepAlive: () => !this.completionResolved && [...this.agents.values()].some(
        a => a.role === 'specialist' && (a.status === 'running' || a.status === 'pending' || a.status === 'awaiting-review' || a.status === 'standby'),
      ),
      keepAliveMessage: () => {
        const all = [...this.agents.values()].filter(a => a.role === 'specialist');
        const done = all.filter(a => a.status === 'completed' || a.status === 'failed' || a.status === 'cancelled').length;
        const running = all.filter(a => a.status === 'running');
        const awaitingReview = all.filter(a => a.status === 'awaiting-review');
        const standby = all.filter(a => a.status === 'standby');
        const pending = all.filter(a => a.status === 'pending');
        const runningDetail = running.map(a => `${a.name}: ${a.toolCallCount} tools`).join(', ');
        const parts = [`Active: ${runningDetail || 'none'}`];
        if (awaitingReview.length > 0) parts.push(`${awaitingReview.length} awaiting review`);
        if (standby.length > 0) parts.push(`Standby: ${standby.map(a => a.name).join(', ')}`);
        if (pending.length > 0) parts.push(`Pending (not dispatched): ${pending.map(a => a.name).join(', ')}`);
        return (
          `[System: Waiting for specialists. ${done}/${all.length} completed. ` +
          `${parts.join('. ')}. ` +
          `Specialists are working — you will be notified when they finish. ` +
          `Do NOT poll team_get_status. End your response to re-enter the wait state.]`
        );
      },
      onToolCall: (_toolName, count) => {
        leadAgent.toolCallCount = count;
      },
      onUsageUpdate: (usage) => {
        leadAgent.totalInputTokens = usage.inputTokens;
        leadAgent.totalOutputTokens = usage.outputTokens;
        leadAgent.cacheReadTokens = usage.cacheReadTokens;
        leadAgent.cacheCreationTokens = usage.cacheCreationTokens;
        leadAgent.costUsd = usage.costUsd;
      },
      canUseTool: this.buildCanUseTool(leadSpec.name),
    });

    leadPromise.then((result) => {
      const effectiveStatus = result.status === 'cancelled'
        && this.completionResolved
        && this.status !== 'cancelled'
        ? 'completed'
        : result.status;

      leadAgent.status = effectiveStatus;
      leadAgent.endTime = Date.now();
      leadAgent.toolCallCount = result.toolCallCount;
      leadAgent.totalInputTokens = result.totalInputTokens;
      leadAgent.totalOutputTokens = result.totalOutputTokens;
      leadAgent.cacheReadTokens = result.cacheReadTokens;
      leadAgent.cacheCreationTokens = result.cacheCreationTokens;
      leadAgent.costUsd = result.costUsd;
      leadAgent.finalResponse = result.finalResponse;

      this.persistence.appendTeamEntry({
        type: 'agent-completed',
        teamId: this.config.teamId,
        agentId: leadAgent.agentId,
        name: leadAgent.name,
        status: effectiveStatus,
        result: result.finalResponse,
        toolCallCount: result.toolCallCount,
        durationMs: result.durationMs,
        totalInputTokens: result.totalInputTokens,
        totalOutputTokens: result.totalOutputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheCreationTokens: result.cacheCreationTokens,
        costUsd: result.costUsd,
        timestamp: new Date().toISOString(),
      });

      if (effectiveStatus !== result.status) {
        this.onMessage({
          type: 'teamAgentStatusUpdate',
          teamId: this.config.teamId,
          agentId: leadAgent.agentId,
          status: effectiveStatus,
          progressSummary: `Completed (${result.toolCallCount} tools, ${Math.round(result.durationMs / 1000)}s)`,
        });
      }

      if (result.status === 'failed') {
        this.teamAbort.abort();
      }

      if (!this.completionResolved) {
        this.synthesizeResult(result.finalResponse ?? 'Lead agent completed without explicit synthesis.');
      }
    }).catch((err) => {
      leadAgent.status = 'failed';
      leadAgent.endTime = Date.now();
      leadAgent.error = err instanceof Error ? err.message : String(err);
      this.teamAbort.abort();
      if (!this.completionResolved) {
        this.synthesizeResult(this.buildPartialResults());
      }
    });

    try {
      const synthesizedResult = await completionPromise;

      const allPromises = [leadPromise, ...this.specialistPromises.values()];
      let drainTimer: ReturnType<typeof setTimeout> | null = null;
      const drainTimeout = new Promise<void>(resolve => {
        drainTimer = setTimeout(resolve, SPECIALIST_DRAIN_TIMEOUT_MS);
      });
      await Promise.race([Promise.allSettled(allPromises), drainTimeout]);
      if (drainTimer) clearTimeout(drainTimer);

      const stillRunning = [...this.agents.values()].filter(a => a.status === 'running' || a.status === 'pending' || a.status === 'awaiting-review' || a.status === 'standby');
      if (stillRunning.length > 0 && !this.teamAbort.signal.aborted) {
        this.teamAbort.abort();
        await Promise.race([
          Promise.allSettled(allPromises),
          new Promise<void>(resolve => setTimeout(resolve, 2_000)),
        ]);
      }

      for (const agent of this.agents.values()) {
        if (agent.status === 'pending') {
          agent.status = 'cancelled';
          agent.endTime = Date.now();
        } else if (agent.status === 'running' || agent.status === 'awaiting-review' || agent.status === 'standby' || agent.status === 'monitoring') {
          agent.status = this.status === 'cancelled' ? 'cancelled' : 'completed';
          agent.endTime = Date.now();
        }
      }

      this.setPhase('complete');
      const finalStatus = this.status === 'cancelled' ? 'cancelled' : 'completed';
      this.status = finalStatus;

      this.persistence.appendTeamEntry({
        type: 'team-completed',
        teamId: this.config.teamId,
        status: finalStatus,
        synthesizedResult,
        agentResults: [...this.agents.values()].map(a => ({
          agentId: a.agentId,
          name: a.name,
          status: a.status,
          toolCallCount: a.toolCallCount,
        })),
        timestamp: new Date().toISOString(),
      });

      try {
        await this.persistence.flush();
      } catch (err) {
        const count = err instanceof AggregateError ? err.errors.length : 1;
        console.error(`[TeamRunner] Persistence flush failed (${count} write error(s)):`, err);
      }

      this.onMessage({
        type: 'teamCompleted',
        teamId: this.config.teamId,
        status: finalStatus,
        result: synthesizedResult,
      });

      return synthesizedResult;
    } finally {
      if (!this.teamAbort.signal.aborted) {
        this.teamAbort.abort();
      }
    }
  }

  startSpecialist(name: string, task: string, model?: string, profileId?: string): string {
    const agent = this.agents.get(name);
    if (!agent) {
      throw new Error(`Unknown agent: ${name}`);
    }
    if (agent.status !== 'pending') {
      throw new Error(`Agent "${name}" already spawned`);
    }
    const runningCount = [...this.agents.values()].filter(a => a.status === 'running').length;
    if (runningCount >= MAX_AGENTS) {
      throw new Error(`Max ${MAX_AGENTS} concurrent agents reached`);
    }

    let domainProfile: DomainProfile | undefined;
    if (profileId) {
      const agentProfile = AGENT_PROFILE_MAP.get(profileId);
      if (!agentProfile) {
        throw new Error(`Unknown agent profile: "${profileId}". Use a valid profile ID from the catalog.`);
      }
      domainProfile = {
        name: agentProfile.name,
        identity: agentProfile.identity,
        mission: agentProfile.mission,
        rules: agentProfile.rules,
      };
    }

    const leadAgent = [...this.agents.values()].find(a => a.role === 'lead');
    agent.specialization = task;
    agent.status = 'running';
    agent.startTime = Date.now();
    agent.profileId = profileId ?? null;
    if (this.cachedSessionDir) {
      agent.logFilePath = path.join(
        this.cachedSessionDir, this.config.persistenceSessionId,
        'teams', 'agents', `${agent.agentId}.jsonl`
      );
    }
    if (model) agent.model = model;

    this.persistence.appendTeamEntry({
      type: 'agent-spawned',
      teamId: this.config.teamId,
      agentId: agent.agentId,
      name: agent.name,
      role: 'specialist',
      specialization: task,
      model: agent.model,
      profileId: agent.profileId,
      timestamp: new Date().toISOString(),
    });

    this.onMessage({
      type: 'teamAgentStatusUpdate',
      teamId: this.config.teamId,
      agentId: agent.agentId,
      status: 'running',
      logFilePath: agent.logFilePath,
    });

    let specialistPrompt = buildSpecialistSystemPrompt(
      name,
      this.config.title,
      task,
      leadAgent?.name ?? 'lead',
      domainProfile,
      this.config.permissionMode,
    );
    if (this.config.systemPromptSuffix) specialistPrompt += '\n\n' + this.config.systemPromptSuffix;

    const specialistMcp = this.createAgentMcpServer({
      agentId: agent.agentId,
      agentName: name,
      role: 'specialist',
      allowedSpecialistModels: this.config.allowedSpecialistModels,
      messageBus: this.messageBus,
      scratchpad: this.scratchpad,
      startSpecialist: () => { throw new Error('Only the lead agent can spawn specialists'); },
      synthesizeResult: () => { throw new Error('Only the lead agent can synthesize results'); },
      cancelSpecialist: () => { throw new Error('Only the lead agent can cancel specialists'); },
      getActiveSpecialistNames: () => [],
      getPendingSpecialistNames: () => [],
      getTeamStatus: () => this.getTeamStatus(),
      getAgentNames: () => [...this.agents.keys()],
      requestRevision: () => { throw new Error('Only lead can request revisions'); },
      approveSpecialist: () => { throw new Error('Only lead can approve specialists'); },
      getUnreviewedSpecialistNames: () => [],
      isReviewRoundReady: () => false,
      getNonSettledSpecialistDetails: () => [],
      getAllAgents: () => [...this.agents.values()],
      enterStandby: (n) => this.enterStandby(n),
      reportComplete: (n) => this.reportComplete(n),
    });

    const specialistAbort = new AbortController();
    this.specialistAborts.set(name, specialistAbort);
    this.teamAbort.signal.addEventListener('abort', () => specialistAbort.abort(), { once: true });

    const initPromise = this.persistence.initAgentFile(this.config.teamId, agent.agentId);

    const promise = initPromise.then(() => this.agentRunner.startAgent({
      agentId: agent.agentId,
      name,
      role: 'specialist',
      specialization: task,
      model: agent.model,
      systemPrompt: specialistPrompt,
      cwd: this.config.cwd,
      mcpServer: specialistMcp,
      ...(this.config.additionalMcpServers ? { additionalMcpServers: this.config.additionalMcpServers } : {}),
      abortSignal: specialistAbort.signal,
      messageBus: this.messageBus,
      onMessage: this.onMessage,
      teamId: this.config.teamId,
      persistence: this.persistence,
      resolveModelInfo: this.config.resolveModelInfo,
      ...(this.config.openaiBridgeDeps ? { openaiBridgeDeps: this.config.openaiBridgeDeps } : {}),
      bridgePanelId: this.buildBridgePanelId(agent.agentId),
      keepAlive: () => {
        if (this.completionResolved) return false;
        if (this.pendingStandby.has(name)) return true;
        if (this.confirmedComplete.has(name)) {
          const rounds = this.specialistReviewRounds.get(name) ?? 0;
          return rounds < MAX_SPECIALIST_REVIEW_ROUNDS;
        }
        return false;
      },
      keepAliveTimeoutMs: KEEPALIVE_TIMEOUT_MS,
      shouldDeliverMessage: (msg) => {
        if (this.confirmedComplete.has(name) && msg.to === null) {
          return false;
        }
        return true;
      },
      keepAliveMessage: () =>
        '[System: Still waiting. End your response immediately to re-enter the wait state.]',
      onTurnEnd: () => {
        if (this.confirmedComplete.has(name) && agent.status !== 'awaiting-review') {
          agent.status = 'awaiting-review';
          const rounds = this.specialistReviewRounds.get(name) ?? 0;
          this.onMessage({
            type: 'teamAgentStatusUpdate',
            teamId: this.config.teamId,
            agentId: agent.agentId,
            status: 'awaiting-review',
            progressSummary: `Awaiting review (${rounds}/${MAX_SPECIALIST_REVIEW_ROUNDS} revisions used)`,
          });
          this.notifyLeadIfReviewRoundReady();
        } else if (this.pendingStandby.has(name) && agent.status !== 'standby') {
          agent.status = 'standby';
          this.onMessage({
            type: 'teamAgentStatusUpdate',
            teamId: this.config.teamId,
            agentId: agent.agentId,
            status: 'standby',
            progressSummary: 'Waiting for peer input',
          });
        }
      },
      onKeepAliveResume: () => {
        this.pendingStandby.delete(name);
        agent.status = 'running';
        this.onMessage({
          type: 'teamAgentStatusUpdate',
          teamId: this.config.teamId,
          agentId: agent.agentId,
          status: 'running',
        });
      },
      onToolCall: (_toolName, count) => {
        agent.toolCallCount = count;
      },
      onUsageUpdate: (usage) => {
        agent.totalInputTokens = usage.inputTokens;
        agent.totalOutputTokens = usage.outputTokens;
        agent.cacheReadTokens = usage.cacheReadTokens;
        agent.cacheCreationTokens = usage.cacheCreationTokens;
        agent.costUsd = usage.costUsd;
        this.onMessage({
          type: 'teamAgentUsageUpdate',
          teamId: this.config.teamId,
          agentId: agent.agentId,
          totalInputTokens: usage.inputTokens,
          totalOutputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
          costUsd: usage.costUsd,
        });
      },
      canUseTool: this.buildCanUseTool(name),
    }));

    promise.then((result) => {
      const wasApproved = this.reviewedSpecialists.has(name);
      const effectiveStatus = result.status === 'cancelled'
        && (this.completionResolved || wasApproved)
        && this.status !== 'cancelled'
        ? 'completed'
        : result.status;
      agent.status = effectiveStatus;
      agent.endTime = agent.endTime ?? Date.now();
      agent.toolCallCount = result.toolCallCount;
      agent.totalInputTokens = result.totalInputTokens;
      agent.totalOutputTokens = result.totalOutputTokens;
      agent.cacheReadTokens = result.cacheReadTokens;
      agent.cacheCreationTokens = result.cacheCreationTokens;
      agent.costUsd = result.costUsd;
      agent.finalResponse = result.finalResponse;

      this.persistence.appendTeamEntry({
        type: 'agent-completed',
        teamId: this.config.teamId,
        agentId: agent.agentId,
        name: agent.name,
        status: effectiveStatus,
        result: result.finalResponse,
        toolCallCount: result.toolCallCount,
        durationMs: result.durationMs,
        totalInputTokens: result.totalInputTokens,
        totalOutputTokens: result.totalOutputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheCreationTokens: result.cacheCreationTokens,
        costUsd: result.costUsd,
        timestamp: new Date().toISOString(),
      });

      if (effectiveStatus !== result.status) {
        this.onMessage({
          type: 'teamAgentStatusUpdate',
          teamId: this.config.teamId,
          agentId: agent.agentId,
          status: effectiveStatus,
          progressSummary: `Completed (${result.toolCallCount} tools, ${Math.round(result.durationMs / 1000)}s)`,
        });
      }

      if (!wasApproved) {
        const leadName = [...this.agents.values()].find(a => a.role === 'lead')?.name;
        if (leadName) {
          const statusText = effectiveStatus === 'completed'
            ? `completed (${result.toolCallCount} tools, ${Math.round(result.durationMs / 1000)}s)`
            : effectiveStatus;
          this.messageBus.send('system', leadName,
            `Specialist "${name}" ${statusText}. Read their scratchpad section for findings.`,
          );
        }
      }

      this.notifyLeadIfReviewRoundReady();
    }).catch((err) => {
      agent.status = 'failed';
      agent.endTime = Date.now();
      agent.error = err instanceof Error ? err.message : String(err);

      const leadName = [...this.agents.values()].find(a => a.role === 'lead')?.name;
      if (leadName) {
        this.messageBus.send('system', leadName, `Specialist "${name}" failed: ${agent.error}`);
      }

      this.notifyLeadIfReviewRoundReady();
    });

    this.specialistPromises.set(name, promise);
    return agent.agentId;
  }

  synthesizeResult(result: string): void {
    if (this.completionResolved) {
      return;
    }
    this.completionResolved = true;
    this.setPhase('synthesizing');

    this.pendingStandby.clear();
    this.confirmedComplete.clear();
    this.specialistReviewRounds.clear();
    this.reviewedSpecialists.clear();
    this.cancelAttempts.clear();
    this.cancellationTimestamps.clear();

    for (const agent of this.agents.values()) {
      if (agent.status === 'awaiting-review' || agent.status === 'standby') {
        agent.status = 'completed';
        agent.endTime = Date.now();
        this.onMessage({
          type: 'teamAgentStatusUpdate',
          teamId: this.config.teamId,
          agentId: agent.agentId,
          status: 'completed',
          progressSummary: 'Released by synthesis',
        });
        const abort = this.specialistAborts.get(agent.name);
        if (abort) abort.abort();
      }
    }

    if (this.completionResolve) {
      this.completionResolve(result);
    }
  }

  getTeamStatus(): Record<string, unknown> {
    const agentStatuses = [...this.agents.values()].map(a => ({
      name: a.name,
      role: a.role,
      status: a.status,
      toolCallCount: a.toolCallCount,
      durationSec: a.startTime ? Math.round((Date.now() - a.startTime) / 1000) : 0,
    }));

    return {
      teamId: this.config.teamId,
      title: this.config.title,
      phase: this.phase,
      status: this.status,
      agents: agentStatuses,
      messageCount: this.messageBus.getAllMessages().length,
      activeCount: agentStatuses.filter(a => a.status === 'running').length,
      completedCount: agentStatuses.filter(a => a.status === 'completed').length,
    };
  }

  cancelSpecialist(name: string): void {
    const agent = this.agents.get(name);
    if (!agent) throw new Error(`Unknown agent: ${name}`);
    if (agent.status !== 'running' && agent.status !== 'pending' && agent.status !== 'awaiting-review' && agent.status !== 'standby') {
      throw new Error(`Agent "${name}" is not active (status: ${agent.status})`);
    }
    this.pendingStandby.delete(name);
    this.confirmedComplete.delete(name);
    this.reviewedSpecialists.delete(name);
    this.cancellationTimestamps.set(name, Date.now());
    const abort = this.specialistAborts.get(name);
    if (abort) {
      abort.abort();
    } else {
      agent.status = 'cancelled';
      agent.endTime = Date.now();
      this.onMessage({
        type: 'teamAgentStatusUpdate',
        teamId: this.config.teamId,
        agentId: agent.agentId,
        status: 'cancelled',
      });
      this.persistence.appendTeamEntry({
        type: 'agent-completed',
        teamId: this.config.teamId,
        agentId: agent.agentId,
        name: agent.name,
        status: 'cancelled',
        result: null,
        toolCallCount: 0,
        durationMs: 0,
        timestamp: new Date().toISOString(),
      });
      this.notifyLeadIfReviewRoundReady();
    }
  }

  cancelAgent(agentId: string): void {
    const agent = [...this.agents.values()].find(a => a.agentId === agentId);
    if (!agent) throw new Error('Unknown agent');
    if (agent.status !== 'running' && agent.status !== 'pending' && agent.status !== 'awaiting-review' && agent.status !== 'standby') {
      throw new Error(`Agent "${agent.name}" is not active (status: ${agent.status})`);
    }
    if (agent.role === 'lead') {
      this.cancel();
    } else {
      this.cancelSpecialist(agent.name);
    }
  }

  getActiveSpecialistNames(): string[] {
    return [...this.agents.values()]
      .filter(a => a.role === 'specialist' && a.status === 'running')
      .filter(a => !this.specialistAborts.get(a.name)?.signal.aborted)
      .map(a => a.name);
  }

  getPendingSpecialistNames(): string[] {
    return [...this.agents.values()]
      .filter(a => a.role === 'specialist' && a.status === 'pending')
      .map(a => a.name);
  }

  requestRevision(specialistName: string, feedback: string): void {
    const agent = this.agents.get(specialistName);
    if (!agent || agent.status !== 'awaiting-review') {
      throw new Error(`Specialist "${specialistName}" is not awaiting review`);
    }
    this.reviewedSpecialists.delete(specialistName);
    this.confirmedComplete.delete(specialistName);
    const rounds = (this.specialistReviewRounds.get(specialistName) ?? 0) + 1;
    this.specialistReviewRounds.set(specialistName, rounds);
    const leadName = [...this.agents.values()].find(a => a.role === 'lead')?.name ?? 'lead';
    this.messageBus.send(leadName, specialistName,
      `[REVISION REQUEST — Round ${rounds}/${MAX_SPECIALIST_REVIEW_ROUNDS}]\n\n${feedback}`
    );
  }

  enterStandby(agentName: string): void {
    const agent = this.agents.get(agentName);
    if (!agent || agent.role !== 'specialist' || agent.status !== 'running') {
      throw new Error(`Agent "${agentName}" cannot enter standby`);
    }
    this.confirmedComplete.delete(agentName);
    this.pendingStandby.add(agentName);
  }

  reportComplete(agentName: string): void {
    const agent = this.agents.get(agentName);
    if (!agent || agent.role !== 'specialist' || agent.status !== 'running') {
      throw new Error(`Agent "${agentName}" cannot report complete`);
    }
    const rounds = this.specialistReviewRounds.get(agentName) ?? 0;
    if (rounds >= MAX_SPECIALIST_REVIEW_ROUNDS) {
      throw new Error(
        'Maximum review rounds reached. Your session will end when this turn completes. ' +
        'Ensure your final work is in the scratchpad.'
      );
    }
    this.pendingStandby.delete(agentName);
    this.confirmedComplete.add(agentName);
  }

  approveSpecialist(name: string): void {
    const agent = this.agents.get(name);
    if (!agent) throw new Error(`Unknown specialist: ${name}`);
    if (agent.role !== 'specialist') throw new Error(`${name} is not a specialist`);
    if (agent.status !== 'awaiting-review') {
      throw new Error(`Specialist "${name}" is not awaiting review (current: ${agent.status})`);
    }
    if (!this.confirmedComplete.has(name)) {
      throw new Error(`Specialist "${name}" has a pending revision — wait for revision to complete`);
    }
    const leadName = this.findLeadName();
    if (leadName) {
      const decision = checkApprovalReadGate(name, this.scratchpad, leadName);
      if (!decision.ok) throw new Error(decision.error);
    }
    this.reviewedSpecialists.add(name);
    this.confirmedComplete.delete(name);
    agent.status = 'completed';
    agent.endTime = Date.now();
    this.onMessage({
      type: 'teamAgentStatusUpdate',
      teamId: this.config.teamId,
      agentId: agent.agentId,
      status: 'completed',
      progressSummary: 'Approved by lead',
    });
    const abort = this.specialistAborts.get(name);
    if (abort) abort.abort();
  }

  getUnreviewedSpecialistNames(): string[] {
    return [...this.agents.values()]
      .filter(a => a.role === 'specialist' && a.status === 'awaiting-review' && !this.reviewedSpecialists.has(a.name))
      .map(a => a.name);
  }

  isReviewRoundReady(): boolean {
    const dispatched = [...this.agents.values()]
      .filter(a => a.role === 'specialist' && a.status !== 'pending');
    if (dispatched.length === 0) return false;
    const allSettled = dispatched.every(a =>
      a.status === 'awaiting-review' || a.status === 'completed' || a.status === 'cancelled' || a.status === 'failed',
    );
    if (!allSettled) return false;
    return dispatched.some(a =>
      a.status === 'awaiting-review'
      && !this.reviewedSpecialists.has(a.name)
      && this.confirmedComplete.has(a.name),
    );
  }

  getNonSettledSpecialistDetails(): Array<{name: string; status: TeamAgent['status']; toolCallCount: number}> {
    return [...this.agents.values()]
      .filter(a => a.role === 'specialist'
        && a.status !== 'pending'
        && a.status !== 'awaiting-review'
        && a.status !== 'completed'
        && a.status !== 'cancelled'
        && a.status !== 'failed')
      .map(a => ({ name: a.name, status: a.status, toolCallCount: a.toolCallCount }));
  }

  private notifyLeadIfReviewRoundReady(): void {
    const dispatched = [...this.agents.values()]
      .filter(a => a.role === 'specialist' && a.status !== 'pending');
    if (dispatched.length === 0) return;
    const allSettled = dispatched.every(a =>
      a.status === 'awaiting-review' || a.status === 'completed' || a.status === 'cancelled' || a.status === 'failed',
    );
    if (!allSettled) return;

    const unreviewed = dispatched
      .filter(a => a.status === 'awaiting-review' && !this.reviewedSpecialists.has(a.name));
    const leadName = this.findLeadName();
    if (!leadName) return;

    const pendingNames = this.getPendingSpecialistNames();
    const notification = formatReviewRoundReadyNotification(unreviewed, this.scratchpad, leadName, pendingNames);
    if (!notification) return;
    this.messageBus.send('system', leadName, notification);
  }

  private findLeadName(): string | undefined {
    return [...this.agents.values()].find(a => a.role === 'lead')?.name;
  }

  cancel(): void {
    this.status = 'cancelled';
    this.teamAbort.abort();
    for (const pending of this.pendingPermissions.values()) {
      pending.resolve('deny');
    }
    this.pendingPermissions.clear();
    if (!this.completionResolved) {
      this.synthesizeResult(this.buildPartialResults());
    }
  }

  resolvePermission(requestId: string, behavior: 'allow' | 'deny'): void {
    const pending = this.pendingPermissions.get(requestId);
    if (pending) {
      pending.resolve(behavior);
      this.pendingPermissions.delete(requestId);
    }
  }

  private static readonly PLAN_MODE_BLOCKED_TOOLS = new Set([
    'Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell',
  ]);

  private static readonly ACCEPT_EDITS_AUTO_APPROVED = new Set([
    'Edit', 'Write', 'NotebookEdit',
  ]);

  private buildCanUseTool(agentName: string): NonNullable<AgentRunConfig['canUseTool']> {
    return async (toolName, input, options) => {
      if (this.config.permissionMode === 'plan' && TeamRunner.PLAN_MODE_BLOCKED_TOOLS.has(toolName)) {
        return {
          behavior: 'deny',
          message: `BLOCKED: The session is in Plan mode. You called "${toolName}" which modifies files or runs commands. `
            + 'This is not allowed in Plan mode. You must ONLY research, analyze, and report findings. '
            + 'Use Read, Grep, Glob to investigate code. Write your analysis to the scratchpad and send messages to teammates. '
            + 'Do NOT attempt to call Edit, Write, NotebookEdit, Bash, or PowerShell again — they will all be blocked.',
        };
      }

      if (TeamRunner.SAFE_TOOLS.has(toolName) || toolName.startsWith('mcp__')) {
        return { behavior: 'allow', updatedInput: input };
      }

      if (this.config.permissionMode === 'acceptEdits' && TeamRunner.ACCEPT_EDITS_AUTO_APPROVED.has(toolName)) {
        return { behavior: 'allow', updatedInput: input };
      }

      const requestId = crypto.randomUUID();
      const agent = this.findAgentByName(agentName);
      this.onMessage({
        type: 'teamAgentPermissionRequest',
        requestId,
        teamId: this.config.teamId,
        agentId: agent?.agentId ?? '',
        agentName,
        toolName,
        toolInput: input,
      });

      return new Promise<import('./types').ToolPermissionResult>((resolve) => {
        const onAbort = () => {
          this.pendingPermissions.delete(requestId);
          resolve({ behavior: 'deny', message: 'Agent cancelled' });
        };

        if (options.signal.aborted) {
          resolve({ behavior: 'deny', message: 'Agent cancelled' });
          return;
        }

        options.signal.addEventListener('abort', onAbort, { once: true });
        this.pendingPermissions.set(requestId, {
          resolve: (behavior) => {
            options.signal.removeEventListener('abort', onAbort);
            if (behavior === 'allow') {
              resolve({ behavior: 'allow', updatedInput: input });
            } else {
              resolve({ behavior: 'deny', message: 'Permission denied by user' });
            }
          },
        });
      });
    };
  }

  private setPhase(phase: TeamPhase): void {
    this.phase = phase;
    this.onMessage({
      type: 'teamPhaseUpdate',
      teamId: this.config.teamId,
      phase,
    });
  }

  private findAgentByName(name: string): TeamAgent | undefined {
    return this.agents.get(name);
  }

  /** Synthetic per-agent panel ID; each agent gets its own bearer + route on the shared bridge. */
  private buildBridgePanelId(agentId: string): string {
    return `team-${this.config.teamId}-${agentId}`;
  }

  /** Evict every synthetic agent route from the bridge so the per-bearer Map doesn't leak. */
  releaseBridgePanels(): void {
    const bridgeFactory = this.config.openaiBridgeDeps?.getBridge;
    if (!bridgeFactory) return;
    const bridge = bridgeFactory();
    for (const agent of this.agents.values()) {
      bridge.releasePanel(this.buildBridgePanelId(agent.agentId));
    }
  }

  private buildPartialResults(): string {
    const parts: string[] = ['## Partial Team Results (team did not complete normally)\n'];

    for (const agent of this.agents.values()) {
      if (agent.finalResponse) {
        parts.push(`### ${agent.name} (${agent.role}, ${agent.status})\n${agent.finalResponse}\n`);
      }
    }

    const scratchpadEntries = this.scratchpad.getAll();
    if (scratchpadEntries.length > 0) {
      parts.push('### Scratchpad\n');
      for (const entry of scratchpadEntries) {
        parts.push(`**${entry.section}** (by ${entry.author}):\n${entry.content}\n`);
      }
    }

    return parts.join('\n');
  }

  private emitTeamStarted(): void {
    const agentList: WebviewTeamAgent[] = [...this.agents.values()].map(a => ({
      agentId: a.agentId,
      name: a.name,
      role: a.role,
      specialization: a.specialization,
      model: a.model,
      profileId: a.profileId,
      status: a.status,
      startTime: a.startTime,
      endTime: a.endTime,
      toolCount: a.toolCallCount,
      lastToolName: null,
      totalInputTokens: a.totalInputTokens,
      totalOutputTokens: a.totalOutputTokens,
      cacheReadTokens: a.cacheReadTokens,
      cacheCreationTokens: a.cacheCreationTokens,
      costUsd: a.costUsd,
      progressSummary: null,
      result: null,
      logFilePath: a.logFilePath,
    }));

    const teamState: TeamState = {
      teamId: this.config.teamId,
      toolUseId: this.config.toolUseId,
      title: this.config.title,
      status: 'running',
      phase: this.phase,
      agents: agentList,
      messages: [],
      scratchpad: [],
      result: null,
      startTime: Date.now(),
      endTime: null,
      totalToolCount: 0,
    };

    this.onMessage({
      type: 'teamStarted',
      team: teamState,
    });
  }
}
