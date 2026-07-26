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
  classifyTerminalContract,
  formatReviewRoundReadyNotification,
  isDeliverableStatus,
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
  ResolvedTeamModel,
} from './types';
import type { ExtensionToWebviewMessage } from '../../shared/types/messages';
import type { TeamState, TeamAgent as WebviewTeamAgent } from '../../shared/types/team';

const MAX_AGENTS = 5;
const SPECIALIST_DRAIN_TIMEOUT_MS = 30_000;
/** The shared, append-only verification ledger seeded at team start. */
export const VERIFICATION_SECTION = 'verification';

/**
 * The lead's delivery policy: direct messages only. Every broadcast (scratchpad notices, ledger
 * appends, rejections) is dropped — the lead drives review from tool results and targeted `system`
 * messages, so a fan-out would re-prompt the largest conversation on the team for content it did not
 * ask for. Exported so tests exercise the real predicate instead of a hand-copied duplicate.
 */
export const leadShouldDeliverMessage = (msg: { to: string | null }): boolean => msg.to !== null;

/**
 * The browser tab scope for one LAUNCH of a team agent. `redispatchSpecialist` deliberately reuses
 * `agentId` so the webview card and the on-disk transcript survive a retry, but tabs must not: a failed
 * attempt keeps its tabs open for inspection with its scope entry already dropped, so a retry reusing
 * the bare agentId would adopt those dead tabs and a later success would close them. Always resolve this
 * at LAUNCH time and capture it in the settle handlers — reading it at settle time would pick up an
 * `attempt` a concurrent redispatch has already bumped.
 */
const browserScopeIdFor = (agent: TeamAgent): string => `${agent.agentId}#${agent.attempt}`;
const MAX_SPECIALIST_REVIEW_ROUNDS = 2;
const CONFLICT_NUDGE_MAX = 2;
const LEAD_REVIEW_STALL_MAX = 2;
const FORCE_COMPLETED_WAKE =
  '[TEAM FORCE-COMPLETED] The review round was abandoned after repeated prompts; the team has been ' +
  'force-completed with partial results. This is your final turn — no further team actions are possible.';
const leadReviewStrandedBanner = (n: number): string =>
  `⚠️ REVIEW ROUND ABANDONED — the lead did not review ${n} specialist(s) in awaiting-review after ` +
  `repeated prompts; the team was force-completed. Treat the result below as SUSPECT.`;
const STRANDED_STANDBY_NUDGE =
  'No peer is still working, so no further peer input is coming. If your work is complete and verified, ' +
  'post any final scratchpad and call team_report_complete now. If you are still blocked, message the ' +
  'lead with team_send_message. Do not call team_standby again.';
