import type { ExtensionToWebviewMessage } from '../../../src/shared/types/messages.ts';
import type { HistoryAgentMessage } from '../../../src/shared/types/content.ts';
import type { SteerTargetInfo } from '../../../src/shared/types/subagents.ts';
import type { TeamAgent, TeamAgentStatus, TeamRunSummary, TeamState } from '../../../src/shared/types/team.ts';
import type { AgentUsageTotals } from '../../../src/shared/usage-accounting.ts';
import { stopStopwatch, type Stopwatch } from '../../../src/shared/team-stopwatch.ts';
import { SID } from './script.ts';
import type { Stage } from './stage.ts';

const words = (text: string) => text.match(/\S+\s*|\s+/g) ?? [];

export interface SubagentSpec {
  toolUseId: string;
  agentId: string;
  agentType: string;
  description: string;
  prompt: string;
  model: string;
  resumedFrom?: string;
}

/** One `Agent` tool call's nested run, reported the way `subagent-stream-bridge.ts` reports it. */
export function subagent(stage: Stage, spec: SubagentSpec) {
  const parent = { parentToolUseId: spec.toolUseId };
  const history: HistoryAgentMessage[] = [{ role: 'user', contentBlocks: [{ type: 'text', text: spec.prompt }] }];
  let seq = 0;
  let toolCount = 0;
  let usage: AgentUsageTotals = { totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 };
  const startedAt = Date.now();

  const streamText = async (messageId: string, text: string, charsPerSecond: number) => {
    let streamed = '';
    for (const w of words(text)) {
      streamed += w;
      await stage.send({ type: 'partial', data: { type: 'partial', content: [], session_id: SID, messageId, streamingText: streamed, isThinking: false }, ...parent });
      await stage.pause((w.length / charsPerSecond) * 1000);
    }
  };

  const bill = async (tokensIn: number, tokensOut: number, cost: number) => {
    usage = {
      totalInputTokens: usage.totalInputTokens + tokensIn,
      totalOutputTokens: usage.totalOutputTokens + tokensOut,
      cacheReadTokens: usage.cacheReadTokens + tokensIn * 6,
      cacheCreationTokens: usage.cacheCreationTokens,
      costUsd: usage.costUsd + cost,
    };
    await stage.send({ type: 'subagentUsageUpdate', agentToolId: spec.toolUseId, usage, dollarBilled: false });
  };

  return {
    spec,
    async start(): Promise<void> {
      await stage.send(
        { type: 'subagentStart', agentId: spec.agentId, agentType: spec.agentType, toolUseId: spec.toolUseId, isBackground: false, description: spec.description, ...(spec.resumedFrom ? { resumedFrom: spec.resumedFrom } : {}) },
        { type: 'subagentModelUpdate', agentToolId: spec.toolUseId, model: spec.model },
      );
    },

    /** One assistant message: optional streamed text, then one tool call run to completion. */
    async step(text: string, tool: { id: string; name: string; input: Record<string, unknown>; result: string; ms?: number }, charsPerSecond = 120): Promise<void> {
      seq += 1;
      const messageId = `${spec.agentId}:a:${seq}`;
      if (text) await streamText(messageId, text, charsPerSecond);
      const textBlocks = text ? [{ type: 'text' as const, text }] : [];
      const call = { type: 'tool_use' as const, id: tool.id, name: tool.name, input: tool.input };
      await stage.send({ type: 'assistant', data: { type: 'assistant', message: { id: messageId, role: 'assistant', content: [...textBlocks, call], model: '', stop_reason: null }, session_id: SID }, ...parent });
      await bill(900 + text.length * 3, 60 + text.length, 0.004);
      await stage.send({ type: 'toolPending', toolUseId: tool.id, toolName: tool.name, input: tool.input, ...parent });
      await stage.pause(tool.ms ?? 700);
      await stage.send({ type: 'toolCompleted', toolUseId: tool.id, toolName: tool.name, result: tool.result, durationMs: tool.ms ?? 700, ...parent });
      toolCount += 1;
      history.push({ role: 'assistant', contentBlocks: [...textBlocks, { ...call, result: tool.result }] });
    },

    async answer(text: string, charsPerSecond = 160): Promise<void> {
      seq += 1;
      const messageId = `${spec.agentId}:a:${seq}`;
      await streamText(messageId, text, charsPerSecond);
      await stage.send({ type: 'assistant', data: { type: 'assistant', message: { id: messageId, role: 'assistant', content: [{ type: 'text', text }], model: '', stop_reason: null }, session_id: SID }, ...parent });
      await bill(1200, 180, 0.006);
      history.push({ role: 'assistant', contentBlocks: [{ type: 'text', text }] });
    },

    /** The seal, the Agent tool's result and the stop, in `bridge.finish` order. */
    finishMessages(status: 'completed' | 'stopped', text: string): ExtensionToWebviewMessage[] {
      const note = status === 'stopped'
        ? ` (STOPPED BY THE USER before completion; output is partial. Resume it with Agent({resume:"${spec.agentId}"}) if the user asks to continue.)`
        : '';
      const durationMs = Date.now() - startedAt;
      const result = JSON.stringify({
        content: [{ type: 'text', text: text + note }],
        totalDurationMs: durationMs,
        totalTokens: usage.totalInputTokens + usage.totalOutputTokens + usage.cacheReadTokens,
        totalToolUseCount: toolCount,
        agentId: spec.agentId,
        agentStatus: status,
      });
      return [
        { type: 'subagentMessagesUpdate', agentToolId: spec.toolUseId, messages: [...history] },
        { type: 'toolCompleted', toolUseId: spec.toolUseId, toolName: 'Agent', result, durationMs },
        { type: 'subagentStop', agentId: spec.agentId, toolUseId: spec.toolUseId, lastAssistantMessage: text + note },
      ];
    },
  };
}

