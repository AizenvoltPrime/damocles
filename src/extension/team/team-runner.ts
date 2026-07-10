import * as crypto from 'crypto';
import * as path from 'path';
import { ensurePiSessionDir } from '../pi-session/session-store';
import { MessageBus } from './message-bus';
import { Scratchpad } from './scratchpad';
import { AgentRunner } from './agent-runner';
import { TeamPersistence } from './persistence';
import { buildLeadSystemPrompt, buildSpecialistSystemPrompt } from './prompts';
import type { DomainProfile } from './prompts';
import {
  checkApprovalReadGate,
  checkBriefReadGate,
  classifyStrandedStandby,
  formatReviewRoundReadyNotification,
  isSpecialistSettled,
} from './review-gate';
import { AGENT_PROFILE_MAP, AGENT_PROFILE_CATALOG } from './agent-profiles.generated';
import type {
  TeamConfig,
  AgentResult,
  AgentMcpContext,
  TeamAgent,
  TeamPhase,
  TeamStatus,
  SpecialistKind,
} from './types';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { TeamState, TeamAgent as WebviewTeamAgent } from '../../shared/types/team';

const MAX_AGENTS = 5;
const SPECIALIST_DRAIN_TIMEOUT_MS = 30_000;
const MAX_SPECIALIST_REVIEW_ROUNDS = 2;
const CONFLICT_NUDGE_MAX = 2;
const STRANDED_STANDBY_NUDGE =
  'No peer is still working, so no further peer input is coming. If your work is complete and verified, ' +
  'post any final scratchpad and call team_report_complete now. If you are still blocked, message the ' +
  'lead with team_send_message. Do not call team_standby again.';
const CONFLICT_NUDGE_PREFIX = 'You have UNRESOLVED brief conflicts: ';
const CONFLICT_NUDGE_SUFFIX =
  '. Before ending, resolve each via team_request_revision (fix the task/contract) or ' +
  'team_resolve_brief_conflict (dismiss with a written rationale). This is a hard requirement.';

export class TeamRunner {
  private readonly config: TeamConfig;
  private readonly onMessage: (msg: ExtensionToWebviewMessage) => void;
  private agentRunner = new AgentRunner();

  private messageBus!: MessageBus;
  private scratchpad!: Scratchpad;
  private persistence!: TeamPersistence;

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
  // A stranded standby is nudged once, then converted only after the nudge was DELIVERED and the agent
  // re-parked. `nudgeScheduled` dedups the microtask; `nudgeDelivered` (set inside the microtask) is the
  // classifier's `alreadyNudged` input, so `convert` cannot fire before the agent got its clean turn.
  private nudgeScheduled = new Set<string>();
  private nudgeDelivered = new Set<string>();
  // Open brief conflicts a specialist raised (name → detail). While non-empty the lead cannot explicitly
  // synthesize; on lead turn-end it is nudged (bounded); any completion with an open flag fails loud.
  private briefConflicts = new Map<string, string>();
  private conflictNudges = 0;

  constructor(
    config: TeamConfig,
    onMessage: (msg: ExtensionToWebviewMessage) => void,
  ) {
    this.config = config;
    this.onMessage = onMessage;
  }

