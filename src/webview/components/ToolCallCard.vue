<script setup lang="ts">
import { computed, type Component } from "vue";
import { useI18n } from "vue-i18n";
import type { ToolCall } from "@shared/types/session";
import { TOOL_STRUCTURED_OUTPUT } from "@shared/tool-names";
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
  IconFolder,
  IconPencil,
  IconPencilSquare,
  IconTerminal,
  IconSearch,
  IconGlobe,
  IconWrench,
  IconClipboard,
  IconClock,
  IconCode,
  IconMcp,
  IconCompass,
  IconBrain,
} from "@/components/icons";
import LoadingSpinner from "./LoadingSpinner.vue";
import DiffView from "./DiffView.vue";
import MarkdownRenderer from "./MarkdownRenderer.vue";

const { t } = useI18n();
const { postMessage } = useVSCode();

const EXPANDABLE_TOOLS = new Set(["Bash", "PowerShell", "Read", "Grep", "Glob", "Ls", "WebFetch", "WebSearch", "CodeSearch", "ToolSearch", "CronCreate", "CronDelete", "CronList"]);

/** Memory tool active-set names (source of truth: pi-session/tools/memory-tools.ts MEMORY_SPECS). They
 *  share no common prefix, so they are matched explicitly; browser/compass tools are matched by prefix. */
const MEMORY_TOOL_NAMES = new Set([
  "SaveObservation", "SearchMemories", "GetMemoryDetails", "SaveMemory", "SaveNote",
  "ListNotes", "ResetObservationStaleness", "ForgetMemory", "GetMemoryHistory", "GetRelatedMemories",
  "UnforgetMemory", "UpdateMemory",
]);

/** The Damocles subsystem a custom pi tool belongs to, for icon + expand treatment (null = none). */
function groupForTool(name: string): "browser" | "compass" | "memory" | null {
  if (name.startsWith("Browser")) return "browser";
  if (name.startsWith("Compass")) return "compass";
  if (MEMORY_TOOL_NAMES.has(name)) return "memory";
  return null;
}

const props = defineProps<{
  toolCall: ToolCall;
}>();

const toolGroup = computed(() => groupForTool(props.toolCall.name));

const emit = defineEmits<{
  (e: "expand", toolId: string): void;
  (e: "expandDiff", diff: ExpandedDiff): void;
}>();

const isMcpTool = computed(() => props.toolCall.name.startsWith("mcp__"));
const isStructuredOutput = computed(() => props.toolCall.name === TOOL_STRUCTURED_OUTPUT);
const isExpandable = computed(() => !isStructuredOutput.value && (isMcpTool.value || EXPANDABLE_TOOLS.has(props.toolCall.name) || toolGroup.value !== null));

const displayName = computed(() => isStructuredOutput.value ? t("toolCall.structuredOutput") : props.toolCall.name);

const structuredFields = computed(() =>
  Object.entries(props.toolCall.input).map(([key, value]) => ({
    key,
    isString: typeof value === "string",
    value: typeof value === "string" ? value : "",
    display: typeof value === "string" ? value : JSON.stringify(value, null, 2),
  })),
);

function handleCardClick(): void {
  if (isExpandable.value) {
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

const isLs = computed(() => props.toolCall.name === "Ls");

/** The directory the Ls tool lists; `path` is pi's field and may be omitted (defaults to the cwd). */
const lsPath = computed(() => {
  const p = props.toolCall.input.path;
  return typeof p === "string" && p.length > 0 ? p : ".";
});

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
  if (isMcpTool.value || isStructuredOutput.value) return "border-primary/30";
  return "border-border";
});

const GROUP_ICONS: Record<NonNullable<ReturnType<typeof groupForTool>>, Component> = {
  browser: IconGlobe,
  compass: IconCompass,
  memory: IconBrain,
};

const toolIconComponent = computed((): Component => {
  if (isMcpTool.value) {
    return IconMcp;
  }
  if (toolGroup.value) {
    return GROUP_ICONS[toolGroup.value];
  }
  const icons: Record<string, Component> = {
    Read: IconFile,
    Write: IconPencil,
    Edit: IconPencilSquare,
    Bash: IconTerminal,
    PowerShell: IconTerminal,
    Glob: IconSearch,
    Grep: IconSearch,
    Ls: IconFolder,
    WebFetch: IconGlobe,
    WebSearch: IconSearch,
    CodeSearch: IconCode,
    ToolSearch: IconSearch,
    CronCreate: IconClock,
    CronDelete: IconClock,
    CronList: IconClock,
    LSP: IconWrench,
    Agent: IconClipboard,
    [TOOL_STRUCTURED_OUTPUT]: IconCode,
  };
  return icons[props.toolCall.name] || IconWrench;
});

