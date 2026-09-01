import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import type { TeamState, TeamPhase, TeamAgent, TeamAgentStatus, TeamMessage, ScratchpadEntry, TeamAgentContentBlock } from '@shared/types/team';
import type { ToolCall } from '@shared/types/session';
import { resolveCancelledStatus, TERMINAL_TOOL_STATUSES } from './tool-cancelled-status';

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

export const useTeamStore = defineStore('team', () => {
  const teams = ref<Record<string, TeamState>>({});
  const isOverlayOpen = ref(false);
  const selectedTeamId = ref<string | null>(null);
  const activeTab = ref<'agents' | 'timeline' | 'scratchpad' | 'result'>('agents');

  const agentMessages = ref<Record<string, AgentChatMessage[]>>({});
  const agentStreaming = ref<Record<string, AgentStreamingState>>({});
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

    teams.value = {
      ...teams.value,
      [teamId]: {
        teamId,
        toolUseId,
        title: input.title ?? 'Team',
        status: historical?.status ?? 'running',
        phase: historical ? 'complete' : 'initializing',
        agents,
        messages: [],
        scratchpad: [],
        result: historical?.result ?? null,
        startTime: Date.now(),
        endTime: historical ? Date.now() : null,
        totalToolCount: 0,
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

  function handleAgentUsageUpdate(teamId: string, agentId: string, usage: { totalInputTokens: number; totalOutputTokens: number; cacheReadTokens: number; cacheCreationTokens: number; costUsd: number }): void {
    const team = teams.value[teamId];
    if (!team) return;
    const agents = team.agents.map(a =>
      a.agentId === agentId
        ? { ...a, totalInputTokens: usage.totalInputTokens, totalOutputTokens: usage.totalOutputTokens, cacheReadTokens: usage.cacheReadTokens, cacheCreationTokens: usage.cacheCreationTokens, costUsd: usage.costUsd }
        : a
    );
    teams.value = { ...teams.value, [teamId]: { ...team, agents } };
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
    teams.value = { ...teams.value, [teamId]: { ...team, agents, totalToolCount } };
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

  function handleTeamCompleted(teamId: string, status: TeamState['status'], result: string | null): void {
    const team = teams.value[teamId];
    if (!team) return;
    teams.value = { ...teams.value, [teamId]: { ...team, status, result, endTime: Date.now(), phase: 'complete' as const } };
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

  function handleAgentUserMessage(agentId: string, content: string, timestamp: number): void {
    const msg: AgentChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
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

  function handleAgentDataLoaded(agentId: string, turns: TeamAgentContentBlock[][]): void {
    const results = new Map<string, PersistedToolResult>();
    for (const turn of turns) {
      for (const block of turn) {
        if (block.type === 'tool_result') results.set(block.tool_use_id, block);
      }
    }

    const messages: AgentChatMessage[] = [];
    for (const turn of turns) {
      // A result belongs to the card of the call it names, so its own turn renders nothing of its own.
      const hasToolResult = turn.some(b => b.type === 'tool_result');
      if (hasToolResult) continue;

      const hasAssistantContent = turn.some(b => b.type === 'text' || b.type === 'thinking' || b.type === 'tool_use');

      if (hasAssistantContent) {
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
          id: crypto.randomUUID(),
          role: 'assistant',
          content: textContent,
          ...(thinkingContent ? { thinking: thinkingContent } : {}),
          ...(toolCalls.length > 0 ? { toolCalls } : {}),
          contentBlocks: turn,
          timestamp: Date.now(),
        });
      } else {
        const textBlocks = turn.filter(b => b.type === 'text');
        const userText = textBlocks.map(b => (b as { text: string }).text).join('');
        if (userText) {
          messages.push({
            id: crypto.randomUUID(),
            role: 'user',
            content: userText,
            timestamp: Date.now(),
          });
        }
      }
    }
    agentMessages.value = { ...agentMessages.value, [agentId]: messages };
  }

  function getTeamForToolUseId(toolUseId: string): TeamState | undefined {
    return Object.values(teams.value).find(t => t.toolUseId === toolUseId);
  }

  function failPendingTeamByToolUseId(toolUseId: string): void {
    const entry = Object.entries(teams.value).find(
      ([k, t]) => k.startsWith('pending-') && t.toolUseId === toolUseId
    );
    if (!entry) return;
    const [key, team] = entry;
    teams.value = {
      ...teams.value,
      [key]: { ...team, status: 'failed', phase: 'complete' as const, endTime: Date.now() },
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
    getTeamForToolUseId,
    permissionQueue,
    activePermission,
    handlePermissionRequest,
    shiftPermissionQueue,
    $reset,
  };
});
