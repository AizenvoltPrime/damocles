<script setup lang="ts">
import type { ChatMessage, ToolCall } from '@shared/types/session';
import type { SubagentState } from '@shared/types/subagents';
import { TOOL_AGENT, TOOL_ASK_USER_QUESTION, TOOL_BROWSER_REQUEST_INPUT, TOOL_EXIT_PLAN_MODE, TOOL_ENTER_PLAN_MODE, TOOL_SKILL, TOOL_MONITOR, TOOL_STEER_SUBAGENT, TEAM_CREATE_TOOL } from '@shared/tool-names';
import ToolCallCard from './ToolCallCard.vue';
import QuestionToolCard from './QuestionToolCard.vue';
import FormToolCard from './FormToolCard.vue';
import ExitPlanModeToolCard from './ExitPlanModeToolCard.vue';
import EnterPlanModeToolCard from './EnterPlanModeToolCard.vue';
import SkillToolCard from './SkillToolCard.vue';
import SubagentCard from './SubagentCard.vue';
import ExploreCard from './ExploreCard.vue';
import TeamCard from './TeamCard.vue';
import MonitorCard from './MonitorCard.vue';
import SteerSubagentToolCard from './SteerSubagentToolCard.vue';
import { useTeamStore } from '@/stores/useTeamStore';
import { useExploreStore } from '@/stores/useExploreStore';
import type { ExpandedDiff } from '@/stores/useDiffStore';
import { computed } from 'vue';

const teamStore = useTeamStore();
const exploreStore = useExploreStore();

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
const explore = computed(() => exploreStore.explores[props.toolUseId] ?? null);

function isAgentWithSubagent(): boolean {
  return props.toolName === TOOL_AGENT && !!(props.subagents?.[props.toolUseId]);
}
</script>

<template>
  <ExploreCard
    v-if="explore"
    :explore="explore"
    @expand="exploreStore.expandExplore(toolUseId)"
  />
  <TeamCard
    v-else-if="team"
    :team="team"
    @expand="teamStore.openOverlay(team!.teamId)"
  />
  <SubagentCard
    v-else-if="isAgentWithSubagent() && subagents?.[toolUseId]"
    :subagent="subagents[toolUseId]"
    @expand="emit('expandSubagent', toolUseId)"
  />
  <QuestionToolCard v-else-if="toolName === TOOL_ASK_USER_QUESTION" :tool-call="toolCall" />
  <FormToolCard v-else-if="toolName === TOOL_BROWSER_REQUEST_INPUT" :tool-call="toolCall" />
  <ExitPlanModeToolCard v-else-if="toolName === TOOL_EXIT_PLAN_MODE" :tool-call="toolCall" />
  <EnterPlanModeToolCard v-else-if="toolName === TOOL_ENTER_PLAN_MODE" :tool-call="toolCall" />
  <SkillToolCard v-else-if="toolName === TOOL_SKILL" :tool-call="toolCall" />
  <MonitorCard v-else-if="toolName === TOOL_MONITOR" :tool-call="toolCall" @expand="emit('expandTool', $event)" />
  <SteerSubagentToolCard v-else-if="toolName === TOOL_STEER_SUBAGENT" :tool-call="toolCall" />
  <ToolCallCard
    v-else-if="toolName !== TEAM_CREATE_TOOL"
    :tool-call="toolCall"
    @expand="emit('expandTool', $event)"
    @expand-diff="emit('expandDiff', $event)"
  />
</template>