const toolSearchMeta = computed(() => {
  if (props.toolCall.name !== 'ToolSearch') return null;
  const m = props.toolCall.metadata;
  if (!m) return null;
  const matches = m.matches as string[] | undefined;
  const totalDeferredTools = m.totalDeferredTools as number | undefined;
  if (!matches || totalDeferredTools == null) return null;
  return { matches, totalDeferredTools };
});

const cronCreateMeta = computed(() => {
  if (props.toolCall.name !== 'CronCreate') return null;
  const m = props.toolCall.metadata;
  if (!m) return null;
  const jobId = m.jobId as string | undefined;
  const humanSchedule = m.humanSchedule as string | undefined;
  const recurring = m.recurring as boolean | undefined;
  if (!jobId || !humanSchedule || recurring == null) return null;
  return { jobId, humanSchedule, recurring, durable: m.durable as boolean | undefined };
});

const cronListMeta = computed(() => {
  if (props.toolCall.name !== 'CronList') return null;
  const m = props.toolCall.metadata;
  if (!m) return null;
  const jobs = m.jobs as Array<{ id: string; humanSchedule: string; prompt: string }> | undefined;
  if (!Array.isArray(jobs)) return null;
  return { jobs };
});

function formatToolDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function truncate(value: string, max = 50): string {
  return value.length > max ? value.slice(0, max) + "..." : value;
}

function formatInput(input: Record<string, unknown>): string {
  if ("file_path" in input) {
    return input.file_path as string;
  }
  if ("command" in input) {
    return truncate(input.command as string);
  }
  // Compass relationship query (pattern + target), e.g. "callers_of → AuthManager".
  if ("pattern" in input && "target" in input) {
    return `${input.pattern} → ${input.target}`;
  }
  if ("changed_files" in input && Array.isArray(input.changed_files)) {
    const files = input.changed_files as string[];
    return files.length === 1 ? files[0] : `${files.length} files`;
  }
  if ("pattern" in input) {
    return `Pattern: ${input.pattern}`;
  }
  if ("queries" in input && Array.isArray(input.queries)) {
    return `Query: ${(input.queries as string[]).join(", ")}`;
  }
  if ("query" in input) {
    return `Query: ${input.query}`;
  }
  if ("selector" in input) {
    return input.selector as string;
  }
  if ("expression" in input) {
    return truncate(input.expression as string);
  }
  if ("urls" in input && Array.isArray(input.urls)) {
    return (input.urls as string[]).join(", ");
  }
  if ("url" in input) {
    return input.url as string;
  }
  if ("target" in input) {
    return input.target as string;
  }
  if ("ids" in input && Array.isArray(input.ids)) {
    const ids = input.ids as string[];
    return ids.length === 1 ? ids[0] : `${ids.length} memories`;
  }
  if ("title" in input) {
    return input.title as string;
  }
  if ("content" in input) {
    const prefix = typeof input.kind === "string" ? `${input.kind}: ` : "";
    return prefix + truncate(input.content as string);
  }
  if ("cron" in input && "prompt" in input) {
    return truncate(input.prompt as string, 40);
  }
  if ("id" in input && Object.keys(input).length === 1) {
    return `ID: ${input.id}`;
  }
  if (Object.keys(input).length === 0) {
    return "";
  }
  return JSON.stringify(input).slice(0, 60) + "...";
}

/** The header/IN summary line; empty when the tool takes no meaningful input (so the row is hidden). */
const inputSummary = computed(() => formatInput(props.toolCall.input));
</script>