const TERMINAL_CONTRACT_NUDGE =
  'You ended a turn without a terminal action. If your work is complete and verified, post your final ' +
  'scratchpad and call `team_report_complete` now. If you are waiting on a peer, call `team_standby`; ' +
  'if blocked, message the lead. A bare turn-end is not allowed — do not end again without one of these.';
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
  // A specialist that ends a turn owing a terminal action (no team_report_complete / team_standby) is
  // held (owedTerminalAction flips keepAlive true → the session parks instead of settling as terminal
  // `completed`), nudged once (deferred — the lost-wakeup rule), then converted to awaiting-review if it
  // re-offends. Same nudge-once-then-convert cadence as stranded-standby recovery. `terminalNudgeScheduled`
  // dedups the microtask; `terminalNudgeDelivered` (set inside the microtask, at delivery time) is the
  // classifier's `alreadyNudged` input. owedTerminalAction and pendingStandby are mutually exclusive.
  private owedTerminalAction = new Set<string>();
  private terminalNudgeScheduled = new Set<string>();
  private terminalNudgeDelivered = new Set<string>();
  // Open brief conflicts a specialist raised (name → detail). While non-empty the lead cannot explicitly
  // synthesize; on lead turn-end it is nudged (bounded); any completion with an open flag fails loud.
  private briefConflicts = new Map<string, string>();
  private conflictNudges = 0;
  // Consecutive lead turn-ends that left an actionable review round open with no review progress. Reset on
  // any review action (approveSpecialist / requestRevision) and on synthesis teardown, so a methodical lead
  // approving one specialist per turn never trips the cap — only a lead ignoring the round for
  // LEAD_REVIEW_STALL_MAX consecutive no-progress turns is stranded.
  private leadReviewStalls = 0;
  // The last [REVIEW ROUND READY] text delivered for the currently-open round. notifyLeadIfReviewRoundReady
  // has six call sites (each closing a documented deadlock hole) with no dedup, so the same state was
  // rendered and re-sent several times per round — each duplicate a full re-prompt of the lead's whole
  // conversation. Comparing the RENDERED STRING rather than enumerating invalidation triggers is what makes
  // this safe: formatReviewRoundReadyNotification is a pure function of exactly the state the lead must
  // see (roster, per-section versions, and the lead's own read cursor), so any change worth a re-prompt
  // necessarily renders differently. Cleared whenever the round is no longer open.
  private lastReviewRoundNotification: string | null = null;

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

    this.installSubscribers();

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
        attempt: 0,
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

    // The shared verification ledger: append-only so every agent can record a full-suite result, and
    // fingerprinted by the extension so a later agent can see that this exact tree state was already
    // verified instead of re-running the suite to be sure.
    this.scratchpad.seedAppendOnly(VERIFICATION_SECTION);

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

    const leadScopeId = browserScopeIdFor(leadAgent);
    const leadCtx = this.buildLeadContext(leadAgent.agentId, leadScopeId, leadSpec.name);

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
        this.nudgeLeadOnOpenReviewRound(leadSpec.name);
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
      shouldDeliverMessage: leadShouldDeliverMessage,
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
      // Auto-close the lead's browser tab(s) only on success; a failed/cancelled lead keeps its tab open
      // for inspection. disposeBrowserScope always drops the scope registry entry (no-op if browser off).
      this.config.engine.disposeBrowserScope(leadScopeId, effectiveStatus === 'completed');
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
      this.config.engine.disposeBrowserScope(leadScopeId, false);
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

      // Force a terminal status on anything the drain timeout left behind. These agents never reached
      // their own settle handler, so this is the ONLY place their browser scope is released — without it
      // a wedged agent's scope entry and tabs outlive the team. Tabs stay OPEN (this is not a real
      // success, and the page is worth inspecting); disposeScope is idempotent, so an agent that later
      // settles anyway does not double-dispose.
      for (const agent of this.agents.values()) {
        if (agent.status === 'pending') {
          agent.status = 'cancelled';
          agent.endTime = Date.now();
        } else if (agent.status === 'running' || agent.status === 'awaiting-review' || agent.status === 'standby' || agent.status === 'monitoring') {
          agent.status = this.status === 'cancelled' ? 'cancelled' : 'completed';
          agent.endTime = Date.now();
        } else {
          continue;
        }
        this.config.engine.disposeBrowserScope(browserScopeIdFor(agent), false);
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

  /**
   * Wire the MessageBus + Scratchpad fan-out: every bus message is persisted as an `agent-message` entry
   * and emitted as a `teamMessage` (the Team Timeline), and every scratchpad mutation is persisted, emitted
   * as a `teamScratchpadUpdate` (the Scratchpad tab), and broadcast as a notice. Installed from `run()`;
   * a test drives it directly to cover the runner<->agent seam without a live pi engine.
   */
  private installSubscribers(): void {
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

      // The broadcast still fires for every write: it feeds the `agent-message` JSONL record, the
      // `teamMessage` timeline emission, and `getInbox`/`team_read_messages`. Only DELIVERY is selective
      // — the message kind lets each agent's shouldDeliverMessage decide, so a running agent is never
      // re-prompted mid-task by a peer's write. A ledger append is a distinct kind that reaches no
      // inbox at all: it is pull-only, so waking a standby agent for a peer's test run would re-prompt
      // a whole conversation with content that cannot advance it.
      this.messageBus.broadcast(
        entry.author,
        `[Scratchpad update] "${entry.section}" updated by ${entry.author} (v${entry.version})`,
        this.scratchpad.isAppendOnly(entry.section) ? 'ledger-notice' : 'scratchpad-notice',
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
  }

  startSpecialist(name: string, task: string, profileId?: string, kind?: SpecialistKind): string {
    // Unlike approve/revision/cancel (whose status guards throw naturally once synthesizeResult released
    // every agent to completed), a pending agent would still pass this method's guards after completion —
    // and launch a real LLM session killed only by the drain window. Fail loud instead.
    if (this.completionResolved) {
      throw new Error('Team already completed — no further team actions are possible');
    }
    const agent = this.agents.get(name);
    if (!agent) {
      throw new Error(`Unknown agent: ${name}`);
    }
    if (agent.status !== 'pending') {
      const reRun = (agent.status === 'failed' || agent.status === 'cancelled')
        ? ' — use team_redispatch_specialist to re-run it'
        : '';
      throw new Error(`Agent "${name}" already spawned (status: ${agent.status})${reRun}`);
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

    // Any lead progress action resets the stall budget (consecutive-stall semantics): a lead spawning
    // work is not stranded, even if an open review round outlives this turn.
    this.leadReviewStalls = 0;

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

    // Fresh spawn: serialize the runner start on initAgentFile (creates/TRUNCATES the transcript file).
    const initPromise = this.persistence.initAgentFile(this.config.teamId, agent.agentId);
    this.launchSpecialist(name, agent, task, resolution, domainProfile, initPromise);
    return agent.agentId;
  }

  /**
   * Shared session-launch body for both fresh spawns (`startSpecialist`) and re-runs
   * (`redispatchSpecialist`). PURE extraction — builds the specialist prompt, wires the AbortController +
   * team-abort propagation, constructs the AgentRunConfig closures, starts the runner, and records the
   * promise. Callers own agent-state mutation, persistence, and the `teamAgentStatusUpdate` emit.
   *
   * `initPromise` gates the runner start: the fresh path passes `initAgentFile(...)` so the runner starts
   * only after the transcript file exists; the redispatch path passes `Promise.resolve()` so the runner
   * starts WITHOUT touching the transcript (initAgentFile fs.writeFile-truncates — persistence.ts:57-67).
   */
  private launchSpecialist(
    name: string,
    agent: TeamAgent,
    task: string,
    resolution: ResolvedTeamModel,
    domainProfile: DomainProfile | undefined,
    initPromise: Promise<void>,
  ): void {
    const leadAgent = [...this.agents.values()].find(a => a.role === 'lead');
    const specialistPrompt = buildSpecialistSystemPrompt(
      name,
      this.config.title,
      task,
      leadAgent?.name ?? 'lead',
      domainProfile,
      this.config.permissionMode,
    );

    // Resolved ONCE per launch and captured by both settle handlers below: a redispatch bumps
    // `agent.attempt`, so re-reading it at settle time would dispose the NEW attempt's scope.
    const browserScopeId = browserScopeIdFor(agent);
    const specialistCtx = this.buildSpecialistContext(agent.agentId, browserScopeId, name);

    const specialistAbort = new AbortController();
    this.specialistAborts.set(name, specialistAbort);
    // Propagate a team-wide abort. If the team already aborted before this specialist spawned, the
    // 'abort' event won't fire again, so abort eagerly; otherwise listen once (auto-removed on fire).
    if (this.teamAbort.signal.aborted) {
      specialistAbort.abort();
    } else {
      this.teamAbort.signal.addEventListener('abort', () => specialistAbort.abort(), { once: true });
    }

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
        if (this.owedTerminalAction.has(name)) return true;
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
        // A ledger append never re-prompts anyone: it is a pull surface, and a peer's test run cannot
        // advance an agent parked on someone's findings.
        if (msg.kind === 'ledger-notice') {
          return false;
        }
        // A scratchpad notice re-prompts only an agent that is actually waiting for peer content. A
        // `running` specialist pulls shared state with team_read_scratchpad when it needs it (both
        // specialist prompts require reading peer sections before reporting complete), so pushing every
        // peer write at it only pays for its whole context again. Standby is the state whose entire
        // purpose is to wake on peer content, so it still receives them.
        if (msg.kind === 'scratchpad-notice' && !this.pendingStandby.has(name)) {
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
      onReconcileBeforeEnd: () => this.reconcileTerminalContract(name),
      onKeepAliveResume: () => {
        this.pendingStandby.delete(name);
        // Discharge the grace hold on wake (mirror pendingStandby). Do NOT clear the nudge-tracking sets
        // here: the deferred nudge is what woke the agent, so clearing terminalNudgeDelivered would let
        // the classifier re-nudge on the next bare end forever instead of converting.
        this.owedTerminalAction.delete(name);
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
      // Auto-close this specialist's browser tab(s) only on success; a failed/cancelled specialist keeps
      // its tab open for inspection. disposeBrowserScope always drops the scope registry entry.
      this.config.engine.disposeBrowserScope(browserScopeId, effectiveStatus === 'completed');
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
      this.config.engine.disposeBrowserScope(browserScopeId, false);

      const leadName = [...this.agents.values()].find(a => a.role === 'lead')?.name;
      if (leadName) {
        this.messageBus.send('system', leadName, `Specialist "${name}" failed: ${agent.error}`);
      }

      this.notifyLeadIfReviewRoundReady();
      this.resolveStrandedStandbys();
    });

    this.specialistPromises.set(name, promise);
  }

  /**
   * Re-run a `failed` or `cancelled` specialist as a fresh attempt. REUSES the existing `agentId` and
   * PRESERVES the prior transcript (never calls initAgentFile — that fs.writeFile-truncates). `completed`
   * is terminal (redo an approved role via revision, not re-dispatch). Resets all per-attempt bookkeeping
   * so a full fresh review round can run, but does NOT clear open briefConflicts (safety flags are never
   * silently dropped — the lead resolves those via the status-independent team_resolve_brief_conflict).
   */
  redispatchSpecialist(name: string, task: string, profileId?: string, kind?: SpecialistKind): string {
    // Same post-completion hole as startSpecialist: a failed/cancelled agent passes the status guards
    // after synthesizeResult, so without this a late redispatch would launch a real session.
    if (this.completionResolved) {
      throw new Error('Team already completed — no further team actions are possible');
    }
    const agent = this.agents.get(name);
    if (!agent) {
      throw new Error(`Unknown agent: ${name}`);
    }
    if (agent.role !== 'specialist') {
      throw new Error(`Agent "${name}" is not a specialist`);
    }
    if (agent.status === 'pending') {
      throw new Error(`Agent "${name}" has never been dispatched (status: pending) — use team_spawn_specialist to start it`);
    }
    if (agent.status === 'completed') {
      throw new Error(`Agent "${name}" is completed — approved work is final; cover the gap with team_request_revision or a new task assignment, not a redispatch`);
    }
    if (agent.status !== 'failed' && agent.status !== 'cancelled') {
      throw new Error(`Agent "${name}" is still active (status: ${agent.status}) — only failed or cancelled specialists can be re-dispatched`);
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

    // Resolve the role model BEFORE mutating agent state (same fail-safe ordering as startSpecialist):
    // a configured-but-unresolvable/unauthed slot throws here, leaving the agent 'failed'/'cancelled'
    // rather than stranded in a ghost 'running' state that eats a MAX_AGENTS slot and blocks re-dispatch.
    const resolution = this.config.resolveRoleModel(kind ?? 'implementor');
    if (resolution.error) throw new Error(resolution.error);

    // Any lead progress action resets the stall budget: cancel→redispatch recovery must earn the lead a
    // fresh nudge allowance, never burn it toward force-synthesis.
    this.leadReviewStalls = 0;

    // Clear ALL per-attempt bookkeeping keyed by name — this reset IS the fresh attempt: the keepAlive /
    // onTurnEnd / shouldDeliverMessage closures capture `name` and read these live maps, so emptying them
    // restores fresh-spawn behavior for the re-run. briefConflicts is intentionally NOT cleared.
    this.specialistReviewRounds.delete(name);
    this.reviewedSpecialists.delete(name);
    this.confirmedComplete.delete(name);
    this.pendingStandby.delete(name);
    this.nudgeScheduled.delete(name);
    this.nudgeDelivered.delete(name);
    this.owedTerminalAction.delete(name);
    this.terminalNudgeScheduled.delete(name);
    this.terminalNudgeDelivered.delete(name);
    this.cancelAttempts.delete(name);
    this.cancellationTimestamps.delete(name);

    // A specialist cancelled straight from `pending` never launched: initAgentFile was never called, so
    // this redispatch IS its first real launch — init the transcript (nothing to truncate). startTime is
    // the launch discriminator (set unconditionally by every launch path); logFilePath is NOT reliable
    // here — agentLogPath returns null while cachedSessionDir is unset, so a launched agent can carry a
    // null path and must never be re-inited (that would truncate its transcript).
    const firstLaunch = agent.startTime === null;
    if (agent.logFilePath === null) {
      agent.logFilePath = this.agentLogPath(agent.agentId);
    }

    // Reset agent to a fresh running attempt. KEEP agentId (webview keys cards by it) and logFilePath
    // (reuse the existing transcript path — do NOT recompute). `attempt` advances so this launch gets a
    // clean browser scope instead of inheriting the tabs the failed attempt left open.
    agent.attempt++;
    agent.specialization = task;
    agent.status = 'running';
    agent.startTime = Date.now();
    agent.endTime = null;
    agent.error = null;
    agent.finalResponse = null;
    agent.toolCallCount = 0;
    agent.profileId = profileId ?? null;
    agent.model = resolution.modelLabel ?? '';

    // Transcript preservation: do NOT call initAgentFile (it truncates). Append an agent-spawned entry
    // carrying a `reattempt: true` marker — the loader's agent-spawned branch re-sets status/agentId and
    // tolerates the extra field (entries are Record<string, unknown>).
    this.persistence.appendTeamEntry({
      type: 'agent-spawned',
      teamId: this.config.teamId,
      agentId: agent.agentId,
      name: agent.name,
      role: 'specialist',
      specialization: task,
      model: agent.model,
      profileId: agent.profileId,
      reattempt: true,
      timestamp: new Date().toISOString(),
    });

    // Emit a status update on the EXISTING agentId — no new webview message type (cards are keyed by id).
    this.onMessage({
      type: 'teamAgentStatusUpdate',
      teamId: this.config.teamId,
      agentId: agent.agentId,
      status: 'running',
      logFilePath: agent.logFilePath,
      ...(agent.model ? { model: agent.model } : {}),
    });

    // Redispatch path: skip initAgentFile (preserve the transcript) unless this is the agent's first real
    // launch (cancelled-from-pending — no transcript exists yet). launchSpecialist installs a fresh
    // AbortController, re-wires teamAbort propagation, and overwrites specialistPromises — the old
    // controller is already aborted/settled, so overwriting the map entries is correct (no leak).
    const initPromise = firstLaunch
      ? this.persistence.initAgentFile(this.config.teamId, agent.agentId)
      : Promise.resolve();
    this.launchSpecialist(name, agent, task, resolution, domainProfile, initPromise);
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
    this.owedTerminalAction.clear();
    this.terminalNudgeScheduled.clear();
    this.terminalNudgeDelivered.clear();
    this.specialistReviewRounds.clear();
    this.reviewedSpecialists.clear();
    this.cancelAttempts.clear();
    this.cancellationTimestamps.clear();
    this.leadReviewStalls = 0;
    this.closeReviewRoundNotification();

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
    // Any lead progress action resets the stall budget — cancelling a specialist settles it (often
    // closing the open round), which is review progress, not a stall.
    this.leadReviewStalls = 0;
    this.pendingStandby.delete(name);
    this.confirmedComplete.delete(name);
    this.nudgeScheduled.delete(name);
    this.nudgeDelivered.delete(name);
    this.owedTerminalAction.delete(name);
    this.terminalNudgeScheduled.delete(name);
    this.terminalNudgeDelivered.delete(name);
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
    // Any lead progress action resets the stall budget — resolving a conflict is mandated gate work the
    // lead is instructed to do before reviewing; it must never burn the nudge budget.
    this.leadReviewStalls = 0;
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
    // A review action is progress: reset the stall budget (consecutive-stall semantics, mirrors approveSpecialist).
    this.leadReviewStalls = 0;
    // A revision round IS the reconcile — it clears that specialist's brief-conflict flag.
    this.briefConflicts.delete(specialistName);
    this.reviewedSpecialists.delete(specialistName);
    this.confirmedComplete.delete(specialistName);
    // A new review round earns a fresh nudge: a standby during the revision is a legitimate wait, not a
    // re-park to convert. Clearing here (not in onKeepAliveResume, which the nudge itself triggers) avoids
    // an insta-convert of unfinished revision work.
    this.nudgeScheduled.delete(specialistName);
    this.nudgeDelivered.delete(specialistName);
    this.owedTerminalAction.delete(specialistName);
    this.terminalNudgeScheduled.delete(specialistName);
    this.terminalNudgeDelivered.delete(specialistName);
    const rounds = (this.specialistReviewRounds.get(specialistName) ?? 0) + 1;
    this.specialistReviewRounds.set(specialistName, rounds);
    // A revision reopens work, so the notification for the round it produces is a NEW fact even when it
    // renders identically (a specialist can revise without bumping a section version). Dropping the
    // baseline here keeps suppression from swallowing the "the revision landed" signal.
    this.closeReviewRoundNotification();
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
    // A legitimate terminal action discharges the owed hold (preserves owed/standby mutual exclusion).
    this.owedTerminalAction.delete(agentName);
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
    // A legitimate terminal action discharges the owed hold (preserves owed/standby mutual exclusion).
    this.owedTerminalAction.delete(agentName);
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
    // A review action is progress: reset the stall budget so the lead earns a fresh nudge allowance for the
    // remaining round (consecutive-stall semantics — a methodical lead never trips the force-synthesis cap).
    this.leadReviewStalls = 0;
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
    // Every path that means "no round is open right now" also closes the suppression window, so a later
    // round always earns a fresh notification even if it renders the same text as a previous one.
    if (dispatched.length === 0) return this.closeReviewRoundNotification();
    const allSettled = dispatched.every(a => isSpecialistSettled(a.status));
    if (!allSettled) return this.closeReviewRoundNotification();

    const unreviewed = dispatched
      .filter(a => a.status === 'awaiting-review' && !this.reviewedSpecialists.has(a.name));
    const leadName = this.findLeadName();
    if (!leadName) return this.closeReviewRoundNotification();

    const pendingNames = this.getPendingSpecialistNames();
    const notification = formatReviewRoundReadyNotification(unreviewed, this.scratchpad, leadName, pendingNames);
    if (!notification) return this.closeReviewRoundNotification();
    // Suppress a notification the lead already holds verbatim: re-prompting a ~200k-token conversation
    // with text identical to the last one buys nothing. This applies ONLY here — nudgeLeadOnOpenReviewRound
    // deliberately re-fires identical text to break a lead stall, and its stall budget is what eventually
    // triggers forceSynthesizeStrandedReview, so suppressing it would let a stalled lead hang forever.
    if (notification === this.lastReviewRoundNotification) return;
    this.lastReviewRoundNotification = notification;
    this.messageBus.send('system', leadName, notification);
  }

  /** Drop the suppression baseline — the round the stored text described is no longer open. */
  private closeReviewRoundNotification(): void {
    this.lastReviewRoundNotification = null;
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
   * BEST-EFFORT liveness for a stranded review round: re-fire [REVIEW ROUND READY] when the lead's turn ends
   * with an actionable round still open and no review progress made this turn. onTurnEnd runs only when
   * keepAlive() is already true (an awaiting-review specialist keeps the lead parked-alive), and the deferred
   * send lands AFTER the wait-resolver is armed, so it reliably wakes the lead for a fresh review turn.
   * Bounded by LEAD_REVIEW_STALL_MAX CONSECUTIVE no-progress turns — the budget measures STALL, not total
   * nudges, and resets on any review action (approveSpecialist / requestRevision), so a methodical lead
   * approving one of several specialists per turn never trips the cap. When the budget exhausts with the
   * round still open, force a fail-loud synthesis so the team can never hang. SEPARATE mechanism from the
   * conflict nudge; both may run on the same turn-end.
   */
  private nudgeLeadOnOpenReviewRound(leadName: string): void {
    if (this.completionResolved || !this.isReviewRoundReady()) return;
    if (this.leadReviewStalls >= LEAD_REVIEW_STALL_MAX) {
      this.forceSynthesizeStrandedReview(leadName);
      return;
    }
    queueMicrotask(() => {
      // Budget counts DELIVERED nudges over a still-open round, so the increment lives past the guard: if the
      // lead reviewed (round no longer ready) or the team completed during the microtask window, we neither
      // send nor burn budget. The notification is (re)computed HERE, inside the microtask, because the round
      // membership can change in the window — mirror notifyLeadIfReviewRoundReady exactly.
      if (this.completionResolved || !this.isReviewRoundReady()) return;
      const dispatched = [...this.agents.values()]
        .filter(a => a.role === 'specialist' && a.status !== 'pending');
      const unreviewed = dispatched
        .filter(a => a.status === 'awaiting-review' && !this.reviewedSpecialists.has(a.name));
      const pendingNames = this.getPendingSpecialistNames();
      const notification = formatReviewRoundReadyNotification(unreviewed, this.scratchpad, leadName, pendingNames);
      if (!notification) return;
      this.leadReviewStalls++;
      this.messageBus.send('system', leadName, notification);
    });
  }

  /**
   * Fail-loud terminal path when the lead abandons an open review round past the nudge budget: synthesize
   * with a SUSPECT banner + partial results so the run resolves instead of hanging. The banner is placed at
   * the FRONT of the text passed to synthesizeResult, which itself PREPENDS its own unresolved-brief-conflict
   * block when conflicts are open — the two banners compose (conflict block first, then SUSPECT banner, then
   * partial results); we deliberately do not touch that prepend.
   *
   * Verified concurrency trap: this fires from the lead's onTurnEnd — AFTER the loop's keepAlive check
   * passed, BEFORE the lead parks. synthesizeResult resolves completion but sends the lead nothing, so the
   * lead would park anyway and run()'s drain (which ignores `monitoring`) would stall the full 30s
   * SPECIALIST_DRAIN_TIMEOUT_MS. The deferred wake message lands after the wait-resolver is armed and wakes
   * the lead for one final informational turn; it then exits cleanly because keepAlive is now false
   * (completionResolved). Any late tool calls fail harmlessly against completionResolved guards. We must
   * NEVER abort the lead here — the abort listener is once:true and fires before waitResolve is armed, which
   * leaks the lead runner promise (the lost-wakeup rule).
   */
  private forceSynthesizeStrandedReview(leadName: string): void {
    const n = this.getUnreviewedSpecialistNames().length;
    this.synthesizeResult(leadReviewStrandedBanner(n) + '\n\n' + this.buildPartialResults());
    queueMicrotask(() => this.messageBus.send('system', leadName, FORCE_COMPLETED_WAKE));
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

  /**
   * Handle a specialist that ended a turn owing a terminal action (keepAlive was false — neither
   * confirmedComplete nor pendingStandby). Called from the specialist AgentRunConfig's
   * onReconcileBeforeEnd hook at the keepAlive-false boundary, BEFORE the runner breaks out and settles
   * the session as terminal `completed` (the root deadlock). Same nudge-once-then-convert cadence as
   * resolveStrandedStandbys. The caller (runner) re-checks keepAlive after this returns, so arming
   * owedTerminalAction here parks the agent for a grace turn instead of ending it.
   */
  private reconcileTerminalContract(name: string): void {
    if (this.completionResolved) return;
    const decision = classifyTerminalContract(
      name,
      [...this.agents.values()],
      this.terminalNudgeDelivered.has(name),
      (this.specialistReviewRounds.get(name) ?? 0) >= MAX_SPECIALIST_REVIEW_ROUNDS,
    );
    if (decision === 'nudge') {
      if (this.terminalNudgeScheduled.has(name)) return;
      this.terminalNudgeScheduled.add(name);
      // owedTerminalAction flips keepAlive true so the re-check in the runner parks the agent instead of
      // ending it. The nudge send MUST be deferred: the wait-resolver is armed only after this settle path
      // unwinds (see resolveStrandedStandbys for the same lost-wakeup reasoning). terminalNudgeDelivered
      // is set INSIDE the microtask (delivery time), so a re-entrant reconcile cannot convert before the
      // agent got its clean grace turn.
      this.owedTerminalAction.add(name);
      queueMicrotask(() => {
        if (this.completionResolved || !this.owedTerminalAction.has(name)) return;
        this.terminalNudgeDelivered.add(name);
        this.messageBus.send('system', name, TERMINAL_CONTRACT_NUDGE);
      });
    } else if (decision === 'convert') {
      this.convertOwedTerminalToReview(name);
    }
  }

  /**
   * Force a specialist that re-offended (ended bare again after its nudge + grace turn) into
   * awaiting-review — the exact state a clean reportComplete() produces. Mirror of convertStrandedStandby.
   * confirmedComplete is set so specialist keepAlive returns true (rounds < MAX): the session STAYS parked
   * and revivable via team_request_revision, rather than settling as terminal `completed`. resolveStrandedStandbys
   * runs too because this convert can be the last settle in the round, stranding a standby peer (mirror the
   * awaiting-review branch of the specialist onTurnEnd).
   */
  private convertOwedTerminalToReview(name: string): void {
    const agent = this.agents.get(name);
    if (!agent) return;
    this.owedTerminalAction.delete(name);
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
    this.resolveStrandedStandbys();
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

  /** Whether a message to `name` can be delivered now. A dead agent unsubscribes from the bus on exit,
   *  so a send to a terminal/pending recipient is silently dropped — this lets the tool fail loud instead. */
  // Role-aware copy: team_spawn_specialist / team_redispatch_specialist are lead-only tools, so the
  // recovery guidance must not send a specialist to a tool that throws for it — specialists route
  // through the lead instead.
  private checkMessageDeliverable(name: string, senderRole: 'lead' | 'specialist'): { ok: boolean; error?: string } {
    const agent = this.agents.get(name);
    if (!agent) {
      return { ok: false, error: `Unknown agent "${name}"` };
    }
    if (isDeliverableStatus(agent.status)) {
      return { ok: true };
    }
    if (agent.status === 'pending') {
      return {
        ok: false,
        error: senderRole === 'lead'
          ? `Cannot message '${name}' — they have not been spawned yet and will not be woken by messages. Spawn them with team_spawn_specialist and put the context in the spawn task.`
          : `Cannot message '${name}' — they have not been spawned yet and will not be woken by messages. Message the lead and ask them to spawn '${name}' with the needed context in the spawn task.`,
      };
    }
    return {
      ok: false,
      error: senderRole === 'lead'
        ? `Cannot message '${name}' — they are ${agent.status} and no longer receiving messages. Read their scratchpad section with team_read_scratchpad, or (if failed/cancelled) re-run them with team_redispatch_specialist.`
        : `Cannot message '${name}' — they are ${agent.status} and no longer receiving messages. Read their scratchpad section with team_read_scratchpad, or message the lead if their work needs to be re-run.`,
    };
  }

  /** The lead's MCP context — full coordination surface (spawn/approve/synthesize/cancel/revise). */
  private buildLeadContext(agentId: string, browserScopeId: string, agentName: string): AgentMcpContext {
    return {
      agentId,
      browserScopeId,
      agentName,
      role: 'lead',
      messageBus: this.messageBus,
      scratchpad: this.scratchpad,
      startSpecialist: (name, task, profileId, kind) => this.startSpecialist(name, task, profileId, kind),
      redispatchSpecialist: (name, task, profileId, kind) => this.redispatchSpecialist(name, task, profileId, kind),
      checkBriefReadGate: () => checkBriefReadGate(this.scratchpad, agentName),
      checkMessageDeliverable: (name) => this.checkMessageDeliverable(name, 'lead'),
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
      // Deliberately ungated: unlike a specialist's own section, the ledger is NOT wired into
      // checkApprovalReadGate. It is `system`-authored, so it never appears in getSectionsAuthoredBy,
      // and gating on it would re-block the lead's approval every time any agent records any run —
      // including runs irrelevant to the specialist under review. The prompt's "check verification
      // against the ledger" is guidance backed by the tool returning the ledger on every record.
      recordVerification: (entry) => this.scratchpad.appendTo(VERIFICATION_SECTION, entry, agentName),
      readVerificationLedger: () => this.scratchpad.get(VERIFICATION_SECTION)?.content ?? '',
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
  private buildSpecialistContext(agentId: string, browserScopeId: string, agentName: string): AgentMcpContext {
    return {
      agentId,
      browserScopeId,
      agentName,
      role: 'specialist',
      messageBus: this.messageBus,
      scratchpad: this.scratchpad,
      startSpecialist: () => { throw new Error('Only the lead agent can spawn specialists'); },
      redispatchSpecialist: () => { throw new Error('Only the lead agent can spawn specialists'); },
      checkBriefReadGate: () => { throw new Error('Only the lead agent spawns specialists'); },
      checkMessageDeliverable: (name) => this.checkMessageDeliverable(name, 'specialist'),
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
      recordVerification: (entry) => this.scratchpad.appendTo(VERIFICATION_SECTION, entry, agentName),
      readVerificationLedger: () => this.scratchpad.get(VERIFICATION_SECTION)?.content ?? '',
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
