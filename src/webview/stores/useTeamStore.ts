import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import type { TeamState, TeamRunSummary, TeamPhase, TeamAgent, TeamAgentStatus, TeamMessage, ScratchpadEntry, TeamAgentContentBlock, TeamAgentHistoryMessage } from '@shared/types/team';
import type { ToolCall } from '@shared/types/session';
import { isImageBlock, type ImageBlock } from '@shared/types/content';
import { resolveCancelledStatus, TERMINAL_TOOL_STATUSES } from './tool-cancelled-status';
import { ownEntry } from '@/utils/ownEntry';
import { addAgentUsage, emptyAgentUsage, subtractAgentUsage, type AgentUsageTotals } from '@shared/usage-accounting';

export interface AgentStreamingState {
  thinking: string;
  text: string;
  isThinkingPhase: boolean;
  messageId: string | null;
}

export interface AgentChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  contentBlocks?: TeamAgentContentBlock[];
  /** A user message's images, kept out of `contentBlocks` so they never enter `messageKey`. */
  images?: ImageBlock[];
  timestamp: number;
}

type PersistedToolResult = Extract<TeamAgentContentBlock, { type: 'tool_result' }>;

/**
 * The terminal status a reloaded card carries, derived the same way the live path derives it. A call
 * with no persisted result never recorded an outcome, so it reads as `unrecorded` rather than claiming
 * one; `pending` and `running` are pre-terminal and put a spinner and a Stop control on a tool long gone.
 */
function restoredToolStatus(result: PersistedToolResult | undefined): ToolCall['status'] {
  if (!result) return 'unrecorded';
  if (result.is_error === true) return 'failed';
  return resolveCancelledStatus('completed', result.metadata);
}

/**
 * Live and reloaded cards build their blocks with the same host function, so equal role and blocks mean
 * the same message. A live message has no entry id to match on: pi appends it after its listeners run.
 * Images are excluded, so a live and a reloaded copy of an image steer still match.
 */
function messageKey(message: AgentChatMessage): string {
  return JSON.stringify([message.role, message.contentBlocks ?? [{ type: 'text', text: message.content }]]);
}

/**
 * History ahead of live, each message once. Every message the member persisted since this panel began
 * listening also streamed live, so only history's last `live.length` entries can repeat one, and the live
 * copy is kept because its tool statuses are current.
 */
function mergeAgentHistory(history: AgentChatMessage[], live: AgentChatMessage[]): AgentChatMessage[] {
  const unmatched = new Map<string, number>();
  for (const message of live) {
    const key = messageKey(message);
    unmatched.set(key, (unmatched.get(key) ?? 0) + 1);
  }
  const tailStart = history.length - live.length;
  const earlier = history.filter((message, index) => {
    if (index < tailStart) return true;
    const key = messageKey(message);
    const count = unmatched.get(key) ?? 0;
    if (count === 0) return true;
    unmatched.set(key, count - 1);
    return false;
  });
  return [...earlier, ...live];
}

/** Live work counts toward the team's last run only while that run is still running. */
function updateLiveRun(runs: TeamRunSummary[], update: (run: TeamRunSummary) => TeamRunSummary): TeamRunSummary[] {
  const last = runs.at(-1);
  return last?.status === 'running' ? [...runs.slice(0, -1), update(last)] : runs;
}