<template>
  <Card
    class="text-sm overflow-hidden"
    :class="[cardClass, isExpandable ? 'cursor-pointer hover:border-primary/50 transition-colors' : '']"
    @click="handleCardClick"
  >
    <CardHeader
      class="flex flex-row items-center gap-2 px-3 py-1.5 border-b border-border/50 space-y-0"
      :class="isMcpTool ? 'bg-gradient-to-r from-primary/10 to-transparent' : 'bg-foreground/5'"
    >
      <component :is="toolIconComponent" :size="18" class="shrink-0" :class="isMcpTool || isStructuredOutput ? 'text-primary' : 'text-foreground'" />
      <span class="text-foreground font-medium">{{ displayName }}</span>
      <span
        v-if="isFileOperation && filePath"
        class="text-muted-foreground text-xs truncate min-w-0 flex-1 cursor-pointer hover:text-primary hover:underline transition-colors"
        @click.stop="handleFilePathClick"
      >
        {{ filePath }}
      </span>
      <span
        v-else-if="isLs"
        class="text-muted-foreground text-xs font-mono truncate min-w-0 flex-1"
      >
        {{ lsPath }}
      </span>
      <span
        v-if="toolCall.durationMs !== undefined"
        class="text-xs text-muted-foreground font-mono ml-auto shrink-0"
      >
        {{ formatToolDuration(toolCall.durationMs) }}
      </span>
      <LoadingSpinner
        v-if="isPending"
        :size="16"
        :class="[statusClass, toolCall.durationMs !== undefined ? 'ml-2' : 'ml-auto']"
        class="shrink-0"
      />
      <component
        v-else
        :is="statusIconComponent"
        :size="16"
        :class="[statusClass, toolCall.durationMs !== undefined ? 'ml-2' : 'ml-auto']"
        class="shrink-0"
      />
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

    <CardContent v-else-if="isStructuredOutput" class="p-3 space-y-2.5">
      <div v-for="field in structuredFields" :key="field.key" class="space-y-0.5">
        <p class="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{{ field.key }}</p>
        <MarkdownRenderer v-if="field.isString" :content="field.value" class="text-xs" />
        <pre v-else class="text-xs font-mono text-foreground/70 bg-foreground/5 rounded p-2 overflow-x-auto whitespace-pre-wrap break-words">{{ field.display }}</pre>
      </div>
      <div v-if="structuredFields.length === 0" class="text-xs text-muted-foreground italic">{{ t('toolCall.structuredOutputEmpty') }}</div>
    </CardContent>

    <CardContent v-else class="p-3 space-y-2">
      <div v-if="!isLs && (inputSummary || toolCall.name === 'CronList')" class="flex items-start gap-2 text-xs">
        <span class="text-muted-foreground font-medium shrink-0">IN</span>
        <span v-if="toolCall.name === 'CronList'" class="text-foreground/50 italic">{{ t('toolOverlay.cronInfo.listJobs') }}</span>
        <span v-else class="font-mono text-foreground/70 truncate">{{ inputSummary }}</span>
      </div>

      <div
        v-if="isFailed && toolCall.errorMessage"
        class="flex items-start gap-2 text-xs border-t border-error/20 pt-2 -mx-3 px-3 bg-error/10 -mb-3 pb-3"
      >
        <IconXCircle :size="14" class="text-error shrink-0 mt-0.5" />
        <span class="text-error/80">{{ toolCall.errorMessage }}</span>
      </div>

      <div v-else-if="toolSearchMeta" class="text-xs border-t border-border/30 pt-2">
        <div class="flex items-start gap-2">
          <span class="text-muted-foreground font-medium shrink-0">OUT</span>
          <span class="font-mono text-foreground">
            {{ t('toolOverlay.toolSearchInfo.matchCount', { count: toolSearchMeta.matches.length, total: toolSearchMeta.totalDeferredTools }) }}
          </span>
        </div>
      </div>

      <div v-else-if="cronCreateMeta" class="text-xs border-t border-border/30 pt-2">
        <div class="flex items-center gap-2">
          <span class="text-muted-foreground font-medium shrink-0">OUT</span>
          <span class="font-mono text-foreground">{{ cronCreateMeta.humanSchedule }}</span>
          <code class="text-xs px-1 py-0.5 rounded" :class="cronCreateMeta.recurring ? 'bg-primary/15 text-primary' : 'bg-amber-500/15 text-amber-400'">
            {{ cronCreateMeta.recurring ? t('toolOverlay.cronInfo.recurring') : t('toolOverlay.cronInfo.oneShot') }}
          </code>
        </div>
      </div>

      <div v-else-if="cronListMeta" class="text-xs border-t border-border/30 pt-2">
        <div class="flex items-start gap-2">
          <span class="text-muted-foreground font-medium shrink-0">OUT</span>
          <span class="font-mono text-foreground">
            {{ cronListMeta.jobs.length > 0
              ? t('toolOverlay.cronInfo.jobCount', { count: cronListMeta.jobs.length })
              : t('toolOverlay.cronInfo.noJobs')
            }}
          </span>
        </div>
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