export type Subagent = ReturnType<typeof subagent>;

/**
 * Sends `/steer ` through the real composer, answers the picker with `targets`, picks the row showing
 * `rowText`, types `instruction`, and returns the `steerAgent` the webview posts.
 */
export async function steer(stage: Stage, targets: SteerTargetInfo[], rowText: string, instruction: string) {
  stage.respond('requestSteerTargets', () => [{ type: 'steerTargets', agents: targets }]);
  const input = stage.page.locator('textarea').first();
  await stage.typeInto(input, '/steer ', { delayMs: 60 });
  const popup = stage.page.getByRole('listbox').filter({ hasText: rowText }).last();
  const row = popup.getByRole('option').filter({ hasText: rowText }).first();
  await row.waitFor();
  await stage.focus([popup, input], { maxZoom: 1.5 });
  await stage.pause(900);
  await stage.click(row);
  await input.focus();
  await stage.page.keyboard.press('End');
  await stage.pause(300);
  await input.pressSequentially(instruction, { delay: 26 });
  await stage.pause(300);
  const posted = stage.waitForPost('steerAgent');
  await stage.page.keyboard.press('Enter');
  const msg = await posted;
  stage.unfocus();
  return msg;
}

export interface MemberSpec {
  agentId: string;
  name: string;
  role: 'lead' | 'specialist';
  model: string;
}

const zeroUsage = (): AgentUsageTotals => ({ totalInputTokens: 0, totalOutputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 });

const TERMINAL: ReadonlySet<TeamAgentStatus> = new Set(['completed', 'failed', 'cancelled']);

function teamAgent(m: MemberSpec, status: TeamAgentStatus, stopwatch: Stopwatch): TeamAgent {
  return {
    agentId: m.agentId, name: m.name, role: m.role, specialization: '', model: m.model, profileId: null, attempt: 0, status,
    ...stopwatch, toolCount: 0, lastToolName: null, totalInputTokens: 0, totalOutputTokens: 0,
    cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, dollarBilled: false, effort: null, progressSummary: null, result: null, logFilePath: null,
  };
}

