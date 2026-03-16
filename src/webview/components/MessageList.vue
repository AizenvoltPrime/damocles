<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useI18n } from "vue-i18n";
import type { ChatMessage, CompactMarker as CompactMarkerType, ToolCall } from "@shared/types/session";
import type { SubagentState } from "@shared/types/subagents";
import type { ContentBlock, ImageBlock } from "@shared/types/content";
import { TOOL_AGENT, TOOL_ASK_USER_QUESTION, TOOL_EXIT_PLAN_MODE, TOOL_ENTER_PLAN_MODE, TOOL_SKILL, TASK_MANAGEMENT_TOOLS } from "@shared/tool-names";

import type { ExpandedDiff } from "@/stores/useDiffStore";
import { useSessionStore } from "@/stores/useSessionStore";
import ToolCallCard from "./ToolCallCard.vue";
import QuestionToolCard from "./QuestionToolCard.vue";
import ExitPlanModeToolCard from "./ExitPlanModeToolCard.vue";
import EnterPlanModeToolCard from "./EnterPlanModeToolCard.vue";
import SkillToolCard from "./SkillToolCard.vue";
import SubagentCard from "./SubagentCard.vue";
import CompactMarker from "./CompactMarker.vue";
import ThinkingIndicator from "./ThinkingIndicator.vue";
import MarkdownRenderer from "./MarkdownRenderer.vue";
import MessageContent from "./MessageContent.vue";
import ImageLightbox from "./ImageLightbox.vue";
import { imageBlockToDataUrl } from "@/utils/imageUtils";
import { Button } from "@/components/ui/button";
import { IconDatabase, IconChevronRight } from "@/components/icons";

