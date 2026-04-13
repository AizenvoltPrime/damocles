<script setup lang="ts">
import { ref, computed, watch, onMounted, inject, type Ref } from "vue";
import { useI18n } from "vue-i18n";
import type { ChatMessage, CompactMarker as CompactMarkerType, ToolCall } from "@shared/types/session";
import type { SubagentState } from "@shared/types/subagents";
import type { ContentBlock, ImageBlock } from "@shared/types/content";
import { TOOL_AGENT, TOOL_ASK_USER_QUESTION, TOOL_EXIT_PLAN_MODE, TOOL_ENTER_PLAN_MODE, TOOL_SKILL, TOOL_MONITOR, TASK_MANAGEMENT_TOOLS, TEAM_MANAGEMENT_TOOLS, TEAM_CREATE_TOOL } from "@shared/tool-names";

import type { ExpandedDiff } from "@/stores/useDiffStore";
import { useSessionStore } from "@/stores/useSessionStore";
import ToolCallCard from "./ToolCallCard.vue";
import QuestionToolCard from "./QuestionToolCard.vue";
import ExitPlanModeToolCard from "./ExitPlanModeToolCard.vue";
import EnterPlanModeToolCard from "./EnterPlanModeToolCard.vue";
import SkillToolCard from "./SkillToolCard.vue";
import SubagentCard from "./SubagentCard.vue";
import TeamCard from "./TeamCard.vue";
import MonitorCard from "./MonitorCard.vue";
import { useTeamStore } from "@/stores/useTeamStore";
import CompactMarker from "./CompactMarker.vue";
import ThinkingIndicator from "./ThinkingIndicator.vue";
import MarkdownRenderer from "./MarkdownRenderer.vue";
import MessageContent from "./MessageContent.vue";
import ImageLightbox from "./ImageLightbox.vue";
import { imageBlockToDataUrl } from "@/utils/imageUtils";
import { Button } from "@/components/ui/button";
import { IconDatabase, IconChevronRight, IconArrowUp, IconChevronUp, IconChevronDown } from "@/components/icons";
import { useStickyMessages } from "@/composables/useStickyMessages";

const { t } = useI18n();
const sessionStore = useSessionStore();
const teamStore = useTeamStore();

const scrollContainer = inject<Ref<HTMLElement | null>>("messageScrollContainer", ref(null));
const { stuckMessageIds, registerSentinel, scrollToOriginal } = useStickyMessages(scrollContainer);
const expandedStickyIds = ref(new Set<string>());

watch(() => props.messages.length, (len) => {
  if (len === 0) expandedStickyIds.value = new Set();
});

function isStuck(id: string): boolean {
  return stuckMessageIds.value.has(id);
}

function isStickyExpanded(id: string): boolean {
  return expandedStickyIds.value.has(id);
}