  async run(): Promise<string> {
    this.messageBus = new MessageBus(this.config.teamId);
    this.scratchpad = new Scratchpad();
    this.persistence = new TeamPersistence(this.config.cwd, this.config.persistenceSessionId);

    await this.persistence.initTeamFile(this.config.teamId);
    // Pin team transcripts under the Damocles-owned pi session dir, isolated from the deleted SDK
    // `~/.claude/projects` tree (US-024d latent-bug fix).
    this.cachedSessionDir = ensurePiSessionDir(this.config.cwd);

    this.persistence.appendTeamEntry({
      type: 'team-created',
      teamId: this.config.teamId,
      toolUseId: this.config.toolUseId,
      title: this.config.title,
      brief: this.config.brief,
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

    const lead = this.config.resolveRoleModel('lead');
    // A blocking lead resolution error must fail team creation up front, not silently degrade the lead
    // to the engine default model (the fail-soft the design forbids for a configured-but-unauthed slot).
    if (lead.error) throw new Error(lead.error);
    const leadModelValue = lead.modelLabel ?? '';

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
        model: spec.role === 'lead' ? leadModelValue : '',
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

    // Seed the authoritative brief into an immutable, system-owned scratchpad section AFTER the webview
    // has the team registered (emitTeamStarted) and BEFORE any agent runs, so specialists read it as the
    // single source of truth and no agent can overwrite it. The already-registered scratchpad.subscribe
    // handler persists the scratchpad-update, emits teamScratchpadUpdate, and broadcasts the notice.
    this.scratchpad.seedImmutable('mission-brief', this.config.brief);

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
    const leadPrompt = buildLeadSystemPrompt(this.config.title, this.config.brief, specialists, AGENT_PROFILE_CATALOG || undefined, this.config.permissionMode);

    const leadCtx = this.buildLeadContext(leadAgent.agentId, leadSpec.name);

    await this.persistence.initAgentFile(this.config.teamId, leadAgent.agentId);

    leadAgent.status = 'running';
    leadAgent.startTime = Date.now();
    leadAgent.logFilePath = this.agentLogPath(leadAgent.agentId);

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
      ...(leadAgent.model ? { model: leadAgent.model } : {}),
    });

    this.setPhase('working');

    const leadPromise = this.agentRunner.startAgent({
      agentId: leadAgent.agentId,
      name: leadSpec.name,
      role: 'lead',
      specialization: `Begin your mission. Research the problem space, establish contracts on the scratchpad, then spawn and coordinate your specialists.`,
      createSession: () => this.config.engine.createSession({
        cwd: this.config.cwd,
        systemPrompt: leadPrompt,
        ...(lead.model ? { model: lead.model } : {}),
        ...(lead.thinkingLevel ? { thinkingLevel: lead.thinkingLevel } : {}),
        tools: this.config.engine.agentToolNames(),
        customTools: this.config.engine.buildAgentCustomTools(leadCtx),
        excludeTools: ['edit'],
        extensionFactory: this.config.engine.buildExtensionFactory(leadSpec.name, leadAgent.agentId),
      }),
      forgetSession: (session) => this.config.engine.forgetSession(session),
      abortSignal: this.teamAbort.signal,
      messageBus: this.messageBus,
      onMessage: this.onMessage,
      teamId: this.config.teamId,
      persistence: this.persistence,
      onTurnEnd: () => {
        leadAgent.status = 'monitoring';
        this.onMessage({
          type: 'teamAgentStatusUpdate',
          teamId: this.config.teamId,
          agentId: leadAgent.agentId,
          status: 'monitoring',
          progressSummary: 'Waiting for specialists',
        });
        this.nudgeLeadOnOpenConflicts(leadSpec.name);
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
      keepAlive: () => !this.completionResolved && [...this.agents.values()].some(
        a => a.role === 'specialist' && (a.status === 'running' || a.status === 'pending' || a.status === 'awaiting-review' || a.status === 'standby'),
      ),
      onToolCall: (_toolName, count) => {
        leadAgent.toolCallCount = count;
      },
      onUsageUpdate: (usage) => {
        leadAgent.totalInputTokens = usage.inputTokens;
        leadAgent.totalOutputTokens = usage.outputTokens;
        leadAgent.cacheReadTokens = usage.cacheReadTokens;
        leadAgent.cacheCreationTokens = usage.cacheCreationTokens;
        leadAgent.costUsd = usage.costUsd;
        this.onMessage({
          type: 'teamAgentUsageUpdate',
          teamId: this.config.teamId,
          agentId: leadAgent.agentId,
          totalInputTokens: usage.inputTokens,
          totalOutputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens,
          cacheCreationTokens: usage.cacheCreationTokens,
          costUsd: usage.costUsd,
        });
      },
      onCost: (delta) => this.config.engine.onAgentCost(delta),
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

  startSpecialist(name: string, task: string, profileId?: string, kind?: SpecialistKind): string {
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

    // Resolve the specialist's model from the role slot (`kind` selects implementor vs reviewer settings)
    // BEFORE mutating agent state. A configured-but-unresolvable/unauthed slot throws — surfaced to the
    // lead as a spawn tool error. Resolving first keeps the agent 'pending' on failure (no ghost 'running'
    // agent that blocks re-spawn, counts as active, and eats a MAX_AGENTS slot).
    const resolution = this.config.resolveRoleModel(kind ?? 'implementor');
    if (resolution.error) throw new Error(resolution.error);

    const leadAgent = [...this.agents.values()].find(a => a.role === 'lead');
    agent.specialization = task;
    agent.status = 'running';
    agent.startTime = Date.now();
    agent.profileId = profileId ?? null;
    agent.logFilePath = this.agentLogPath(agent.agentId);
    agent.model = resolution.modelLabel ?? '';

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
      ...(agent.model ? { model: agent.model } : {}),
    });

    const specialistPrompt = buildSpecialistSystemPrompt(
      name,
      this.config.title,
      task,
      leadAgent?.name ?? 'lead',
      domainProfile,
      this.config.permissionMode,
    );

    const specialistCtx = this.buildSpecialistContext(agent.agentId, name);

    const specialistAbort = new AbortController();
    this.specialistAborts.set(name, specialistAbort);
    // Propagate a team-wide abort. If the team already aborted before this specialist spawned, the
    // 'abort' event won't fire again, so abort eagerly; otherwise listen once (auto-removed on fire).
    if (this.teamAbort.signal.aborted) {
      specialistAbort.abort();
    } else {
      this.teamAbort.signal.addEventListener('abort', () => specialistAbort.abort(), { once: true });
    }

    const initPromise = this.persistence.initAgentFile(this.config.teamId, agent.agentId);

    const promise = initPromise.then(() => this.agentRunner.startAgent({
      agentId: agent.agentId,
      name,
      role: 'specialist',
      specialization: task,
      createSession: () => this.config.engine.createSession({
        cwd: this.config.cwd,
        systemPrompt: specialistPrompt,
        ...(resolution.model ? { model: resolution.model } : {}),
        ...(resolution.thinkingLevel ? { thinkingLevel: resolution.thinkingLevel } : {}),
        tools: this.config.engine.agentToolNames(),
        customTools: this.config.engine.buildAgentCustomTools(specialistCtx),
        excludeTools: ['edit'],
        extensionFactory: this.config.engine.buildExtensionFactory(name, agent.agentId),
      }),
      forgetSession: (session) => this.config.engine.forgetSession(session),
      abortSignal: specialistAbort.signal,
      messageBus: this.messageBus,
      onMessage: this.onMessage,
      teamId: this.config.teamId,
      persistence: this.persistence,
      keepAlive: () => {
        if (this.completionResolved) return false;
        if (this.pendingStandby.has(name)) return true;
        if (this.confirmedComplete.has(name)) {
          const rounds = this.specialistReviewRounds.get(name) ?? 0;
          return rounds < MAX_SPECIALIST_REVIEW_ROUNDS;
        }
        return false;
      },
      shouldDeliverMessage: (msg) => {
        if (this.confirmedComplete.has(name) && msg.to === null) {
          return false;
        }
        return true;
      },
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
          // This specialist just became the last to settle; a PEER may now be stranded in standby with
          // no running agent left to wake it. This settle happens in onTurnEnd (the runner stays parked;
          // its promise.then never fires), so recovery must run here too.
          this.resolveStrandedStandbys();
        } else if (this.pendingStandby.has(name) && agent.status !== 'standby') {
          agent.status = 'standby';
          this.onMessage({
            type: 'teamAgentStatusUpdate',
            teamId: this.config.teamId,
            agentId: agent.agentId,
            status: 'standby',
            progressSummary: 'Waiting for peer input',
          });
          this.resolveStrandedStandbys();
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
      onCost: (delta) => this.config.engine.onAgentCost(delta),
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
      this.resolveStrandedStandbys();
    }).catch((err) => {
      agent.status = 'failed';
      agent.endTime = Date.now();
      agent.error = err instanceof Error ? err.message : String(err);

      const leadName = [...this.agents.values()].find(a => a.role === 'lead')?.name;
      if (leadName) {
        this.messageBus.send('system', leadName, `Specialist "${name}" failed: ${agent.error}`);
      }

      this.notifyLeadIfReviewRoundReady();
      this.resolveStrandedStandbys();
    });

    this.specialistPromises.set(name, promise);
    return agent.agentId;
  }

  synthesizeResult(result: string): void {
    if (this.completionResolved) {
      return;
    }
    // TERMINAL GUARANTEE: every completion path funnels through here (explicit synthesis, lead turn-end
    // auto-fallback, lead crash/fail, cancel). If a brief conflict is still open, PREPEND a prominent
    // unresolved block so it can never be silently dropped, and persist the unresolved record.
    let finalResult = result;
    if (this.briefConflicts.size > 0) {
      const list = this.getOpenBriefConflicts().map(c => `- ${c.name}: ${c.detail}`).join('\n');
      finalResult =
        `⚠️ UNRESOLVED BRIEF CONFLICTS — the team completed with brief conflicts that were never reconciled:\n${list}\n\n` +
        `These flagged conflicts with the authoritative mission-brief were NOT resolved via team_request_revision ` +
        `or team_resolve_brief_conflict. Treat the result below as SUSPECT until they are addressed.\n\n---\n\n${result}`;
      this.persistence.appendTeamEntry({
        type: 'brief-conflict-unresolved',
        teamId: this.config.teamId,
        conflicts: this.getOpenBriefConflicts(),
        timestamp: new Date().toISOString(),
      });
    }
    this.completionResolved = true;
    this.setPhase('synthesizing');

    this.pendingStandby.clear();
    this.confirmedComplete.clear();
    this.nudgeScheduled.clear();
    this.nudgeDelivered.clear();
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
      this.completionResolve(finalResult);
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
    this.nudgeScheduled.delete(name);
    this.nudgeDelivered.delete(name);
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

  /** A specialist raises a hard conflict with the authoritative brief; the lead is woken with the text. */
  flagBriefConflict(name: string, detail: string): void {
    this.briefConflicts.set(name, detail);
    this.persistence.appendTeamEntry({
      type: 'brief-conflict-flagged',
      teamId: this.config.teamId,
      name,
      detail,
      timestamp: new Date().toISOString(),
    });
    const leadName = this.findLeadName();
    if (leadName) {
      this.messageBus.send('system', leadName,
        `[BRIEF CONFLICT] Specialist "${name}" flagged a conflict with the authoritative mission-brief: ${detail}\n\n` +
        `Reconcile it via team_request_revision (fix the task/contract) or team_resolve_brief_conflict ` +
        `(dismiss with a written rationale) before synthesizing.`,
      );
    }
  }

  /** The lead dismisses a specialist's brief-conflict flag with an accountable, persisted rationale. */
  resolveBriefConflict(name: string, resolution: string): void {
    if (!this.briefConflicts.has(name)) {
      throw new Error(`No open brief conflict flagged by "${name}"`);
    }
    this.briefConflicts.delete(name);
    this.persistence.appendTeamEntry({
      type: 'brief-conflict-resolved',
      teamId: this.config.teamId,
      name,
      resolution,
      timestamp: new Date().toISOString(),
    });
  }

  getOpenBriefConflicts(): Array<{ name: string; detail: string }> {
    return [...this.briefConflicts.entries()].map(([name, detail]) => ({ name, detail }));
  }

  requestRevision(specialistName: string, feedback: string): void {
    const agent = this.agents.get(specialistName);
    if (!agent || agent.status !== 'awaiting-review') {
      throw new Error(`Specialist "${specialistName}" is not awaiting review`);
    }
    // A revision round IS the reconcile — it clears that specialist's brief-conflict flag.
    this.briefConflicts.delete(specialistName);
    this.reviewedSpecialists.delete(specialistName);
    this.confirmedComplete.delete(specialistName);
    // A new review round earns a fresh nudge: a standby during the revision is a legitimate wait, not a
    // re-park to convert. Clearing here (not in onKeepAliveResume, which the nudge itself triggers) avoids
    // an insta-convert of unfinished revision work.
    this.nudgeScheduled.delete(specialistName);
    this.nudgeDelivered.delete(specialistName);
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
    const allSettled = dispatched.every(a => isSpecialistSettled(a.status));
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
    const allSettled = dispatched.every(a => isSpecialistSettled(a.status));
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

  /**
   * BEST-EFFORT: re-engage the lead when its turn ends with an open brief conflict. onTurnEnd runs only
   * when keepAlive() is already true (a specialist is still active — see agent-runner.ts:148-150), and
   * the deferred send lands AFTER the wait-resolver is armed, so this reliably wakes the lead for a fresh
   * turn to reconcile. Bounded (CONFLICT_NUDGE_MAX); the tool gate + fail-loud prepend are the hard
   * guarantees, so exhausting the budget never hangs — the team completes fail-loud. Mirrors the
   * stranded-standby nudge idiom but is a SEPARATE mechanism that must not touch standby bookkeeping.
   */
  private nudgeLeadOnOpenConflicts(leadName: string): void {
    if (this.completionResolved || this.briefConflicts.size === 0 || this.conflictNudges >= CONFLICT_NUDGE_MAX) return;
    queueMicrotask(() => {
      // Budget counts DELIVERED nudges, so the increment lives past the guard: if the conflict cleared (or
      // the team completed) during the microtask window, we neither send nor burn budget — a later, distinct
      // conflict still earns its full re-engagement instead of inheriting a wasted count.
      if (this.completionResolved || this.briefConflicts.size === 0 || this.conflictNudges >= CONFLICT_NUDGE_MAX) return;
      this.conflictNudges++;
      const list = this.getOpenBriefConflicts().map(c => `${c.name} (${c.detail})`).join('; ');
      this.messageBus.send('system', leadName, `${CONFLICT_NUDGE_PREFIX}${list}${CONFLICT_NUDGE_SUFFIX}`);
    });
  }

  /**
   * Recover any specialist left in `standby` that no event can wake — no peer is still running, so no
   * scratchpad broadcast or direct message will ever arrive. Without this the team hangs until ESC (see
   * the deadlock analysis in the plan). Runs on every settle path that calls notifyLeadIfReviewRoundReady().
   */
  private resolveStrandedStandbys(): void {
    if (this.completionResolved) return;
    for (const name of [...this.pendingStandby]) {
      const decision = classifyStrandedStandby(name, [...this.agents.values()], this.nudgeDelivered.has(name));
      if (decision === 'nudge') {
        if (this.nudgeScheduled.has(name)) continue;
        this.nudgeScheduled.add(name);
        // Defer the send: the standby specialist's agent-runner arms its wait-resolver only AFTER the
        // current synchronous call stack (this settle path) unwinds — see the wait-resolver arming in
        // AgentRunner's run loop. A synchronous send would land before the waiter exists and be lost;
        // queueMicrotask lands after it. `nudgeDelivered` is set HERE (delivery time), not at schedule
        // time, so a second settle in the same microtask batch cannot convert before the clean turn.
        queueMicrotask(() => {
          if (this.completionResolved || !this.pendingStandby.has(name)) return;
          this.nudgeDelivered.add(name);
          this.messageBus.send('system', name, STRANDED_STANDBY_NUDGE);
        });
      } else if (decision === 'convert') {
        this.convertStrandedStandby(name);
      }
    }
  }

  /**
   * Force a stranded, already-nudged standby into awaiting-review — the exact state a clean
   * reportComplete() produces, so the downstream approve/synthesize flow is unchanged. confirmedComplete
   * is set even at the review-round ceiling (where reportComplete() would have thrown): the recovery's job
   * is to make the state ACTIONABLE for the lead, and both approveSpecialist and isReviewRoundReady gate
   * on confirmedComplete — omitting it here would re-strand the LEAD (unable to approve, revise, or
   * synthesize), reintroducing the very hang this recovery exists to prevent.
   */
  private convertStrandedStandby(name: string): void {
    const agent = this.agents.get(name);
    if (!agent) return;
    this.pendingStandby.delete(name);
    this.confirmedComplete.add(name);
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
  }

  private findLeadName(): string | undefined {
    return [...this.agents.values()].find(a => a.role === 'lead')?.name;
  }

  cancel(): void {
    this.status = 'cancelled';
    this.teamAbort.abort();
    if (!this.completionResolved) {
      this.synthesizeResult(this.buildPartialResults());
    }
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

  /** The team agent transcript path under the pi session dir (mirrors TeamPersistence's layout). */
  private agentLogPath(agentId: string): string | null {
    if (!this.cachedSessionDir) return null;
    return path.join(
      this.cachedSessionDir, this.config.persistenceSessionId,
      'teams', 'agents', `${agentId}.jsonl`,
    );
  }

  /** The lead's MCP context — full coordination surface (spawn/approve/synthesize/cancel/revise). */
  private buildLeadContext(agentId: string, agentName: string): AgentMcpContext {
    return {
      agentId,
      agentName,
      role: 'lead',
      messageBus: this.messageBus,
      scratchpad: this.scratchpad,
      startSpecialist: (name, task, profileId, kind) => this.startSpecialist(name, task, profileId, kind),
      checkBriefReadGate: () => checkBriefReadGate(this.scratchpad, agentName),
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
      flagBriefConflict: () => { throw new Error('Only a specialist can flag a brief conflict'); },
      resolveBriefConflict: (name, resolution) => this.resolveBriefConflict(name, resolution),
      getOpenBriefConflicts: () => this.getOpenBriefConflicts(),
      recordCancelAttempt: (name) => this.cancelAttempts.set(name, Date.now()),
      getCancelAttemptTimestamp: (name) => this.cancelAttempts.get(name),
      getRecentlyCancelledNames: () => {
        const now = Date.now();
        return [...this.cancellationTimestamps.entries()]
          .filter(([, ts]) => now - ts < 30_000)
          .map(([name]) => name);
      },
    };
  }

  /** A specialist's MCP context — lead-only coordination tools throw; standby/report-complete allowed. */
  private buildSpecialistContext(agentId: string, agentName: string): AgentMcpContext {
    return {
      agentId,
      agentName,
      role: 'specialist',
      messageBus: this.messageBus,
      scratchpad: this.scratchpad,
      startSpecialist: () => { throw new Error('Only the lead agent can spawn specialists'); },
      checkBriefReadGate: () => { throw new Error('Only the lead agent spawns specialists'); },
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
      flagBriefConflict: (name, detail) => this.flagBriefConflict(name, detail),
      resolveBriefConflict: () => { throw new Error('Only the lead can resolve a brief conflict'); },
      getOpenBriefConflicts: () => [],
    };
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
