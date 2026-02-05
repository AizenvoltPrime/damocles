<script setup lang="ts">
import { computed, type Component } from "vue";
import { useI18n } from "vue-i18n";
import type { ToolCall } from "@shared/types/session";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import type { ExpandedDiff } from "@/stores/useDiffStore";
import { useVSCode } from "@/composables/useVSCode";

import {
  IconGear,
  IconLock,
  IconCheckCircle,
  IconXCircle,
  IconCheck,
  IconWarning,
  IconBan,
  IconFile,
  IconPencil,
  IconPencilSquare,
  IconTerminal,
  IconSearch,
  IconGlobe,
  IconWrench,
  IconClipboard,
  IconMcp,
} from "@/components/icons";
import LoadingSpinner from "./LoadingSpinner.vue";
import DiffView from "./DiffView.vue";

const { t } = useI18n();
const { postMessage } = useVSCode();

const props = defineProps<{
  toolCall: ToolCall;
}>();

const emit = defineEmits<{
  (e: "expand", toolId: string): void;
  (e: "expandDiff", diff: ExpandedDiff): void;
}>();

const isMcpTool = computed(() => props.toolCall.name.startsWith("mcp__"));

function handleCardClick(): void {
  if (isMcpTool.value) {
    emit("expand", props.toolCall.id);
  }
}

function handleDiffClick(): void {
  if (diffContent.value && filePath.value) {
    emit("expandDiff", {
      filePath: filePath.value,
      oldContent: diffContent.value.oldContent,
      newContent: diffContent.value.newContent,
      isNewFile: isNewFile.value,
    });
  }
}

function handleFilePathClick(event: MouseEvent): void {
  event.stopPropagation();
  if (!filePath.value) return;
  const lineNumber = props.toolCall.metadata?.editLineNumber as number | undefined;
  postMessage({
    type: "openFile",
    filePath: filePath.value,
    line: lineNumber ?? 1,
  });
}

const isFileOperation = computed(() => props.toolCall.name === "Edit" || props.toolCall.name === "Write");

const filePath = computed(() => {
  if ("file_path" in props.toolCall.input) {
    return props.toolCall.input.file_path as string;
  }
  return "";
});

const isNewFile = computed(() => props.toolCall.name === "Write");

const diffContent = computed(() => {
  if (!isFileOperation.value) return null;

  const input = props.toolCall.input;

  if (props.toolCall.name === "Edit") {
    return {
      oldContent: (input.old_string as string) || "",
      newContent: (input.new_string as string) || "",
    };
  }

  return {
    oldContent: "",
    newContent: (input.content as string) || "",
  };
});

const isPending = computed(() => props.toolCall.status === "pending");

const statusIconComponent = computed((): Component | null => {
  switch (props.toolCall.status) {
    case "pending":
      return null;
    case "running":
      return IconGear;
    case "awaiting_approval":
      return IconLock;
    case "approved":
      return IconCheckCircle;
    case "denied":
      return IconXCircle;
    case "completed":
      return IconCheck;
    case "failed":
      return IconWarning;
    case "abandoned":
      return IconBan;
    default:
      return IconGear;
  }
});

const statusClass = computed(() => {
  switch (props.toolCall.status) {
    case "pending":
      return "text-muted-foreground";
    case "running":
      return "text-primary animate-spin-slow";
    case "awaiting_approval":
      return "text-warning animate-pulse";
    case "approved":
    case "completed":
      return "text-success";
    case "denied":
    case "failed":
      return "text-error";
    case "abandoned":
      return "text-muted-foreground";
    default:
      return "text-muted-foreground";
  }
});

const isRunning = computed(() => props.toolCall.status === "running");
const isFailed = computed(() => props.toolCall.status === "failed");
const isAbandoned = computed(() => props.toolCall.status === "abandoned");
const isAwaitingApproval = computed(() => props.toolCall.status === "awaiting_approval");

const cardClass = computed(() => {
  if (isFailed.value) return "border-error/50";
  if (isAbandoned.value) return "border-muted/50 opacity-60";
  if (isMcpTool.value) return "border-primary/30";
  return "border-border";
});

const toolIconComponent = computed((): Component => {
  if (isMcpTool.value) {
    return IconMcp;
  }
  const icons: Record<string, Component> = {
    Read: IconFile,
    Write: IconPencil,
    Edit: IconPencilSquare,
    Bash: IconTerminal,
    Glob: IconSearch,
    Grep: IconSearch,
    WebFetch: IconGlobe,
    WebSearch: IconSearch,
    LSP: IconWrench,
    Task: IconClipboard,
  };
  return icons[props.toolCall.name] || IconWrench;
});

function formatInput(input: Record<string, unknown>): string {
  if ("file_path" in input) {
    return input.file_path as string;
  }
  if ("command" in input) {
    const cmd = input.command as string;
    return cmd.length > 50 ? cmd.slice(0, 50) + "..." : cmd;
  }
  if ("pattern" in input) {
    return `Pattern: ${input.pattern}`;
  }
  if ("query" in input) {
    return `Query: ${input.query}`;
  }
  if ("url" in input) {
    return input.url as string;
  }
  return JSON.stringify(input).slice(0, 60) + "...";
}
</script>