const { t } = useI18n();
const sessionStore = useSessionStore();

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
    if (m.role === "user" && !m.isInjected && !m.isQueued) idx++;
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
  <div class="p-4 space-y-4 bg-background" :class="messages.length === 0 && !hasMarkersToShow() ? 'flex flex-col justify-center' : ''">
    <!-- Welcome message - only show when no messages AND no compact markers -->
    <div v-if="messages.length === 0 && !hasMarkersToShow()" class="text-center w-full px-4">
      <img :src="logoUri" alt="Damocles" class="w-16 h-16 mx-auto mb-4" />
      <p class="text-xl mb-2 text-foreground font-medium">{{ t("welcome.title") }}</p>
      <p class="text-sm text-muted-foreground">
        {{ t("welcome.message") }}
      </p>
    </div>

    <template v-for="(message, index) in messages" :key="message.id">
      <!-- Compact markers before this message -->
      <CompactMarker v-for="marker in getMarkersBeforeMessage(message.timestamp, index)" :key="marker.id" :marker="marker" />

      <!-- User message -->
      <div v-if="message.role === 'user'" class="group relative animate-message-enter">
        <Button
          v-if="canRewindTo(message) && !message.isInjected"
          variant="ghost"
          size="icon-sm"
          class="absolute -left-6 top-2 opacity-0 group-hover:opacity-100 text-base text-muted-foreground hover:text-foreground hover:bg-transparent"
          :title="t('welcome.undoChanges')"
          @click="emit('rewind')"
        >
          ⏪
        </Button>

        <div
          class="rounded-xl px-4 py-1.5"
          :class="message.isInjected || message.isQueued ? 'bg-amber-500/10 ring-1 ring-amber-500/25' : 'bg-muted/75 ring-1 ring-border/60'"
        >
          <div v-if="message.isInjected || message.isQueued" class="flex items-center gap-2 mb-2 text-xs text-amber-400/80">
            <span class="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/30">{{ t("welcome.sentMidStream") }}</span>
            <span v-if="message.isQueued" class="px-1.5 py-0.5 rounded bg-amber-500/20 border border-amber-500/30">{{ t("welcome.queued") }}</span>
          </div>
          <MarkdownRenderer v-if="message.content" :content="message.content" class="text-foreground" />
          <!-- User-attached images (after text) -->
          <div v-if="getImageBlocks(message).length > 0" class="flex flex-wrap gap-2 mt-2">
            <img
              v-for="(img, imgIdx) in getImageBlocks(message)"
              :key="`img-${imgIdx}`"
              :src="imageBlockToDataUrl(img)"
              alt="Attached image"
              class="max-w-32 max-h-32 rounded-md border border-border object-contain cursor-pointer hover:opacity-80 transition-opacity"
              @click="openImageLightbox(img)"
            />
          </div>
          <button
            v-if="!message.isInjected && !message.isQueued"
            type="button"
            class="group/ctx flex items-center gap-1.5 mt-2.5 mb-2 px-2 py-0.5 rounded-full text-xs font-medium text-primary/50 bg-primary/5 border border-primary/10 hover:text-primary hover:bg-primary/10 hover:border-primary/20 transition-all duration-200 cursor-pointer"
            :title="t('contextInjection.viewContext')"
            @click.stop="emit('viewContext', getPromptIndexForMessage(index))"
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

      <!-- Error message (interrupts, failures) -->
      <div v-else-if="message.role === 'error'" class="pl-4 text-error animate-message-enter">{{ t("common.error") }}: {{ message.content }}</div>

      <!-- Assistant message (including streaming) -->
      <div v-else class="relative space-y-3" :class="isStreamingMessage(message) ? 'animate-fade-in' : 'animate-message-enter'">
        <ThinkingIndicator
          v-if="message.thinking || message.thinkingContent || message.isPartial || message.thinkingDuration"
          :thinking="message.thinking || message.thinkingContent"
          :is-streaming="message.isThinkingPhase"
          :duration="message.thinkingDuration"
        />

        <!-- Interleaved rendering: iterate content blocks in order -->
        <template v-if="shouldUseInterleavedRendering(message)">
          <template v-for="(block, blockIndex) in message.contentBlocks" :key="getBlockKey(block, blockIndex)">
            <!-- Text block (committed - no animation, already streamed) -->
            <div v-if="isTextBlock(block)" class="pl-4">
              <MessageContent :content="block.text" :is-streaming="false" :is-thinking-phase="false" />
            </div>

            <!-- Tool use block -->
            <template v-else-if="isToolUseBlock(block)">
              <div class="pl-4 space-y-2">
                <template v-if="getToolCallById(message, block.id)">
                  <SubagentCard
                    v-if="isAgentToolWithSubagent(block.id, block.name) && subagents?.[block.id]"
                    :subagent="subagents[block.id]"
                    @expand="emit('expandSubagent', block.id)"
                  />
                  <QuestionToolCard v-else-if="isAskUserQuestionTool(block.name)" :tool-call="getToolCallById(message, block.id)!" />
                  <ExitPlanModeToolCard v-else-if="isExitPlanModeTool(block.name)" :tool-call="getToolCallById(message, block.id)!" />
                  <EnterPlanModeToolCard v-else-if="isEnterPlanModeTool(block.name)" :tool-call="getToolCallById(message, block.id)!" />
                  <SkillToolCard v-else-if="isSkillTool(block.name)" :tool-call="getToolCallById(message, block.id)!" />
                  <ToolCallCard
                    v-else-if="!isTaskTool(block.name)"
                    :tool-call="getToolCallById(message, block.id)!"
                    @expand="emit('expandTool', $event)"
                    @expand-diff="emit('expandDiff', $event)"
                  />
                </template>
              </div>
            </template>
          </template>

          <!-- Trailing streaming text (text arriving after the last committed block) -->
          <div v-if="isStreamingMessage(message) && getTrailingStreamingText(message)" class="pl-4">
            <MessageContent :content="getTrailingStreamingText(message)" :is-streaming="true" :is-thinking-phase="false" />
          </div>
        </template>

        <!-- Fallback for messages without contentBlocks -->
        <template v-else>
          <div v-if="message.toolCalls?.length" class="pl-4 space-y-2">
            <template v-for="tool in message.toolCalls" :key="tool.id">
              <SubagentCard
                v-if="isAgentToolWithSubagent(tool.id, tool.name) && subagents?.[tool.id]"
                :subagent="subagents[tool.id]"
                @expand="emit('expandSubagent', tool.id)"
              />
              <QuestionToolCard v-else-if="isAskUserQuestionTool(tool.name)" :tool-call="tool" />
              <ExitPlanModeToolCard v-else-if="isExitPlanModeTool(tool.name)" :tool-call="tool" />
              <EnterPlanModeToolCard v-else-if="isEnterPlanModeTool(tool.name)" :tool-call="tool" />
              <SkillToolCard v-else-if="isSkillTool(tool.name)" :tool-call="tool" />
              <ToolCallCard
                v-else-if="!isTaskTool(tool.name)"
                :tool-call="tool"
                @expand="emit('expandTool', $event)"
                @expand-diff="emit('expandDiff', $event)"
              />
            </template>
          </div>

          <div v-if="message.content" class="pl-4">
            <MessageContent
              :content="message.content"
              :is-streaming="isStreamingMessage(message)"
              :is-thinking-phase="message.isThinkingPhase ?? false"
            />
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
