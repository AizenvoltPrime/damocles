<script setup lang="ts">
import type { ChatMessage, ToolCall } from '@shared/types/session';
import type { SubagentState } from '@shared/types/subagents';
import { TOOL_AGENT, TOOL_ASK_USER_QUESTION, TOOL_EXIT_PLAN_MODE, TOOL_ENTER_PLAN_MODE, TOOL_SKILL, TOOL_MONITOR } from '@shared/tool-names';
import ToolCallCard from './ToolCallCard.vue';
import QuestionToolCard from './QuestionToolCard.vue';
import ExitPlanModeToolCard from './ExitPlanModeToolCard.vue';
import EnterPlanModeToolCard from './EnterPlanModeToolCard.vue';
import SkillToolCard from './SkillToolCard.vue';
import SubagentCard from './SubagentCard.vue';
import TeamCard from './TeamCard.vue';
import MonitorCard from './MonitorCard.vue';
import { useTeamStore } from '@/stores/useTeamStore';
import type { ExpandedDiff } from '@/stores/useDiffStore';
import { computed } from 'vue';

const teamStore = useTeamStore();

const props = defineProps<{
  toolCall: ToolCall;
  toolUseId: string;
  toolName: string;
  message: ChatMessage;
  subagents?: Record<string, SubagentState>;
}>();

const emit = defineEmits<{
  (e: 'expandTool', toolId: string): void;
  (e: 'expandDiff', diff: ExpandedDiff): void;
  (e: 'expandSubagent', subagentId: string): void;
}>();

const teamByToolUseId = computed(() => {
  const map: Record<string, (typeof teamStore.teams)[string]> = {};
  for (const team of Object.values(teamStore.teams)) {
    if (team.toolUseId) map[team.toolUseId] = team;
  }
  return map;
});

const team = computed(() => teamByToolUseId.value[props.toolUseId] ?? null);

function isAgentWithSubagent(): boolean {
  return props.toolName === TOOL_AGENT && !!(props.subagents?.[props.toolUseId]);
}
</script>

<template>
  <TeamCard
    v-if="team"
    :team="team"
    @expand="teamStore.openOverlay(team!.teamId)"
  />
  <SubagentCard
    v-else-if="isAgentWithSubagent() && subagents?.[toolUseId]"
    :subagent="subagents[toolUseId]"
    @expand="emit('expandSubagent', toolUseId)"
  />
  <QuestionToolCard v-else-if="toolName === TOOL_ASK_USER_QUESTION" :tool-call="toolCall" />
  <ExitPlanModeToolCard v-else-if="toolName === TOOL_EXIT_PLAN_MODE" :tool-call="toolCall" />
  <EnterPlanModeToolCard v-else-if="toolName === TOOL_ENTER_PLAN_MODE" :tool-call="toolCall" />
  <SkillToolCard v-else-if="toolName === TOOL_SKILL" :tool-call="toolCall" />
  <MonitorCard v-else-if="toolName === TOOL_MONITOR" :tool-call="toolCall" @expand="emit('expandTool', $event)" />
  <ToolCallCard
    v-else
    :tool-call="toolCall"
    @expand="emit('expandTool', $event)"
    @expand-diff="emit('expandDiff', $event)"
  />
</template>