<template>
  <Card
    class="text-sm overflow-hidden"
    :class="[cardClass, isMcpTool ? 'cursor-pointer hover:border-primary/50 transition-colors' : '']"
    @click="handleCardClick"
  >
    <CardHeader
      class="flex flex-row items-center gap-2 px-3 py-1.5 border-b border-border/50 space-y-0"
      :class="isMcpTool ? 'bg-gradient-to-r from-primary/10 to-transparent' : 'bg-foreground/5'"
    >
      <component :is="toolIconComponent" :size="18" class="shrink-0" :class="isMcpTool ? 'text-primary' : 'text-foreground'" />
      <span class="text-foreground font-medium">{{ toolCall.name }}</span>
      <span
        v-if="isFileOperation && filePath"
        class="text-muted-foreground text-xs truncate min-w-0 flex-1 cursor-pointer hover:text-primary hover:underline transition-colors"
        @click.stop="handleFilePathClick"
      >
        {{ filePath }}
      </span>
      <LoadingSpinner v-if="isPending" :size="16" :class="statusClass" class="ml-auto shrink-0" />
      <component v-else :is="statusIconComponent" :size="16" :class="statusClass" class="ml-auto shrink-0" />
    </CardHeader>

    <CardContent v-if="isFileOperation && diffContent" class="p-2">
      <div
        class="relative group cursor-pointer rounded border border-border/50 overflow-hidden shadow-[inset_0_1px_4px_rgba(0,0,0,0.3)]"
        @click="handleDiffClick"
      >
        <DiffView
          :old-content="diffContent.oldContent"
          :new-content="diffContent.newContent"
          :file-name="filePath"
          :is-new-file="isNewFile"
          :show-header="false"
          max-height="300px"
        />

        <div class="absolute inset-0 flex items-center justify-center bg-black/0 group-hover:bg-black/40 transition-colors pointer-events-none">
          <Button variant="secondary" size="sm" class="opacity-0 group-hover:opacity-100 transition-opacity text-xs pointer-events-none">
            {{ t("toolCall.clickToExpand") }}
          </Button>
        </div>
      </div>

      <div v-if="isFailed && toolCall.errorMessage" class="px-3 py-2 border-t border-error/20 bg-error/10">
        <div class="flex items-start gap-2 text-xs">
          <IconXCircle :size="14" class="text-error shrink-0 mt-0.5" />
          <span class="text-error/80">{{ toolCall.errorMessage }}</span>
        </div>
      </div>

      <Alert v-if="isAwaitingApproval" class="mt-2 p-2 text-xs bg-amber-900/20 border-amber-500/30 animate-pulse">
        <AlertTitle class="text-amber-400 font-semibold mb-0">{{ t("toolCall.awaitingApproval") }}</AlertTitle>
        <AlertDescription class="text-amber-400">{{ t("toolCall.respondToDialog") }}</AlertDescription>
      </Alert>

      <div v-if="isRunning" class="h-0.5 bg-muted rounded overflow-hidden mt-2">
        <div class="h-full bg-primary animate-progress"></div>
      </div>
    </CardContent>

    <CardContent v-else class="p-3 space-y-2">
      <div class="flex items-start gap-2 text-xs">
        <span class="text-muted-foreground font-medium shrink-0">IN</span>
        <span class="font-mono text-foreground/70 truncate">{{ formatInput(toolCall.input) }}</span>
      </div>

      <div
        v-if="isFailed && toolCall.errorMessage"
        class="flex items-start gap-2 text-xs border-t border-error/20 pt-2 -mx-3 px-3 bg-error/10 -mb-3 pb-3"
      >
        <IconXCircle :size="14" class="text-error shrink-0 mt-0.5" />
        <span class="text-error/80">{{ toolCall.errorMessage }}</span>
      </div>

      <div v-else-if="toolCall.result" class="text-xs border-t border-border/30 pt-2">
        <div class="flex items-start gap-2">
          <span class="text-muted-foreground font-medium shrink-0">OUT</span>
          <span class="font-mono overflow-x-auto" :class="toolCall.isError ? 'text-error' : 'text-foreground'">
            {{ toolCall.result.slice(0, 200) }}{{ toolCall.result.length > 200 ? "..." : "" }}
          </span>
        </div>
      </div>

      <Alert v-if="isAwaitingApproval" class="p-2 text-xs bg-amber-900/20 border-amber-500/30 animate-pulse">
        <AlertTitle class="text-amber-400 font-semibold mb-0">{{ t("toolCall.awaitingApproval") }}</AlertTitle>
        <AlertDescription class="text-amber-400">{{ t("toolCall.respondToDialog") }}</AlertDescription>
      </Alert>

      <Alert v-if="isAbandoned" class="p-2 text-xs bg-gray-800/40 border-gray-600/30">
        <AlertTitle class="text-gray-400 font-semibold mb-0">{{ t("toolCall.notExecuted") }}</AlertTitle>
        <AlertDescription class="text-gray-400">{{ t("toolCall.changedCourse") }}</AlertDescription>
      </Alert>

      <div v-if="isRunning" class="h-0.5 bg-muted rounded overflow-hidden">
        <div class="h-full bg-primary animate-progress"></div>
      </div>
    </CardContent>
  </Card>
</template>

<style scoped>
@keyframes progress {
  0% {
    transform: translateX(-100%);
    width: 30%;
  }
  50% {
    width: 50%;
  }
  100% {
    transform: translateX(400%);
    width: 30%;
  }
}

.animate-progress {
  animation: progress 1.5s ease-in-out infinite;
}
</style>