/** A team run, reported the way `team-runner.ts` and `agent-runner.ts` report it. */
export function team(stage: Stage, opts: { teamId: string; toolUseId: string; title: string; members: MemberSpec[] }) {
  const { teamId } = opts;
  const startTime = Date.now();
  const usage = new Map<string, AgentUsageTotals>(opts.members.map((m) => [m.agentId, zeroUsage()]));
  const stopwatches = new Map<string, Stopwatch>(opts.members.map((m) => [m.agentId, { activeMs: 0, runningSince: null }]));
  // A launch or resume opens a member's stopwatch and its settle closes it, as the team runner's entries do.
  const tick = (m: MemberSpec, status: TeamAgentStatus): Stopwatch => {
    const current = stopwatches.get(m.agentId)!;
    const next = TERMINAL.has(status) ? stopStopwatch(current, Date.now())
      : status !== 'pending' && current.runningSince === null ? { ...current, runningSince: Date.now() }
      : current;
    stopwatches.set(m.agentId, next);
    return next;
  };
  let toolCount = 0;
  let toolSeq = 0;
  let messageSeq = 0;
  const runUsage = (): AgentUsageTotals => [...usage.values()].reduce((a, u) => ({
    totalInputTokens: a.totalInputTokens + u.totalInputTokens,
    totalOutputTokens: a.totalOutputTokens + u.totalOutputTokens,
    cacheReadTokens: a.cacheReadTokens + u.cacheReadTokens,
    cacheCreationTokens: a.cacheCreationTokens + u.cacheCreationTokens,
    costUsd: a.costUsd + u.costUsd,
  }), zeroUsage());
  const member = (name: string) => {
    const m = opts.members.find((x) => x.name === name);
    if (!m) throw new Error(`no team member "${name}"`);
    return m;
  };

  const api = {
    state(runs: TeamRunSummary[], status: TeamState['status'], agentStatus: (m: MemberSpec) => TeamAgentStatus): TeamState {
      return {
        teamId, toolUseId: opts.toolUseId, title: opts.title, status, phase: status === 'running' ? 'working' : 'initializing',
        agents: opts.members.map((m) => teamAgent(m, agentStatus(m), tick(m, agentStatus(m)))), messages: [], scratchpad: [], result: null,
        startTime, endTime: null, totalToolCount: 0, runs,
      };
    },

    run(toolUseId: string, status: TeamRunSummary['status'], since: number): TeamRunSummary {
      return { toolUseId, status, startTime: since, endTime: status === 'running' ? null : Date.now(), toolCount, usage: runUsage() };
    },

    async status(name: string, status: TeamAgentStatus, progressSummary?: string): Promise<void> {
      const m = member(name);
      await stage.send({ type: 'teamAgentStatusUpdate', teamId, agentId: m.agentId, status, model: m.model, ...(progressSummary ? { progressSummary } : {}), stopwatch: tick(m, status) });
    },

    async phase(phase: TeamState['phase']): Promise<void> {
      await stage.send({ type: 'teamPhaseUpdate', teamId, phase });
    },

    /** A member streams `text`, then calls one tool and gets its result. */
    async work(name: string, text: string, tool?: { name: string; input: Record<string, unknown>; result: string; ms?: number }): Promise<void> {
      const m = member(name);
      for (const w of words(text)) {
        await stage.send({ type: 'teamAgentStreamDelta', teamId, agentId: m.agentId, deltaType: 'text', text: w });
        await stage.pause((w.length / 150) * 1000);
      }
      const id = tool ? `toolu_team_${++toolSeq}` : '';
      if (tool) await stage.send({ type: 'teamAgentToolCall', teamId, agentId: m.agentId, toolName: tool.name, toolInput: tool.input });
      await stage.send({
        type: 'teamAgentAssistant', teamId, agentId: m.agentId, messageId: `${m.agentId}:m:${++messageSeq}`, timestamp: Date.now(),
        content: [...(text ? [{ type: 'text' as const, text }] : []), ...(tool ? [{ type: 'tool_use' as const, id, name: tool.name, input: tool.input }] : [])],
      });
      const u = usage.get(m.agentId)!;
      const next = { totalInputTokens: u.totalInputTokens + 1800, totalOutputTokens: u.totalOutputTokens + 240, cacheReadTokens: u.cacheReadTokens + 14000, cacheCreationTokens: u.cacheCreationTokens + 900, costUsd: u.costUsd + (m.role === 'lead' ? 0.05 : 0.021) };
      usage.set(m.agentId, next);
      await stage.send({ type: 'teamAgentUsageUpdate', teamId, agentId: m.agentId, ...next });
      if (tool) {
        await stage.pause(tool.ms ?? 600);
        toolCount += 1;
        await stage.send({ type: 'teamAgentToolResult', teamId, agentId: m.agentId, toolUseId: id, result: tool.result, isError: false });
      }
    },

    async message(from: string, to: string | null, content: string): Promise<void> {
      const f = member(from);
      const t = to ? member(to) : null;
      await stage.send({ type: 'teamMessage', teamId, message: { messageId: `msg-${++messageSeq}`, senderAgentId: f.agentId, senderName: f.name, recipientAgentId: t?.agentId ?? null, recipientName: t?.name ?? null, content, timestamp: Date.now() } });
    },

    async scratchpad(from: string, section: string, content: string, version = 1): Promise<void> {
      const f = member(from);
      await stage.send({ type: 'teamScratchpadUpdate', teamId, entry: { section, content, agentId: f.agentId, agentName: f.name, version, timestamp: Date.now() } });
    },

    member,
  };
  return api;
}

export type Team = ReturnType<typeof team>;
