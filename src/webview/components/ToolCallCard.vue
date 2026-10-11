<script setup lang="ts">
import { computed, ref, type Component } from "vue";
import { useI18n } from "vue-i18n";
import type { ToolAbandonReason, ToolCall } from "@shared/types/session";
import { TOOL_STRUCTURED_OUTPUT, TOOL_GENERATE_IMAGE, LIVE_OUTPUT_TOOLS } from "@shared/tool-names";
import { TEAM_TOOL_PRESENTATION } from "@shared/team-tool-labels";
import { useDiffStore } from "@/stores/useDiffStore";
import { useUIStore, type ExpandedToolSource } from "@/stores/useUIStore";
import { usePlatformBridge } from "@/composables/usePlatformBridge";
import { useFolderRelativePath } from "@/composables/useFolderRelativePath";
import { ownEntry } from "@/utils/ownEntry";
import { buildFileDiff, fileChangeSource } from "@/utils/parseUnifiedDiff";
import { usePermissionStore } from "@/stores/usePermissionStore";
import {
  Ban, Bot, Brain, Check, CircleCheck, CircleQuestionMark, CircleX, ClipboardList, Clock, Code, Compass, Eye, FilePen,
  FilePlus, FileText, Folder, FolderSearch, Globe, ImagePlus, Layers, MessageSquare, Play, Plug,
  RotateCcw, Search, Send, Signal, SquareTerminal, TriangleAlert, Users, Wrench, X, ChevronDown,
} from "lucide-vue-next";
import ToolCardFrame from "./ToolCardFrame.vue";
import LiveOutputPane from "./LiveOutputPane.vue";
import ToolCancelControl from "./ToolCancelControl.vue";
import DiffView from "./DiffView.vue";
import StructuredResult from "./StructuredResult.vue";

const { t } = useI18n();
const displayPath = useFolderRelativePath();
const { postMessage } = usePlatformBridge();
const permissionStore = usePermissionStore();
const uiStore = useUIStore();
const diffStore = useDiffStore();

const EXPANDABLE_TOOLS = new Set(["Bash", "PowerShell", "Read", "Grep", "Glob", "Ls", "WebFetch", "WebSearch", "CodeSearch", "FeedRead", "YouTubeTranscript", "ToolSearch", "CronCreate", "CronDelete", "CronList", TOOL_GENERATE_IMAGE]);

/** Memory tool active-set names (source of truth: pi-session/tools/memory-tools.ts MEMORY_SPECS). They
 *  share no common prefix, so they are matched explicitly; browser/compass tools are matched by prefix. */
const MEMORY_TOOL_NAMES = new Set([
  "SaveObservation", "SearchMemories", "GetMemoryDetails", "SaveMemory", "SaveNote",
  "ListNotes", "ResetObservationStaleness", "ForgetMemory", "GetMemoryHistory", "GetRelatedMemories",
  "UnforgetMemory", "UpdateMemory",
]);

/** Icons for the twenty team tools. `TEAM_TOOL_PRESENTATION` is the name list; this only picks glyphs. */
const TEAM_TOOL_ICONS: Record<string, Component> = {
  create_team: Users,
  get_team_status: Signal,
  cancel_team: X,
  resume_team: Play,

  team_send_message: Send,
  team_read_messages: MessageSquare,
  team_read_scratchpad: Eye,
  team_write_scratchpad: FilePen,
  team_get_status: Signal,
  team_spawn_specialist: Bot,
  team_redispatch_specialist: RotateCcw,
  team_cancel_specialist: X,
  team_request_revision: RotateCcw,
  team_approve_specialist: CircleCheck,
  team_standby: Clock,
  team_report_complete: Check,
  team_flag_brief_conflict: TriangleAlert,
  team_resolve_brief_conflict: CircleCheck,
  team_dismiss_review: Ban,
  team_record_verification: ClipboardList,
  team_synthesize_result: Layers,
};

/** The Damocles subsystem a custom pi tool belongs to, for icon + expand treatment (null = none). */
function groupForTool(name: string): "browser" | "compass" | "memory" | null {
  if (name.startsWith("Browser")) return "browser";
  if (name.startsWith("Compass")) return "compass";
  if (MEMORY_TOOL_NAMES.has(name)) return "memory";
  return null;
}

const props = defineProps<{
  toolCall: ToolCall;
  source: ExpandedToolSource;
}>();

const toolGroup = computed(() => groupForTool(props.toolCall.name));

const isMcpTool = computed(() => props.toolCall.name.startsWith("mcp__"));
const isStructuredOutput = computed(() => props.toolCall.name === TOOL_STRUCTURED_OUTPUT);

