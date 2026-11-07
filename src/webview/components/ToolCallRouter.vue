<script setup lang="ts">
import type { ChatMessage, ToolCall } from '@shared/types/session';
import type { SubagentState } from '@shared/types/subagents';
import type { ImageBlock } from '@shared/types/content';
import { DESIGN_CHAT_TOOLS, TOOL_AGENT, TOOL_ASK_USER_QUESTION, TOOL_BROWSER_REQUEST_INPUT, TOOL_DESIGN_PARITY, TOOL_EXIT_PLAN_MODE, TOOL_ENTER_PLAN_MODE, TOOL_FINISH_DESIGN, TOOL_PREVIEW_JOURNEY, TOOL_SKILL, TOOL_START_DESIGN, TOOL_STEER_SUBAGENT, TEAM_CREATE_TOOL, TEAM_RESUME_TOOL } from '@shared/tool-names';
import ToolCallCard from './ToolCallCard.vue';
import QuestionToolCard from './QuestionToolCard.vue';
import FormToolCard from './FormToolCard.vue';
import ExitPlanModeToolCard from './ExitPlanModeToolCard.vue';
import EnterPlanModeToolCard from './EnterPlanModeToolCard.vue';
import SkillToolCard from './SkillToolCard.vue';
import SubagentCard from './SubagentCard.vue';
import TeamCard from './TeamCard.vue';
import SteerSubagentToolCard from './SteerSubagentToolCard.vue';
import StartDesignToolCard from './design/StartDesignToolCard.vue';
import FinishDesignToolCard from './design/FinishDesignToolCard.vue';
import DesignToolCard from './design/DesignToolCard.vue';
import PreviewJourneyToolCard from './design/PreviewJourneyToolCard.vue';
import DesignParityToolCard from './design/DesignParityToolCard.vue';
import { useTeamStore } from '@/stores/useTeamStore';
import { computed } from 'vue';

const teamStore = useTeamStore();

const props = defineProps<{
  toolCall: ToolCall;
  toolUseId: string;
  toolName: string;
  message: ChatMessage;
  subagents?: Record<string, SubagentState> | undefined;
}>();

const emit = defineEmits<{
  (e: 'expandSubagent', subagentId: string): void;
  // The transcript's own lightbox shows a card's image, so it outlives the card's row.
  (e: 'openLightbox', image: string | ImageBlock): void;
}>();

const teamByToolUseId = computed(() => {
  const map: Record<string, (typeof teamStore.teams)[string]> = {};
  for (const team of Object.values(teamStore.teams)) {
    if (team.toolUseId) map[team.toolUseId] = team;
  }
  return map;
});

const isResume = computed(() => props.toolName === TEAM_RESUME_TOOL);
const team = computed(() =>
  isResume.value ? teamStore.getTeamForResumeCall(props.toolCall) ?? null : teamByToolUseId.value[props.toolUseId] ?? null,
);
// Each create_team or resume_team call is one run of the team and its card shows only that run.
const run = computed(() => team.value?.runs.find(r => r.toolUseId === props.toolUseId) ?? null);

const agentSubagent = computed(() =>
  props.toolName === TOOL_AGENT ? props.subagents?.[props.toolUseId] ?? null : null
);
</script>

<template>
  <TeamCard
    v-if="team && run"
    :team="team"
    :run="run"
    @expand="teamStore.openOverlay(team!.teamId)"
  />
  <SubagentCard
    v-else-if="agentSubagent"
    :subagent="agentSubagent"
    @expand="emit('expandSubagent', toolUseId)"
  />
  <QuestionToolCard
    v-else-if="toolName === TOOL_ASK_USER_QUESTION"
    :tool-call="toolCall"
  />
  <FormToolCard
    v-else-if="toolName === TOOL_BROWSER_REQUEST_INPUT"
    :tool-call="toolCall"
  />
  <ExitPlanModeToolCard
    v-else-if="toolName === TOOL_EXIT_PLAN_MODE"
    :tool-call="toolCall"
  />
  <EnterPlanModeToolCard
    v-else-if="toolName === TOOL_ENTER_PLAN_MODE"
    :tool-call="toolCall"
  />
  <SkillToolCard
    v-else-if="toolName === TOOL_SKILL"
    :tool-call="toolCall"
  />
  <SteerSubagentToolCard
    v-else-if="toolName === TOOL_STEER_SUBAGENT"
    :tool-call="toolCall"
  />
  <StartDesignToolCard
    v-else-if="toolName === TOOL_START_DESIGN"
    :tool-call="toolCall"
  />
  <FinishDesignToolCard
    v-else-if="toolName === TOOL_FINISH_DESIGN"
    :tool-call="toolCall"
  />
  <PreviewJourneyToolCard
    v-else-if="toolName === TOOL_PREVIEW_JOURNEY"
    :tool-call="toolCall"
  />
  <DesignParityToolCard
    v-else-if="toolName === TOOL_DESIGN_PARITY"
    :tool-call="toolCall"
    @open-lightbox="emit('openLightbox', $event)"
  />
  <DesignToolCard
    v-else-if="DESIGN_CHAT_TOOLS.has(toolName)"
    :tool-call="toolCall"
    @open-lightbox="emit('openLightbox', $event)"
  />
  <ToolCallCard
    v-else-if="toolName !== TEAM_CREATE_TOOL"
    :tool-call="toolCall"
    source="session"
  />
</template>
