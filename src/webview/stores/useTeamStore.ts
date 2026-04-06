import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import type { TeamState, TeamPhase, TeamAgent, TeamAgentStatus, TeamMessage, ScratchpadEntry, TeamAgentContentBlock } from '@shared/types/team';

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
  toolCalls?: AgentToolCall[];
  contentBlocks?: TeamAgentContentBlock[];
  timestamp: number;
}

export interface AgentToolCall {
  id: string;
  name: string;
  input: unknown;
  result?: string;
  isError?: boolean;
  status: 'running' | 'completed' | 'error';
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
      k => k.startsWith('pending-') && teams.value[k].toolUseId === team.toolUseId
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

  function handleAgentStatusUpdate(teamId: string, agentId: string, status: TeamAgentStatus, progressSummary?: string, logFilePath?: string | null): void {
    const team = teams.value[teamId];
    if (!team) return;
    const agents = team.agents.map(a =>
      a.agentId === agentId
        ? { ...a, status, ...(progressSummary !== undefined ? { progressSummary } : {}), ...(logFilePath !== undefined ? { logFilePath } : {}), ...(status === 'running' && !a.startTime ? { startTime: Date.now() } : {}), ...((status === 'completed' || status === 'failed' || status === 'cancelled') ? { endTime: Date.now() } : {}) }
        : a
    );
    teams.value = { ...teams.value, [teamId]: { ...team, agents } };
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
    const toolCalls: AgentToolCall[] = content
      .filter(b => b.type === 'tool_use')
      .map(b => {
        const t = b as { id: string; name: string; input: unknown };
        return { id: t.id, name: t.name, input: t.input, status: 'running' as const };
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

  function handleAgentToolResult(agentId: string, toolUseId: string, result: string, isError?: boolean): void {
    const msgs = agentMessages.value[agentId];
    if (!msgs) return;
    const updated = [...msgs];
    for (let i = updated.length - 1; i >= 0; i--) {
      const m = updated[i]!;
      if (m.role === 'assistant' && m.toolCalls) {
        const tool = m.toolCalls.find(t => t.id === toolUseId);
        if (tool) {
          const updatedTools = m.toolCalls.map(t =>
            t.id === toolUseId
              ? { ...t, result, isError, status: (isError ? 'error' : 'completed') as AgentToolCall['status'] }
              : t
          );
          updated[i] = { ...m, toolCalls: updatedTools };
          break;
        }
      }
    }
    agentMessages.value = { ...agentMessages.value, [agentId]: updated };
  }

  function handleAgentDataLoaded(agentId: string, turns: TeamAgentContentBlock[][]): void {
    const messages: AgentChatMessage[] = [];
    for (const turn of turns) {
      const hasToolResult = turn.some(b => b.type === 'tool_result');
      if (hasToolResult) continue;

      const hasAssistantContent = turn.some(b => b.type === 'text' || b.type === 'thinking' || b.type === 'tool_use');

      if (hasAssistantContent) {
        const textContent = turn.filter(b => b.type === 'text').map(b => (b as { text: string }).text).join('');
        const thinkingContent = turn.filter(b => b.type === 'thinking').map(b => (b as { thinking: string }).thinking).join('\n\n');
        const toolCalls: AgentToolCall[] = turn
          .filter(b => b.type === 'tool_use')
          .map(b => {
            const t = b as { id: string; name: string; input: unknown };
            return { id: t.id, name: t.name, input: t.input, status: 'completed' as const };
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
    handleAgentDataLoaded,
    getTeamForToolUseId,
    permissionQueue,
    activePermission,
    handlePermissionRequest,
    shiftPermissionQueue,
    $reset,
  };
});