function toggleStickyExpand(id: string): void {
  const next = new Set(expandedStickyIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedStickyIds.value = next;
}

interface MessageGroup {
  key: string;
  userMessage: ChatMessage | null;
  userMessageIndex: number;
  responses: Array<{ message: ChatMessage; index: number }>;
}

const messageGroups = computed<MessageGroup[]>(() => {
  const groups: MessageGroup[] = [];
  let current: MessageGroup | null = null;

  for (let i = 0; i < props.messages.length; i++) {
    const msg = props.messages[i];
    if (msg.role === "user") {
      current = { key: msg.id, userMessage: msg, userMessageIndex: i, responses: [] };
      groups.push(current);
    } else {
      if (!current) {
        current = { key: `preamble-${msg.id}`, userMessage: null, userMessageIndex: -1, responses: [] };
        groups.push(current);
      }
      current.responses.push({ message: msg, index: i });
    }
  }
  return groups;
});

const teamByToolUseId = computed(() => {
  const map: Record<string, typeof teamStore.teams[string]> = {};
  for (const team of Object.values(teamStore.teams)) {
    if (team.toolUseId) map[team.toolUseId] = team;
  }
  return map;
});

function getTeamForToolUseId(toolUseId: string) {
  return teamByToolUseId.value[toolUseId] ?? null;
}

const logoUri = ref("");
const lightboxImageUrl = ref<string | null>(null);

onMounted(() => {
  logoUri.value = document.getElementById("app")?.dataset.logoUri ?? "";
});

const props = defineProps<{
  messages: ChatMessage[];
  streamingMessageId?: string | null;
  compactMarkers?: CompactMarkerType[];
  checkpointMessages?: Set<string>;
  subagents?: Record<string, SubagentState>;
}>();

const emit = defineEmits<{
  (e: "rewind"): void;
  (e: "expandSubagent", subagentId: string): void;
  (e: "expandTool", toolId: string): void;
  (e: "expandDiff", diff: ExpandedDiff): void;
  (e: "viewContext", promptIndex: number): void;
}>();

function getPromptIndexForMessage(messageIndex: number): number {
  let idx = sessionStore.promptIndexOffset;
  for (let i = 0; i < messageIndex; i++) {
    const m = props.messages[i];
    if (m.role === "user" && !m.isInjected && !m.isCombinedQueue && !m.isQueued) idx++;
  }
  return idx;
}

function isStreamingMessage(message: ChatMessage): boolean {
  return !!props.streamingMessageId && message.id === props.streamingMessageId;
}

function isAgentToolWithSubagent(toolId: string, toolName: string): boolean {
  return toolName === TOOL_AGENT && (props.subagents ? toolId in props.subagents : false);
}

function getMarkerPositionTimestamp(marker: CompactMarkerType): number {
  return marker.messageCutoffTimestamp ?? marker.timestamp;
}

function getMarkersBeforeMessage(messageTimestamp: number, messageIndex: number): CompactMarkerType[] {
  if (!props.compactMarkers) return [];
  const prevTimestamp = messageIndex > 0 ? props.messages[messageIndex - 1]?.timestamp : 0;
  return props.compactMarkers.filter((marker) => {
    const pos = getMarkerPositionTimestamp(marker);
    return pos > prevTimestamp && pos <= messageTimestamp;
  });
}

function getTrailingMarkers(): CompactMarkerType[] {
  if (!props.compactMarkers || props.compactMarkers.length === 0) return [];
  const lastMsgTimestamp = props.messages.length > 0 ? props.messages[props.messages.length - 1].timestamp : 0;
  return props.compactMarkers.filter((marker) => getMarkerPositionTimestamp(marker) > lastMsgTimestamp);
}

function hasMarkersToShow(): boolean {
  return (props.compactMarkers?.length ?? 0) > 0;
}

function canRewindTo(message: ChatMessage): boolean {
  return message.role === "user" && !!message.sdkMessageId && (props.checkpointMessages?.has(message.sdkMessageId) ?? false);
}

function isTaskTool(toolName: string): boolean {
  return TASK_MANAGEMENT_TOOLS.has(toolName);
}

function isAskUserQuestionTool(toolName: string): boolean {
  return toolName === TOOL_ASK_USER_QUESTION;
}

function isExitPlanModeTool(toolName: string): boolean {
  return toolName === TOOL_EXIT_PLAN_MODE;
}

function isEnterPlanModeTool(toolName: string): boolean {
  return toolName === TOOL_ENTER_PLAN_MODE;
}

function isSkillTool(toolName: string): boolean {
  return toolName === TOOL_SKILL;
}

function isMonitorTool(toolName: string): boolean {
  return toolName === TOOL_MONITOR;
}

function isTeamManagementTool(toolName: string): boolean {
  return TEAM_MANAGEMENT_TOOLS.has(toolName);
}

function isTeamCreateTool(toolName: string): boolean {
  return toolName === TEAM_CREATE_TOOL;
}

function getToolCallById(message: ChatMessage, toolId: string): ToolCall | undefined {
  return message.toolCalls?.find((t) => t.id === toolId);
}

function shouldUseInterleavedRendering(message: ChatMessage): boolean {
  return !!(message.contentBlocks && message.contentBlocks.length > 0);
}

function isTextBlock(block: ContentBlock): block is { type: "text"; text: string } {
  return block.type === "text";
}

function isToolUseBlock(block: ContentBlock): block is { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } {
  return block.type === "tool_use";
}

function isImageBlock(block: ContentBlock): block is ImageBlock {
  return block.type === "image";
}

function getImageBlocks(message: ChatMessage): ImageBlock[] {
  if (!message.contentBlocks) return [];
  return message.contentBlocks.filter(isImageBlock);
}

function openImageLightbox(block: ImageBlock): void {
  lightboxImageUrl.value = imageBlockToDataUrl(block);
}

function closeLightbox(): void {
  lightboxImageUrl.value = null;
}

function getBlockKey(block: ContentBlock, index: number): string {
  if (isToolUseBlock(block)) return block.id;
  return `block-${index}`;
}

function getTrailingStreamingText(message: ChatMessage): string {
  if (!message.contentBlocks || message.contentBlocks.length === 0) return "";
  let committedLength = 0;
  for (const block of message.contentBlocks) {
    if (isTextBlock(block)) committedLength += block.text.length;
  }
  if (message.content.length <= committedLength) return "";
  return message.content.slice(committedLength);
}
</script>

<template>
  <div class="px-4 pb-4 space-y-4 bg-background" :class="messages.length === 0 && !hasMarkersToShow() ? 'flex flex-col justify-center' : ''">
    <!-- Welcome message - only show when no messages AND no compact markers -->
    <div v-if="messages.length === 0 && !hasMarkersToShow()" class="text-center w-full px-4">
      <img :src="logoUri" alt="Damocles" class="w-16 h-16 mx-auto mb-4" />
      <p class="text-xl mb-2 text-foreground font-medium">{{ t("welcome.title") }}</p>
      <p class="text-sm text-muted-foreground">
        {{ t("welcome.message") }}
      </p>
    </div>

    <template v-for="group in messageGroups" :key="group.key">
      <div class="relative space-y-4">
        <!-- Sentinel for sticky detection -->
        <div
          v-if="group.userMessage"
          :ref="(el) => registerSentinel(group.userMessage!.id, el as HTMLElement | null)"
          class="absolute top-0 left-0 h-px w-px pointer-events-none"
          style="scroll-margin-top: 4px"
        />

        <!-- Markers before user message -->
        <template v-if="group.userMessage">
          <CompactMarker
            v-for="marker in getMarkersBeforeMessage(group.userMessage.timestamp, group.userMessageIndex)"
            :key="marker.id"
            :marker="marker"
          />
        </template>

        <!-- User message (sticky when scrolled past) -->
        <div
          v-if="group.userMessage"
          class="sticky top-0 z-10 group relative -mx-4"
          :class="!isStuck(group.userMessage.id) && 'animate-message-enter'"
        >
          <!-- Compact header when stuck (in flow, replaces full content) -->
          <div
            v-if="isStuck(group.userMessage.id)"
            class="px-4 py-2.5 bg-card shadow-[0_4px_12px_-4px_rgba(0,0,0,0.4)] border-b border-border/60"
          >
            <div class="relative">
              <div
                :class="isStickyExpanded(group.userMessage.id)
                  ? 'max-h-[50vh] overflow-y-auto'
                  : 'max-h-[5rem] overflow-hidden'"
              >
                <MarkdownRenderer v-if="group.userMessage.content" :content="group.userMessage.content" class="text-foreground" />
              </div>
              <div
                v-if="!isStickyExpanded(group.userMessage.id)"
                class="absolute bottom-0 inset-x-0 h-4 bg-gradient-to-t from-card to-transparent pointer-events-none"
              />
            </div>
            <span
              v-if="getImageBlocks(group.userMessage).length > 0"
              class="text-xs text-muted-foreground"
            >
              {{ t('stickyMessage.imageCount', { n: getImageBlocks(group.userMessage).length }, getImageBlocks(group.userMessage).length) }}
            </span>
            <div class="flex items-center gap-1 mt-1">
              <Button
                variant="ghost"
                size="icon-sm"
                class="h-5 w-5 text-muted-foreground hover:text-foreground"
                @click.stop="toggleStickyExpand(group.userMessage.id)"
              >
                <IconChevronUp v-if="isStickyExpanded(group.userMessage.id)" :size="12" />
                <IconChevronDown v-else :size="12" />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                class="h-5 w-5 text-muted-foreground hover:text-foreground"
                @click.stop="scrollToOriginal(group.userMessage.id)"
              >
                <IconArrowUp :size="12" />
              </Button>
            </div>
          </div>

          <!-- Rewind button: hidden when stuck -->
          <Button
            v-if="!isStuck(group.userMessage.id) && canRewindTo(group.userMessage) && !group.userMessage.isInjected && !group.userMessage.isCombinedQueue"
            variant="ghost"
            size="icon-sm"
            class="absolute -left-6 top-2 opacity-0 group-hover:opacity-100 text-base text-muted-foreground hover:text-foreground hover:bg-transparent"
            :title="t('welcome.undoChanges')"
            @click="emit('rewind')"
          >
            ⏪
          </Button>

          <!-- Full content (hidden when stuck via display:none, zero flow contribution) -->
          <div
            v-show="!isStuck(group.userMessage.id)"
            class="px-4 py-1.5 transition-shadow duration-200"
            :class="[
              group.userMessage.isInjected || group.userMessage.isCombinedQueue || group.userMessage.isQueued
                ? 'bg-amber-500/10 border-y border-amber-500/25'
                : 'bg-muted/75 border-y border-border/60'
            ]"
          >
            <div
              v-if="group.userMessage.isInjected || group.userMessage.isCombinedQueue || group.userMessage.isQueued"
              class="flex items-center gap-2 mb-2 text-xs text-amber-400/80"
            >
              <span class="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/30">{{ t("welcome.sentMidStream") }}</span>
              <span v-if="group.userMessage.isQueued" class="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/30">{{ t("welcome.queued") }}</span>
            </div>

            <MarkdownRenderer v-if="group.userMessage.content" :content="group.userMessage.content" class="text-foreground" />

            <div v-if="getImageBlocks(group.userMessage).length > 0" class="flex flex-wrap gap-2 mt-2">
              <img
                v-for="(img, imgIdx) in getImageBlocks(group.userMessage)"
                :key="`img-${imgIdx}`"
                :src="imageBlockToDataUrl(img)"
                alt="Attached image"
                class="max-w-32 max-h-32 rounded-md border border-border object-contain cursor-pointer hover:opacity-80 transition-opacity"
                @click="openImageLightbox(img)"
              />
            </div>

            <button
              v-if="!group.userMessage.isInjected && !group.userMessage.isCombinedQueue && !group.userMessage.isQueued"
              type="button"
              class="group/ctx flex items-center gap-1.5 mt-2.5 mb-2 px-2 py-0.5 rounded-full text-xs font-medium text-primary/50 bg-primary/5 border border-primary/10 hover:text-primary hover:bg-primary/10 hover:border-primary/20 transition-all duration-200 cursor-pointer"
              :title="t('contextInjection.viewContext')"
              @click.stop="emit('viewContext', getPromptIndexForMessage(group.userMessageIndex))"
            >
              <span class="relative flex h-1.5 w-1.5 shrink-0">
                <span class="absolute inline-flex h-full w-full rounded-full bg-primary opacity-0 group-hover/ctx:opacity-40 group-hover/ctx:animate-ping" />
                <span class="relative inline-flex rounded-full h-1.5 w-1.5 bg-primary/70" />
              </span>
              <IconDatabase :size="10" class="shrink-0 opacity-60 group-hover/ctx:opacity-100 transition-opacity" />
              <span>{{ t("contextInjection.viewContext") }}</span>
              <IconChevronRight
                :size="8"
                class="shrink-0 opacity-0 -ml-0.5 group-hover/ctx:opacity-60 group-hover/ctx:ml-0 transition-all duration-200"
              />
            </button>
          </div>
        </div>

        <!-- Response messages -->
        <template v-for="resp in group.responses" :key="resp.message.id">
          <CompactMarker
            v-for="marker in getMarkersBeforeMessage(resp.message.timestamp, resp.index)"
            :key="marker.id"
            :marker="marker"
          />

          <!-- Error message -->
          <div v-if="resp.message.role === 'error'" class="pl-4 text-error animate-message-enter">
            {{ t("common.error") }}: {{ resp.message.content }}
          </div>

          <!-- Assistant message -->
          <div v-else class="relative space-y-3" :class="isStreamingMessage(resp.message) ? 'animate-fade-in' : 'animate-message-enter'">
            <div v-if="resp.message.isBackgroundResult" class="pl-4 flex items-center gap-2 mb-1">
              <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-500/15 text-blue-400 ring-1 ring-blue-500/25">
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v4"/><path d="m16.2 7.8 2.9-2.9"/><path d="M18 12h4"/><path d="m16.2 16.2 2.9 2.9"/><path d="M12 18v4"/><path d="m4.9 19.1 2.9-2.9"/><path d="M2 12h4"/><path d="m4.9 4.9 2.9 2.9"/></svg>
                {{ resp.message.backgroundTaskLabel || t('backgroundTask.taskResult') }}
              </span>
            </div>

            <ThinkingIndicator
              v-if="resp.message.thinking || resp.message.thinkingContent || resp.message.isPartial || resp.message.thinkingDuration"
              :thinking="resp.message.thinking || resp.message.thinkingContent"
              :is-streaming="resp.message.isThinkingPhase"
              :duration="resp.message.thinkingDuration"
            />

            <!-- Interleaved rendering -->
            <template v-if="shouldUseInterleavedRendering(resp.message)">
              <template v-for="(block, blockIndex) in resp.message.contentBlocks" :key="getBlockKey(block, blockIndex)">
                <div v-if="isTextBlock(block)" class="pl-4">
                  <MessageContent :content="block.text" :is-streaming="false" :is-thinking-phase="false" />
                </div>

                <template v-else-if="isToolUseBlock(block)">
                  <div class="pl-4 space-y-2">
                    <template v-if="getToolCallById(resp.message, block.id)">
                      <TeamCard
                        v-if="getTeamForToolUseId(block.id)"
                        :team="getTeamForToolUseId(block.id)!"
                        @expand="teamStore.openOverlay(getTeamForToolUseId(block.id)!.teamId)"
                      />
                      <SubagentCard
                        v-else-if="isAgentToolWithSubagent(block.id, block.name) && subagents?.[block.id]"
                        :subagent="subagents[block.id]"
                        @expand="emit('expandSubagent', block.id)"
                      />
                      <QuestionToolCard v-else-if="isAskUserQuestionTool(block.name)" :tool-call="getToolCallById(resp.message, block.id)!" />
                      <ExitPlanModeToolCard v-else-if="isExitPlanModeTool(block.name)" :tool-call="getToolCallById(resp.message, block.id)!" />
                      <EnterPlanModeToolCard v-else-if="isEnterPlanModeTool(block.name)" :tool-call="getToolCallById(resp.message, block.id)!" />
                      <SkillToolCard v-else-if="isSkillTool(block.name)" :tool-call="getToolCallById(resp.message, block.id)!" />
                      <MonitorCard v-else-if="isMonitorTool(block.name)" :tool-call="getToolCallById(resp.message, block.id)!" @expand="emit('expandTool', $event)" />
                      <ToolCallCard
                        v-else-if="!isTaskTool(block.name) && !isTeamManagementTool(block.name) && !isTeamCreateTool(block.name)"
                        :tool-call="getToolCallById(resp.message, block.id)!"
                        @expand="emit('expandTool', $event)"
                        @expand-diff="emit('expandDiff', $event)"
                      />
                    </template>
                  </div>
                </template>
              </template>

              <div v-if="isStreamingMessage(resp.message) && getTrailingStreamingText(resp.message)" class="pl-4">
                <MessageContent :content="getTrailingStreamingText(resp.message)" :is-streaming="true" :is-thinking-phase="false" />
              </div>
            </template>

            <!-- Fallback for messages without contentBlocks -->
            <template v-else>
              <div v-if="resp.message.toolCalls?.length" class="pl-4 space-y-2">
                <template v-for="tool in resp.message.toolCalls" :key="tool.id">
                  <TeamCard
                    v-if="getTeamForToolUseId(tool.id)"
                    :team="getTeamForToolUseId(tool.id)!"
                    @expand="teamStore.openOverlay(getTeamForToolUseId(tool.id)!.teamId)"
                  />
                  <SubagentCard
                    v-else-if="isAgentToolWithSubagent(tool.id, tool.name) && subagents?.[tool.id]"
                    :subagent="subagents[tool.id]"
                    @expand="emit('expandSubagent', tool.id)"
                  />
                  <QuestionToolCard v-else-if="isAskUserQuestionTool(tool.name)" :tool-call="tool" />
                  <ExitPlanModeToolCard v-else-if="isExitPlanModeTool(tool.name)" :tool-call="tool" />
                  <EnterPlanModeToolCard v-else-if="isEnterPlanModeTool(tool.name)" :tool-call="tool" />
                  <SkillToolCard v-else-if="isSkillTool(tool.name)" :tool-call="tool" />
                  <MonitorCard v-else-if="isMonitorTool(tool.name)" :tool-call="tool" @expand="emit('expandTool', $event)" />
                  <ToolCallCard
                    v-else-if="!isTaskTool(tool.name) && !isTeamManagementTool(tool.name) && !isTeamCreateTool(tool.name)"
                    :tool-call="tool"
                    @expand="emit('expandTool', $event)"
                    @expand-diff="emit('expandDiff', $event)"
                  />
                </template>
              </div>

              <div v-if="resp.message.content" class="pl-4">
                <MessageContent
                  :content="resp.message.content"
                  :is-streaming="isStreamingMessage(resp.message)"
                  :is-thinking-phase="resp.message.isThinkingPhase ?? false"
                />
              </div>
            </template>
          </div>
        </template>
      </div>
    </template>

    <!-- Trailing compact markers (after all messages, or when no messages exist) -->
    <CompactMarker v-for="marker in getTrailingMarkers()" :key="marker.id" :marker="marker" />

    <!-- Image lightbox -->
    <ImageLightbox :open="lightboxImageUrl !== null" :image-url="lightboxImageUrl ?? ''" @close="closeLightbox" />
  </div>
</template>