/** Undefined for every tool that is not one of the twenty team tools. */
const teamPresentation = computed(() => ownEntry(TEAM_TOOL_PRESENTATION, props.toolCall.name));
const teamToolLabel = computed(() => teamPresentation.value?.label);

const isExpandable = computed(() => !isStructuredOutput.value && (isMcpTool.value || EXPANDABLE_TOOLS.has(props.toolCall.name) || toolGroup.value !== null || teamToolLabel.value !== undefined));

// The overlay keeps showing the raw snake_case name, so session logs and greps still match the card.
const displayName = computed(() => {
  if (isStructuredOutput.value) return t("toolCall.structuredOutput");
  return teamToolLabel.value ?? props.toolCall.name;
});

const structuredFields = computed(() => Object.keys(props.toolCall.input));

function handleDiffClick(): void {
  if (diffSource.value && filePath.value) {
    diffStore.expandDiff({
      filePath: filePath.value,
      tool: props.toolCall.name === "Write" ? "Write" : "Edit",
      source: diffSource.value,
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

// While the call awaits approval, the pending prompt holds the change's real-numbered patch. Read only
// then, and through its own computed, so another call's prompt never re-parses and re-highlights this card.
const pendingApproval = computed(() =>
  props.toolCall.status === "awaiting_approval" ? permissionStore.pendingPermissions[props.toolCall.id] : undefined,
);
const diffSource = computed(() =>
  isFileOperation.value ? fileChangeSource(props.toolCall, pendingApproval.value) : null,
);
const fileDiff = computed(() => (diffSource.value ? buildFileDiff(diffSource.value) : null));

/** The change size beside an Edit or Write, as the reference's "+7 −0" chip. */
const changeMeta = computed(() => {
  const diff = fileDiff.value;
  if (!diff || diff.omitted) return null;
  return `+${diff.stats.added} −${diff.stats.removed}`;
});

const isRunning = computed(() => props.toolCall.status === "running");
const isFailed = computed(() => props.toolCall.status === "failed");
const isAbandoned = computed(() => props.toolCall.status === "abandoned");
const isCancelled = computed(() => props.toolCall.status === "cancelled");
const isUnrecorded = computed(() => props.toolCall.status === "unrecorded");

const showLiveOutput = computed(() =>
  isRunning.value && LIVE_OUTPUT_TOOLS.has(props.toolCall.name) && props.toolCall.liveOutput !== undefined
);
const liveOutputText = computed(() => props.toolCall.liveOutput ?? "");

const GROUP_ICONS: Record<NonNullable<ReturnType<typeof groupForTool>>, Component> = {
  browser: Globe,
  compass: Compass,
  memory: Brain,
};

const BUILT_IN_TOOL_ICONS: Record<string, Component> = {
  Read: FileText,
  Write: FilePlus,
  Edit: FilePen,
  Bash: SquareTerminal,
  PowerShell: SquareTerminal,
  Glob: FolderSearch,
  Grep: Search,
  Ls: Folder,
  WebFetch: Globe,
  WebSearch: Search,
  CodeSearch: Code,
  FeedRead: Globe,
  YouTubeTranscript: FileText,
  ToolSearch: Search,
  CronCreate: Clock,
  CronDelete: Clock,
  CronList: Clock,
  LSP: Wrench,
  Agent: Bot,
  [TOOL_GENERATE_IMAGE]: ImagePlus,
  [TOOL_STRUCTURED_OUTPUT]: Code,
};

const toolIconComponent = computed((): Component => {
  if (isMcpTool.value) {
    return Plug;
  }
  if (toolGroup.value) {
    return GROUP_ICONS[toolGroup.value];
  }
  return (
    ownEntry(TEAM_TOOL_ICONS, props.toolCall.name) ??
    ownEntry(BUILT_IN_TOOL_ICONS, props.toolCall.name) ??
    Wrench
  );
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
    return displayPath(input.file_path as string);
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
    return files.length === 1 ? files[0] ?? "" : t("toolCall.inputFiles", { n: files.length });
  }
  if ("pattern" in input) {
    return t("toolCall.inputPattern", { pattern: String(input.pattern) });
  }
  if ("queries" in input && Array.isArray(input.queries)) {
    return t("toolCall.inputQuery", { query: (input.queries as string[]).join(", ") });
  }
  if ("query" in input) {
    return t("toolCall.inputQuery", { query: String(input.query) });
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
    return ids.length === 1 ? ids[0] ?? "" : `${ids.length} memories`;
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
const inputSummary = computed(() => {
  const presentation = teamPresentation.value;
  return presentation ? presentation.summarizeInput(props.toolCall.input) : formatInput(props.toolCall.input);
});

const headerArg = computed(() => {
  if (isLs.value) return lsPath.value;
  if (isStructuredOutput.value) return undefined;
  return props.toolCall.name === "CronList" ? t("toolOverlay.cronInfo.listJobs") : inputSummary.value;
});

const peek = ref(false);

/** An error result stays raw; the presentation summary describes a happy path that did not happen. */
const resultSummary = computed(() => {
  const result = props.toolCall.result;
  if (result === undefined) return "";
  const presentation = teamPresentation.value;
  if (!presentation || props.toolCall.isError === true) return truncate(result, 200);
  return presentation.summarizeResult(result, props.toolCall.input);
});

const outputSummary = computed(() => {
  if (toolSearchMeta.value) return t('toolOverlay.toolSearchInfo.matchCount', { count: toolSearchMeta.value.matches.length, total: toolSearchMeta.value.totalDeferredTools });
  if (cronCreateMeta.value) return cronCreateMeta.value.humanSchedule;
  if (cronListMeta.value) {
    return cronListMeta.value.jobs.length > 0
      ? t('toolOverlay.cronInfo.jobCount', { count: cronListMeta.value.jobs.length })
      : t('toolOverlay.cronInfo.noJobs');
  }
  if (isFailed.value && props.toolCall.errorMessage) return '';
  return resultSummary.value;
});

const hasPeek = computed(() => !isFileOperation.value && !isStructuredOutput.value && Boolean(inputSummary.value || outputSummary.value));

const ABANDONED_DESCRIPTION_KEYS: Record<ToolAbandonReason, string> = {
  stopped: "toolCall.abandonedStopped",
  failed: "toolCall.abandonedFailed",
};
const abandonedDescription = computed(() => {
  const reason = props.toolCall.abandonReason;
  return reason ? t(ABANDONED_DESCRIPTION_KEYS[reason]) : undefined;
});

const statusNote = computed(() => {
  if (isAbandoned.value) return { icon: Ban, title: t('toolCall.notExecuted'), description: abandonedDescription.value };
  if (isCancelled.value) return { icon: Ban, title: t('toolCall.cancelled'), description: t('toolCall.cancelledDescription') };
  if (isUnrecorded.value) return { icon: CircleQuestionMark, title: t('toolCall.outcomeUnrecorded'), description: t('toolCall.outcomeUnrecordedDescription') };
  return null;
});
</script>

<template>
  <ToolCardFrame
    :icon="toolIconComponent"
    :name="displayName"
    :arg="headerArg"
    :arg-title="filePath || undefined"
    :status="toolCall.status"
    :expandable="isExpandable"
    data-testid="tool-card"
    @expand="uiStore.expandTool(toolCall.id, source)"
  >
    <template
      v-if="isFileOperation && filePath"
      #arg
    >
      <button
        type="button"
        class="min-w-0 flex-1 truncate text-left font-mono text-11.5 text-(--d-muted) transition-colors hover:text-(--d-accent)"
        :title="filePath"
        @click.stop="handleFilePathClick"
      >
        {{ displayPath(filePath) }}
      </button>
    </template>
    <template #meta>
      <span
        v-if="changeMeta"
        class="flex-none rounded-5 bg-(--d-hover) px-1.5 py-px font-mono text-10.5 text-(--d-muted)"
        data-testid="tool-card-change"
      >{{ changeMeta }}</span>
      <ToolCancelControl
        :tool-call="toolCall"
        :source="source"
      />
      <span
        v-if="toolCall.durationMs !== undefined"
        class="flex-none font-mono text-10.5 text-(--d-faint)"
      >{{ formatToolDuration(toolCall.durationMs) }}</span>
    </template>
    <template #trailing>
      <button
        v-if="hasPeek"
        type="button"
        class="-mr-1 flex flex-none rounded-5 p-0.75 text-(--d-faint) transition-colors hover:bg-(--d-border) hover:text-(--d-text)"
        :aria-expanded="peek"
        :aria-label="peek ? t('cards.tool.hideIo') : t('cards.tool.showIo')"
        :title="peek ? t('cards.tool.hideIo') : t('cards.tool.showIo')"
        data-testid="tool-card-peek"
        @click.stop="peek = !peek"
      >
        <ChevronDown
          class="size-3.25 transition-transform duration-200 ease-out"
          :class="peek && 'rotate-180'"
          aria-hidden="true"
        />
      </button>
    </template>

    <div
      v-if="fileDiff"
      class="mx-2 mb-2"
    >
      <button
        type="button"
        class="group relative block w-full overflow-hidden rounded-lg border border-(--d-border) bg-(--d-code) text-left"
        :aria-label="t('toolCall.clickToExpand')"
        @click="handleDiffClick"
      >
        <DiffView
          :diff="fileDiff"
          :file-name="filePath"
          max-height="18.75rem"
        />
        <span class="pointer-events-none absolute right-2 bottom-2 rounded-md border border-(--d-border2) bg-(--d-card) px-2 py-0.5 text-11 text-(--d-muted) opacity-0 shadow-(--d-shadow) transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
          {{ t("toolCall.clickToExpand") }}
        </span>
      </button>
    </div>

    <div
      v-else-if="isStructuredOutput"
      class="space-y-2.5 border-t border-(--d-border) px-3 pt-2 pb-2.5"
    >
      <StructuredResult :value="toolCall.input" />
      <div
        v-if="structuredFields.length === 0"
        class="text-xs text-(--d-faint) italic"
      >
        {{ t('toolCall.structuredOutputEmpty') }}
      </div>
    </div>

    <!-- Stops the click so selecting output text does not expand the card. -->
    <div
      v-if="showLiveOutput"
      class="mx-2 mb-2 space-y-1"
      @click.stop
    >
      <p class="flex items-center gap-1.5 text-10 tracking-[.06em] text-(--d-faint) uppercase">
        <span
          class="d-pulsing size-1.5 rounded-full bg-(--d-accent)"
          aria-hidden="true"
        />{{ t('toolCall.liveOutput') }}
      </p>
      <LiveOutputPane
        :output="liveOutputText"
        :truncated="toolCall.liveOutputTruncated === true"
        height-class="h-45"
      />
    </div>

    <div
      v-if="hasPeek"
      class="grid transition-[grid-template-rows] duration-250 ease-out"
      :class="peek ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'"
      :inert="!peek"
    >
      <div class="min-h-0 overflow-hidden">
        <div class="grid grid-cols-[2.125rem_1fr] gap-x-2 gap-y-1 border-t border-(--d-border) px-3 pt-2 pb-2.5 text-11.5">
          <template v-if="inputSummary && !isLs">
            <span class="font-semibold text-(--d-faint)">{{ t('toolCall.in') }}</span>
            <span class="font-mono break-all text-(--d-muted)">{{ inputSummary }}</span>
          </template>
          <template v-if="outputSummary">
            <span class="font-semibold text-(--d-faint)">{{ t('toolCall.out') }}</span>
            <span
              class="flex flex-wrap items-center gap-2 font-mono break-all"
              :class="toolCall.isError ? 'text-(--d-danger)' : 'text-(--d-text)'"
            >
              {{ outputSummary }}
              <code
                v-if="cronCreateMeta"
                class="rounded px-1 py-0.5 text-xs"
                :class="cronCreateMeta.recurring ? 'bg-(--d-accent-soft) text-(--d-accent-text)' : 'bg-[color-mix(in_srgb,var(--d-warning)_14%,transparent)] text-(--d-warning-text)'"
              >
                {{ cronCreateMeta.recurring ? t('toolOverlay.cronInfo.recurring') : t('toolOverlay.cronInfo.oneShot') }}
              </code>
            </span>
          </template>
        </div>
      </div>
    </div>

    <div
      v-if="isFailed && toolCall.errorMessage"
      class="flex items-start gap-2 border-t border-[color-mix(in_srgb,var(--d-danger)_25%,transparent)] bg-[color-mix(in_srgb,var(--d-danger)_8%,transparent)] px-3 py-2 text-xs text-(--d-danger-text)"
    >
      <CircleX
        class="size-3.25 mt-px flex-none"
        aria-hidden="true"
      />
      <span>{{ toolCall.errorMessage }}</span>
    </div>

    <div
      v-if="statusNote"
      class="flex items-start gap-2 border-t border-(--d-border) px-3 py-2 text-xs text-(--d-muted)"
    >
      <component
        :is="statusNote.icon"
        class="size-3.25 mt-px flex-none text-(--d-faint)"
        aria-hidden="true"
      />
      <span><span class="font-semibold text-(--d-text)">{{ statusNote.title }}</span><template v-if="statusNote.description"> · {{ statusNote.description }}</template></span>
    </div>

    <div
      v-if="isRunning"
      class="d-sweep-bar h-0.5 bg-(--d-hover) text-(--d-accent)"
      aria-hidden="true"
    />
  </ToolCardFrame>
</template>