export const useTeamStore = defineStore('team', () => {
  const teams = ref<Record<string, TeamState>>({});
  const isOverlayOpen = ref(false);
  const selectedTeamId = ref<string | null>(null);
  const activeTab = ref<'agents' | 'timeline' | 'scratchpad' | 'result'>('agents');

  const agentMessages = ref<Record<string, AgentChatMessage[]>>({});
  const agentStreaming = ref<Record<string, AgentStreamingState>>({});
  const agentHistoryLoaded = ref<ReadonlySet<string>>(new Set());
  const selectedAgentId = ref<string | null>(null);
  const isAgentOverlayOpen = ref(false);

  interface PermissionRequest {
    requestId: string;
    teamId: string;
    agentId: string;
    agentName: string;
    toolName: string;
    toolInput: Record<string, unknown>;
  }
  const permissionQueue = ref<PermissionRequest[]>([]);
  const activePermission = computed(() => permissionQueue.value[0] ?? null);

  const selectedTeam = computed(() =>
    selectedTeamId.value ? teams.value[selectedTeamId.value] ?? null : null
  );
  const activeTeams = computed(() =>
    Object.values(teams.value).filter(t => t.status === 'running')
  );
  const activeTeamCount = computed(() => activeTeams.value.length);
  const selectedTeamAgents = computed(() => selectedTeam.value?.agents ?? []);
  const selectedTeamMessages = computed(() => selectedTeam.value?.messages ?? []);
  const selectedTeamScratchpad = computed(() => selectedTeam.value?.scratchpad ?? []);
  const hasResult = computed(() => selectedTeam.value?.result !== null && selectedTeam.value?.result !== undefined);

  function openOverlay(teamId: string): void {
    selectedTeamId.value = teamId;
    isOverlayOpen.value = true;
    activeTab.value = 'agents';
  }

  function closeOverlay(): void {
    isOverlayOpen.value = false;
    selectedTeamId.value = null;
  }

  function setActiveTab(tab: typeof activeTab.value): void {
    activeTab.value = tab;
  }

  function registerTeamFromTool(
    toolUseId: string,
    input: { title?: string; agents?: Array<{ name: string; role: string }> },
    historical?: { status: TeamState['status']; result?: string }
  ): void {
    if (Object.values(teams.value).some(t => t.toolUseId === toolUseId)) return;

    const teamId = `pending-${toolUseId}`;
    const agents: TeamAgent[] = (input.agents ?? []).map((a, i) => ({
      agentId: `${teamId}-agent-${i}`,
      name: a.name,
      role: a.role as 'lead' | 'specialist',
      specialization: '',
      model: '',
      profileId: null,
      attempt: 0,
      status: (historical ? 'completed' : 'pending') as TeamAgentStatus,
      startTime: null,
      endTime: null,
      toolCount: 0,
      lastToolName: null,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      // A team registered from a tool call has no model resolution yet, and unknown billing renders as
      // a charge because understating a real cost is the worse error.
      dollarBilled: true,
      progressSummary: null,
      result: null,
      logFilePath: null,
    }));

    const status = historical?.status ?? 'running';
    const now = Date.now();
    const endTime = historical ? now : null;
    teams.value = {
      ...teams.value,
      [teamId]: {
        teamId,
        toolUseId,
        title: input.title ?? 'Team',
        status,
        phase: historical ? 'complete' : 'initializing',
        agents,
        messages: [],
        scratchpad: [],
        result: historical?.result ?? null,
        startTime: now,
        endTime,
        totalToolCount: 0,
        runs: [{ toolUseId, status, startTime: now, endTime, toolCount: 0, usage: emptyAgentUsage() }],
      },
    };
  }

  function handleTeamStarted(team: TeamState): void {
    const pendingKey = Object.keys(teams.value).find(
      k => k.startsWith('pending-') && teams.value[k]?.toolUseId === team.toolUseId
    );
    if (pendingKey) {
      const { [pendingKey]: _, ...rest } = teams.value;
      teams.value = { ...rest, [team.teamId]: team };
    } else {
      teams.value = { ...teams.value, [team.teamId]: team };
    }
  }

  function handleTeamPhaseUpdate(teamId: string, phase: TeamPhase): void {
    const team = teams.value[teamId];
    if (!team) return;
    teams.value = { ...teams.value, [teamId]: { ...team, phase } };
  }

  // A specialist's billing flag is only known once its role model resolves at spawn, which is after the
  // team list was sent, so an absent field here keeps the agent's current value rather than resetting it.
  function handleAgentStatusUpdate(teamId: string, agentId: string, status: TeamAgentStatus, progressSummary?: string, logFilePath?: string | null, model?: string, dollarBilled?: boolean, attempt?: number): void {
    const team = teams.value[teamId];
    if (!team) return;
    const agents = team.agents.map(a => {
      if (a.agentId !== agentId) return a;
      // A redispatch reuses the agentId, so the fields describing the current run start over while the
      // usage totals keep every attempt's spend. Applied last: this reset outranks the deltas above it.
      const relaunched = attempt !== undefined && attempt > a.attempt
        ? { attempt, toolCount: 0, lastToolName: null, startTime: Date.now(), endTime: null, result: null, progressSummary: null }
        : {};
      return {
        ...a,
        status,
        ...(progressSummary !== undefined ? { progressSummary } : {}),
        ...(logFilePath !== undefined ? { logFilePath } : {}),
        ...(model ? { model } : {}),
        ...(dollarBilled !== undefined ? { dollarBilled } : {}),
        ...(status === 'running' && !a.startTime ? { startTime: Date.now() } : {}),
        ...((status === 'completed' || status === 'failed' || status === 'cancelled') ? { endTime: Date.now() } : {}),
        ...relaunched,
      };
    });
    const totalToolCount = agents.reduce((sum, a) => sum + a.toolCount, 0);
    teams.value = { ...teams.value, [teamId]: { ...team, agents, totalToolCount } };
  }

  function handleAgentUsageUpdate(teamId: string, agentId: string, usage: AgentUsageTotals): void {
    const team = teams.value[teamId];
    if (!team) return;
    const previous = team.agents.find(a => a.agentId === agentId);
    if (!previous) return;
    const agents = team.agents.map(a =>
      a === previous
        ? { ...a, totalInputTokens: usage.totalInputTokens, totalOutputTokens: usage.totalOutputTokens, cacheReadTokens: usage.cacheReadTokens, cacheCreationTokens: usage.cacheCreationTokens, costUsd: usage.costUsd }
        : a
    );
    // The usage is the agent's running total, so only its growth since the last update is this run's.
    const growth = subtractAgentUsage(usage, previous);
    const runs = updateLiveRun(team.runs, r => ({ ...r, usage: addAgentUsage(r.usage, growth) }));
    teams.value = { ...teams.value, [teamId]: { ...team, agents, runs } };
  }

  function handleAgentToolCall(teamId: string, agentId: string, toolName: string): void {
    const team = teams.value[teamId];
    if (!team) return;
    const agents = team.agents.map(a =>
      a.agentId === agentId
        ? { ...a, toolCount: a.toolCount + 1, lastToolName: toolName }
        : a
    );
    const totalToolCount = agents.reduce((sum, a) => sum + a.toolCount, 0);
    const runs = updateLiveRun(team.runs, r => ({ ...r, toolCount: r.toolCount + 1 }));
    teams.value = { ...teams.value, [teamId]: { ...team, agents, totalToolCount, runs } };
  }

  function handleTeamMessage(teamId: string, message: TeamMessage): void {
    const team = teams.value[teamId];
    if (!team) return;
    teams.value = { ...teams.value, [teamId]: { ...team, messages: [...team.messages, message] } };
  }

  function handleScratchpadUpdate(teamId: string, entry: ScratchpadEntry): void {
    const team = teams.value[teamId];
    if (!team) return;
    const existing = team.scratchpad.findIndex(s => s.section === entry.section);
    const scratchpad = existing >= 0
      ? team.scratchpad.map((s, i) => i === existing ? entry : s)
      : [...team.scratchpad, entry];
    teams.value = { ...teams.value, [teamId]: { ...team, scratchpad } };
  }

  // The host's summary of the ended run replaces the live tally, so the card reads what a reload reads.
  function handleTeamCompleted(teamId: string, status: TeamState['status'], result: string | null, run: TeamRunSummary): void {
    const team = teams.value[teamId];
    if (!team) return;
    const known = team.runs.some(r => r.toolUseId === run.toolUseId);
    const runs = known ? team.runs.map(r => (r.toolUseId === run.toolUseId ? run : r)) : [...team.runs, run];
    teams.value = { ...teams.value, [teamId]: { ...team, status, result, endTime: Date.now(), phase: 'complete' as const, runs } };
  }

  function restoreTeamFromHistory(team: TeamState): void {
    teams.value = { ...teams.value, [team.teamId]: team };
  }

  function openAgentOverlay(agentId: string): void {
    selectedAgentId.value = agentId;
    isAgentOverlayOpen.value = true;
  }

  function closeAgentOverlay(): void {
    isAgentOverlayOpen.value = false;
    selectedAgentId.value = null;
  }

  const selectedAgent = computed(() => {
    if (!selectedTeam.value || !selectedAgentId.value) return null;
    return selectedTeam.value.agents.find(a => a.agentId === selectedAgentId.value) ?? null;
  });

  const currentAgentMessages = computed(() =>
    selectedAgentId.value ? agentMessages.value[selectedAgentId.value] ?? [] : []
  );

  const currentAgentStreaming = computed(() =>
    selectedAgentId.value ? agentStreaming.value[selectedAgentId.value] ?? null : null
  );

  function handleAgentStreamDelta(agentId: string, deltaType: 'thinking' | 'text', text: string): void {
    if (!agentStreaming.value[agentId]) {
      agentStreaming.value = { ...agentStreaming.value, [agentId]: { thinking: '', text: '', isThinkingPhase: false, messageId: null } };
    }
    const state = { ...agentStreaming.value[agentId]! };
    if (deltaType === 'thinking') {
      state.thinking += text;
      state.isThinkingPhase = true;
    } else {
      state.text += text;
      state.isThinkingPhase = false;
    }
    agentStreaming.value = { ...agentStreaming.value, [agentId]: state };
  }

  function handleAgentAssistant(agentId: string, messageId: string, content: TeamAgentContentBlock[], timestamp: number): void {
    const textContent = content.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('');
    const thinkingContent = content.filter(b => b.type === 'thinking').map(b => (b as { thinking: string }).thinking).join('\n\n');
    const toolCalls: ToolCall[] = content
      .filter(b => b.type === 'tool_use')
      .map(b => {
        const t = b as { id: string; name: string; input: unknown };
        return { id: t.id, name: t.name, input: typeof t.input === 'object' && t.input !== null ? t.input as Record<string, unknown> : {}, status: 'running' as const };
      });

    const msg: AgentChatMessage = {
      id: messageId,
      role: 'assistant',
      content: textContent,
      ...(thinkingContent ? { thinking: thinkingContent } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
      contentBlocks: content,
      timestamp,
    };

    const current = agentMessages.value[agentId] ?? [];
    agentMessages.value = { ...agentMessages.value, [agentId]: [...current, msg] };

    const { [agentId]: _, ...rest } = agentStreaming.value;
    agentStreaming.value = rest;
  }

  function handleAgentUserMessage(agentId: string, content: string, timestamp: number, images?: ImageBlock[]): void {
    const imageBlocks = images?.filter(isImageBlock) ?? [];
    const msg: AgentChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      ...(imageBlocks.length ? { images: imageBlocks } : {}),
      timestamp,
    };
    const current = agentMessages.value[agentId] ?? [];
    agentMessages.value = { ...agentMessages.value, [agentId]: [...current, msg] };
  }

  function handleAgentToolResult(agentId: string, toolUseId: string, result: string, isError?: boolean, metadata?: Record<string, unknown>): void {
    const msgs = agentMessages.value[agentId];
    if (!msgs) return;
    const updated = [...msgs];
    for (let i = updated.length - 1; i >= 0; i--) {
      const m = updated[i];
      if (!m || m.role !== 'assistant' || !m.toolCalls) continue;
      const toolCalls = m.toolCalls;
      if (!toolCalls.some(t => t.id === toolUseId)) continue;

      const updatedTools: ToolCall[] = toolCalls.map(t => {
        if (t.id !== toolUseId) return t;
        // The live-output keys are dropped, not set to undefined, so a later spread cannot resurrect them.
        const { liveOutput: _clearedOutput, liveOutputTruncated: _clearedTruncated, cancelRequested: _clearedCancel, ...withoutLiveOutput } = t;
        const mergedMetadata = metadata === undefined ? t.metadata : { ...t.metadata, ...metadata };
        return {
          ...withoutLiveOutput,
          result,
          ...(isError !== undefined && { isError }),
          ...(mergedMetadata !== undefined && { metadata: mergedMetadata }),
          status: resolveCancelledStatus(isError ? 'failed' : 'completed', mergedMetadata),
        };
      });
      updated[i] = { ...m, toolCalls: updatedTools };
      break;
    }
    agentMessages.value = { ...agentMessages.value, [agentId]: updated };
  }

  function handleAgentToolProgress(agentId: string, toolUseId: string, output: string, truncated?: boolean): void {
    const msgs = agentMessages.value[agentId];
    if (!msgs) return;
    const updated = [...msgs];
    for (let i = updated.length - 1; i >= 0; i--) {
      const m = updated[i];
      if (!m || m.role !== 'assistant' || !m.toolCalls) continue;
      const toolCalls = m.toolCalls;
      const target = toolCalls.find(t => t.id === toolUseId);
      if (!target) continue;
      // The result path drops the live keys so a later spread cannot resurrect them, and a progress
      // frame that outlived the result would put them straight back.
      if (TERMINAL_TOOL_STATUSES.has(target.status)) return;

      // An empty output string is a real frame: LiveOutputPane shows the waiting state for it.
      const updatedTools: ToolCall[] = toolCalls.map(t => {
        if (t.id !== toolUseId) return t;
        // An absent truncated flag drops the key rather than setting undefined, so a stale true cannot survive.
        const { liveOutputTruncated: _clearedTruncated, ...rest } = t;
        return { ...rest, liveOutput: output, ...(truncated !== undefined && { liveOutputTruncated: truncated }) };
      });
      updated[i] = { ...m, toolCalls: updatedTools };
      break;
    }
    agentMessages.value = { ...agentMessages.value, [agentId]: updated };
  }

  /** Searches every agent because the cancel click carries only the tool id, not the agent it belongs to. */
  function replaceAgentTool(toolUseId: string, replace: (tool: ToolCall) => ToolCall): boolean {
    for (const [agentId, msgs] of Object.entries(agentMessages.value)) {
      const updated = [...msgs];
      for (let i = updated.length - 1; i >= 0; i--) {
        const m = updated[i];
        if (!m || m.role !== 'assistant' || !m.toolCalls) continue;
        const toolCalls = m.toolCalls;
        if (!toolCalls.some(t => t.id === toolUseId)) continue;

        const updatedTools: ToolCall[] = toolCalls.map(t => (t.id === toolUseId ? replace(t) : t));
        updated[i] = { ...m, toolCalls: updatedTools };
        agentMessages.value = { ...agentMessages.value, [agentId]: updated };
        return true;
      }
    }
    return false;
  }

  function markAgentToolCancelRequested(toolUseId: string): boolean {
    return replaceAgentTool(toolUseId, t => ({ ...t, cancelRequested: true }));
  }

  function clearAgentToolCancelRequested(toolUseId: string): boolean {
    return replaceAgentTool(toolUseId, t => {
      // The key is dropped rather than set to undefined, which exactOptionalPropertyTypes rejects.
      const { cancelRequested: _clearedCancel, ...withoutCancel } = t;
      return withoutCancel;
    });
  }

  function handleAgentDataLoaded(agentId: string, history: TeamAgentHistoryMessage[]): void {
    const results = new Map<string, PersistedToolResult>();
    for (const message of history) {
      if (message.role !== 'toolResult') continue;
      for (const block of message.content) {
        if (block.type === 'tool_result') results.set(block.tool_use_id, block);
      }
    }

    const messages: AgentChatMessage[] = [];
    // A result renders on the card of the call it names, and any other role is not one this card shows.
    for (const { id, role, content: turn } of history) {
      if (role === 'assistant') {
        const textContent = turn.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('');
        const thinkingContent = turn.filter(b => b.type === 'thinking').map(b => (b as { thinking: string }).thinking).join('\n\n');
        const toolCalls: ToolCall[] = turn
          .filter(b => b.type === 'tool_use')
          .map(b => {
            const t = b as { id: string; name: string; input: unknown };
            const result = results.get(t.id);
            return {
              id: t.id,
              name: t.name,
              input: typeof t.input === 'object' && t.input !== null ? t.input as Record<string, unknown> : {},
              status: restoredToolStatus(result),
              ...(result ? { result: result.content, isError: result.is_error === true } : {}),
              ...(result?.metadata ? { metadata: result.metadata } : {}),
            };
          });
        messages.push({
          id,
          role: 'assistant',
          content: textContent,
          ...(thinkingContent ? { thinking: thinkingContent } : {}),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          contentBlocks: turn,
          timestamp: Date.now(),
        });
      } else if (role === 'user') {
        // No contentBlocks, the same shape `handleAgentUserMessage` builds, so the merge key matches the live copy.
        const userText = turn.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('');
        const images = turn.filter(isImageBlock);
        if (userText || images.length) {
          messages.push({ id, role: 'user', content: userText, ...(images.length ? { images } : {}), timestamp: Date.now() });
        }
      }
    }
    agentMessages.value = { ...agentMessages.value, [agentId]: mergeAgentHistory(messages, agentMessages.value[agentId] ?? []) };
    agentHistoryLoaded.value = new Set(agentHistoryLoaded.value).add(agentId);
  }

  function isAgentHistoryLoaded(agentId: string): boolean {
    return agentHistoryLoaded.value.has(agentId);
  }

  function getTeamForToolUseId(toolUseId: string): TeamState | undefined {
    return Object.values(teams.value).find(t => t.toolUseId === toolUseId);
  }

  // Keyed by the team_id the call names; an errored or failed call resumed nothing.
  function getTeamForResumeCall(toolCall: Pick<ToolCall, 'input' | 'status' | 'isError'>): TeamState | undefined {
    if (toolCall.isError || toolCall.status === 'failed') return undefined;
    const teamId = toolCall.input['team_id'];
    return typeof teamId === 'string' ? ownEntry(teams.value, teamId) : undefined;
  }

  function failPendingTeamByToolUseId(toolUseId: string): void {
    const entry = Object.entries(teams.value).find(
      ([k, t]) => k.startsWith('pending-') && t.toolUseId === toolUseId
    );
    if (!entry) return;
    const [key, team] = entry;
    const endTime = Date.now();
    teams.value = {
      ...teams.value,
      [key]: { ...team, status: 'failed', phase: 'complete' as const, endTime, runs: updateLiveRun(team.runs, r => ({ ...r, status: 'failed', endTime })) },
    };
  }

  function handlePermissionRequest(request: { requestId: string; teamId: string; agentId: string; agentName: string; toolName: string; toolInput: Record<string, unknown> }): void {
    permissionQueue.value = [...permissionQueue.value, request];
  }

  function shiftPermissionQueue(): void {
    permissionQueue.value = permissionQueue.value.slice(1);
  }

  function $reset(): void {
    teams.value = {};
    isOverlayOpen.value = false;
    selectedTeamId.value = null;
    activeTab.value = 'agents';
    agentMessages.value = {};
    agentStreaming.value = {};
    agentHistoryLoaded.value = new Set();
    selectedAgentId.value = null;
    isAgentOverlayOpen.value = false;
    permissionQueue.value = [];
  }

  return {
    teams,
    isOverlayOpen,
    selectedTeamId,
    activeTab,
    selectedTeam,
    activeTeams,
    activeTeamCount,
    selectedTeamAgents,
    selectedTeamMessages,
    selectedTeamScratchpad,
    hasResult,
    agentMessages,
    agentStreaming,
    selectedAgentId,
    isAgentOverlayOpen,
    selectedAgent,
    currentAgentMessages,
    currentAgentStreaming,
    openOverlay,
    closeOverlay,
    setActiveTab,
    registerTeamFromTool,
    handleTeamStarted,
    failPendingTeamByToolUseId,
    handleTeamPhaseUpdate,
    handleAgentStatusUpdate,
    handleAgentUsageUpdate,
    handleAgentToolCall,
    handleTeamMessage,
    handleScratchpadUpdate,
    handleTeamCompleted,
    restoreTeamFromHistory,
    openAgentOverlay,
    closeAgentOverlay,
    handleAgentStreamDelta,
    handleAgentAssistant,
    handleAgentUserMessage,
    handleAgentToolResult,
    handleAgentToolProgress,
    markAgentToolCancelRequested,
    clearAgentToolCancelRequested,
    handleAgentDataLoaded,
    isAgentHistoryLoaded,
    getTeamForToolUseId,
    getTeamForResumeCall,
    permissionQueue,
    activePermission,
    handlePermissionRequest,
    shiftPermissionQueue,
    $reset,
  };
});
