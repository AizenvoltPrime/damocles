<script setup lang="ts">
import { ref, computed, useId, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ToolCall, ToolResultOwner } from '@shared/types/session';
import { isShellTool, LIVE_OUTPUT_TOOLS, TOOL_GENERATE_IMAGE } from '@shared/tool-names';
import { TEAM_TOOL_LABELS } from '@shared/team-tool-labels';
import { cronToIntervalLabel } from '@shared/utils/cron';
import {
  Bot, Check, ChevronRight, CircleCheck, CircleX, Clock, Code, Copy, CornerDownRight, ExternalLink, FileText, Globe,
  ImagePlus, LoaderCircle, Search, SquareTerminal,
} from 'lucide-vue-next';
import LiveOutputPane from './LiveOutputPane.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import CodeBlock from './CodeBlock.vue';
import OverlayShell from './OverlayShell.vue';
import OverlayHeaderAction from './OverlayHeaderAction.vue';
import ToolCancelControl from './ToolCancelControl.vue';
import ToolResultImages from './ToolResultImages.vue';
import ImageLightbox from './ImageLightbox.vue';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { sanitizeUrl } from '@/lib/sanitize-url';
import { ownEntry } from '@/utils/ownEntry';
import { useUIStore, type ExpandedToolSource } from '@/stores/useUIStore';
import { useFolderRelativePath } from '@/composables/useFolderRelativePath';
import { useCopyToClipboard } from '@/composables/useCopyToClipboard';

const TOOL_ICON_MAP: Record<string, Component> = {
  Bash: SquareTerminal,
  PowerShell: SquareTerminal,
  Read: FileText,
  Grep: Search,
  Glob: Search,
  WebFetch: Globe,
  WebSearch: Search,
  CodeSearch: Code,
  FeedRead: Globe,
  YouTubeTranscript: FileText,
  ToolSearch: Search,
  CronCreate: Clock,
  CronDelete: Clock,
  CronList: Clock,
  [TOOL_GENERATE_IMAGE]: ImagePlus,
};

const EXT_LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
  vue: 'vue', py: 'python', rs: 'rust', go: 'go',
  json: 'json', yaml: 'yaml', yml: 'yaml', md: 'markdown',
  html: 'html', css: 'css', scss: 'scss', sh: 'bash',
  toml: 'toml', xml: 'xml', sql: 'sql', c: 'c', cpp: 'cpp',
  java: 'java', kt: 'kotlin', rb: 'ruby', swift: 'swift',
};

const { t } = useI18n();
const displayPath = useFolderRelativePath();
const { postMessage } = usePlatformBridge();
const uiStore = useUIStore();

const props = defineProps<{
  tool: ToolCall;
  owner?: ToolResultOwner | undefined;
}>();

const cancelSource = computed((): ExpandedToolSource => uiStore.expandedToolSource ?? 'session');

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const isInputExpanded = ref(true);
const isResponseExpanded = ref(true);

const teamToolLabel = computed(() => ownEntry(TEAM_TOOL_LABELS, props.tool.name));
const isTeamTool = computed(() => teamToolLabel.value !== undefined);

const toolIcon = computed((): Component => {
  if (isTeamTool.value) return Bot;
  return ownEntry(TOOL_ICON_MAP, props.tool.name) ?? Search;
});

const subtitle = computed(() => {
  const input = props.tool.input;
  if (isShellTool(props.tool.name) && input.description) return input.description as string;
  if ((props.tool.name === 'Read' || props.tool.name === TOOL_GENERATE_IMAGE) && input.file_path) return displayPath(input.file_path as string);
  if (props.tool.name === 'Grep' && input.pattern) return `/${input.pattern as string}/`;
  if (props.tool.name === 'Glob' && input.pattern) return input.pattern as string;
  if (props.tool.name === 'WebFetch' && input.url) return input.url as string;
  if (props.tool.name === 'WebSearch' && input.query) return input.query as string;
  if (props.tool.name === 'FeedRead' && input.url) return input.url as string;
  if (props.tool.name === 'YouTubeTranscript' && input.url) return input.url as string;
  if (props.tool.name === 'ToolSearch' && Array.isArray(input.tools)) return (input.tools as string[]).join(', ');
  if (props.tool.name === 'CronCreate' && input.cron) return input.cron as string;
  if (props.tool.name === 'CronDelete' && input.id) return `ID: ${input.id}`;
  if (props.tool.name === 'CronList') return t('toolOverlay.cronInfo.listJobs');
  // The header title stays the raw snake_case name; the label rides underneath it.
  return teamToolLabel.value ?? t('toolOverlay.builtInTool');
});

const isRunning = computed(() => {
  const s = props.tool.status;
  return s === 'running' || s === 'pending';
});
const isFailed = computed(() => props.tool.status === 'failed');
const isCompleted = computed(() => props.tool.status === 'completed');
const isCancelled = computed(() => props.tool.status === 'cancelled');
const isUnrecorded = computed(() => props.tool.status === 'unrecorded');

const showLiveOutput = computed(() =>
  isRunning.value && LIVE_OUTPUT_TOOLS.has(props.tool.name) && props.tool.liveOutput !== undefined
);
const liveOutputText = computed(() => props.tool.liveOutput ?? '');

const statusBadge = computed(() => {
  if (isRunning.value) return { label: t('toolOverlay.statusRunning'), class: 'd-tone-accent', pulse: true };
  if (props.tool.status === 'awaiting_approval') return { label: t('toolCall.awaitingApproval'), class: 'd-tone-warning', pulse: true };
  if (isCompleted.value) return { label: t('toolOverlay.statusCompleted'), class: 'd-tone-success' };
  if (isFailed.value) return { label: t('toolOverlay.statusFailed'), class: 'd-tone-danger' };
  if (isCancelled.value) return { label: t('toolOverlay.statusCancelled'), class: 'd-tone-muted' };
  if (isUnrecorded.value) return { label: t('toolOverlay.statusUnrecorded'), class: 'd-tone-muted' };
  return { label: props.tool.status, class: 'd-tone-warning' };
});

const hasResult = computed(() => Boolean(props.tool.result?.trim()) || (props.tool.imageCount ?? 0) > 0);

const lightboxImageUrl = ref<string | null>(null);

const SHIKI_LINE_LIMIT = 5000;

const useMarkdownResponse = computed(() =>
  props.tool.name === 'WebFetch' || props.tool.name === 'WebSearch' || props.tool.name === 'FeedRead'
);

const isCodeSearch = computed(() => props.tool.name === 'CodeSearch');

/** The web tools accept both singular and plural inputs (url/urls, query/queries). */
const webFetchTargets = computed(() => {
  const { url, urls } = props.tool.input;
  if (typeof url === 'string' && url) return url;
  return Array.isArray(urls) ? (urls as string[]).join(', ') : '';
});

/** Source URL used as the base for resolving relative image/link URLs in WebFetch/FeedRead markdown. */
const webFetchBaseUrl = computed<string | undefined>(() => {
  if (props.tool.name !== 'WebFetch' && props.tool.name !== 'FeedRead') return undefined;
  const { url, urls } = props.tool.input;
  if (typeof url === 'string' && url) return url;
  return Array.isArray(urls) && typeof urls[0] === 'string' ? (urls[0] as string) : undefined;
});

interface CodeSearchBlock {
  title: string;
  url: string;
  meta: string;
  code: string;
  language: string;
}

function detectLanguageFromUrl(url: string): string {
  try {
    const ext = new URL(url).pathname.split('.').pop()?.toLowerCase() ?? '';
    return ownEntry(EXT_LANG_MAP, ext) ?? 'text';
  } catch {
    return 'text';
  }
}

/** Format an Exa `Published:` value as YYYY-MM-DD; fall back to the raw string when unparseable. */
function formatPublishedDate(published: string): string {
  const d = new Date(published);
  return Number.isNaN(d.getTime()) ? published : d.toISOString().slice(0, 10);
}

/**
 * Parse Exa's CodeSearch result (consecutive `Title:/URL:/Published:/Author:/Highlights:` + snippet
 * blocks) into structured entries so each renders as a clickable source + a syntax-highlighted code
 * block, instead of being mangled by the prose-markdown renderer. Fail-soft: an unrecognized shape
 * yields no blocks and the template falls back to a plain code block.
 */
const codeSearchBlocks = computed<CodeSearchBlock[]>(() => {
  if (!isCodeSearch.value) return [];
  const text = props.tool.result ?? '';
  return text
    .split(/(?=^Title: )/m)
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block): CodeSearchBlock => {
      const lines = block.split('\n');
      const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim() ?? '';
      const url = block.match(/^URL:\s*(.+)$/m)?.[1]?.trim() ?? '';
      const author = block.match(/^Author:\s*(.+)$/m)?.[1]?.trim() ?? '';
      const published = block.match(/^Published:\s*(.+)$/m)?.[1]?.trim() ?? '';
      let i = 0;
      while (i < lines.length && /^(Title|URL|Published|Author|Highlights):/i.test(lines[i]!.trim())) i++;
      const code = lines.slice(i).join('\n').trim();
      const metaParts = [author, published ? formatPublishedDate(published) : ''].filter(Boolean);
      return { title: title || url, url, meta: metaParts.join(' · '), code, language: detectLanguageFromUrl(url) };
    })
    .filter((b) => b.url || b.code);
});

const webSearchQueries = computed(() => {
  const { query, queries } = props.tool.input;
  if (Array.isArray(queries)) return (queries as string[]).join('  ·  ');
  return typeof query === 'string' ? query : '';
});

const resultLineCount = computed(() => {
  const result = props.tool.result;
  if (!result) return 0;
  let count = 1;
  for (let i = 0; i < result.length; i++) {
    if (result[i] === '\n') count++;
  }
  return count;
});

const isResultTooLarge = computed(() => resultLineCount.value > SHIKI_LINE_LIMIT);

const responseLanguage = computed(() => {
  if (props.tool.name === 'Read' && props.tool.input.file_path) {
    const ext = (props.tool.input.file_path as string).split('.').pop()?.toLowerCase();
    return ownEntry(EXT_LANG_MAP, ext ?? '') ?? 'text';
  }
  return 'text';
});

const readMeta = computed(() => {
  if (props.tool.name !== 'Read') return null;
  const m = props.tool.metadata;
  if (!m) return null;
  const numLines = m.numLines as number | undefined;
  const startLine = m.startLine as number | undefined;
  const totalLines = m.totalLines as number | undefined;
  if (numLines == null || startLine == null || totalLines == null) return null;
  const endLine = startLine + numLines - 1;
  const percentage = totalLines > 0 ? Math.round((numLines / totalLines) * 100) : 100;
  const isPartial = numLines < totalLines;
  return { numLines, startLine, endLine, totalLines, percentage, isPartial };
});

const toolSearchMeta = computed(() => {
  if (props.tool.name !== 'ToolSearch') return null;
  const m = props.tool.metadata;
  if (!m) return null;
  const matches = m.matches as string[] | undefined;
  const totalDeferredTools = m.totalDeferredTools as number | undefined;
  if (!matches || totalDeferredTools == null) return null;
  const pendingMcpServers = m.pendingMcpServers as string[] | undefined;
  return { matches, totalDeferredTools, pendingMcpServers };
});

const cronCreateMeta = computed(() => {
  if (props.tool.name !== 'CronCreate') return null;
  const m = props.tool.metadata;
  if (!m) return null;
  const jobId = m.jobId as string | undefined;
  const humanSchedule = m.humanSchedule as string | undefined;
  const recurring = m.recurring as boolean | undefined;
  if (!jobId || !humanSchedule || recurring == null) return null;
  return { jobId, humanSchedule, recurring, durable: m.durable as boolean | undefined };
});

const cronListMeta = computed(() => {
  if (props.tool.name !== 'CronList') return null;
  const m = props.tool.metadata;
  if (!m) return null;
  const jobs = m.jobs as Array<{ id: string; cron: string; humanSchedule: string; prompt: string; recurring?: boolean; durable?: boolean }> | undefined;
  if (!Array.isArray(jobs)) return null;
  return { jobs };
});

const intervalLabel = computed(() => {
  if (props.tool.name !== 'CronCreate') return null;
  const cron = props.tool.input.cron;
  if (typeof cron !== 'string') return null;
  const label = cronToIntervalLabel(cron);
  return label !== cron ? label : null;
});

interface InputRow {
  key: string;
  label: string;
  value: string;
  kind: 'plain' | 'code' | 'file' | 'badge';
  tone?: string;
}

const shellCommand = computed(() => (isShellTool(props.tool.name) ? String(props.tool.input.command ?? '') : ''));

function present(value: unknown): value is string | number | boolean {
  return value !== undefined && value !== null && value !== '';
}

/** The tool's input as the reference's label/value grid; tools without a known shape list their raw fields. */
const inputRows = computed<InputRow[]>(() => {
  const input = props.tool.input;
  const rows: InputRow[] = [];
  const add = (key: string, label: string, value: unknown, kind: InputRow['kind'] = 'plain', tone?: string): void => {
    if (present(value)) rows.push({ key, label, value: String(value), kind, ...(tone ? { tone } : {}) });
  };
  switch (props.tool.name) {
    case 'Read':
      add('file', t('toolOverlay.filePath'), input.file_path, 'file');
      add('offset', t('toolOverlay.offset'), input.offset);
      add('limit', t('toolOverlay.limit'), input.limit);
      break;
    case 'Grep':
      add('pattern', t('toolOverlay.pattern'), input.pattern, 'code');
      add('path', t('toolOverlay.searchPath'), input.path);
      add('glob', t('toolOverlay.globFilter'), input.glob, 'code');
      add('mode', t('toolOverlay.outputMode'), input.output_mode);
      add('after', '-A', input['-A']);
      add('before', '-B', input['-B']);
      add('context', '-C', input['-C'] ?? input.context);
      break;
    case 'Glob':
      add('pattern', t('toolOverlay.pattern'), input.pattern, 'code');
      add('path', t('toolOverlay.searchPath'), input.path);
      break;
    case 'Ls':
      add('path', t('toolOverlay.searchPath'), (input.path as string | undefined) || '.');
      break;
    case 'WebFetch':
      add('url', t('toolOverlay.url'), webFetchTargets.value);
      add('prompt', t('toolOverlay.prompt'), input.prompt);
      break;
    case 'WebSearch':
      add('query', t('toolOverlay.query'), webSearchQueries.value, 'code');
      add('allowed', t('toolOverlay.allowedDomains'), (input.allowed_domains as string[] | undefined)?.join(', '));
      add('blocked', t('toolOverlay.blockedDomains'), (input.blocked_domains as string[] | undefined)?.join(', '));
      break;
    case 'CodeSearch':
      add('query', t('toolOverlay.query'), input.query, 'code');
      break;
    case 'FeedRead':
      add('url', t('toolOverlay.url'), input.url);
      add('limit', t('toolOverlay.limit'), input.limit);
      break;
    case 'YouTubeTranscript':
      add('url', t('toolOverlay.url'), input.url);
      add('lang', t('toolOverlay.language'), input.lang);
      break;
    case 'ToolSearch':
      add('tools', t('tools.title'), Array.isArray(input.tools) ? (input.tools as string[]).join(', ') : undefined, 'code');
      break;
    case 'CronCreate':
      add('cron', t('toolOverlay.cronInfo.cronExpression'), input.cron, 'code');
      add('prompt', t('toolOverlay.cronInfo.prompt'), input.prompt);
      add('kind', ' ', input.recurring !== false ? t('toolOverlay.cronInfo.recurring') : t('toolOverlay.cronInfo.oneShot'), 'badge', input.recurring !== false ? 'd-tone-accent' : 'd-tone-warning');
      if (input.durable) add('durable', ' ', t('toolOverlay.cronInfo.durable'), 'badge', 'd-tone-success');
      break;
    case 'CronDelete':
      add('id', t('toolOverlay.cronInfo.jobId'), input.id, 'code');
      break;
    case 'CronList':
      add('list', ' ', t('toolOverlay.cronInfo.listJobs'));
      break;
    default:
      if (isShellTool(props.tool.name)) {
        add('description', t('overlays.tool.description'), input.description);
        break;
      }
      for (const [key, value] of Object.entries(input)) {
        add(key, key, typeof value === 'string' ? value : JSON.stringify(value), typeof value === 'string' && key.endsWith('path') ? 'file' : typeof value === 'string' ? 'plain' : 'code');
      }
  }
  return rows;
});

/** A file the header's Open file action opens: the path a Read or an image tool named. */
const openableFile = computed(() => {
  const path = props.tool.input.file_path;
  return (props.tool.name === 'Read' || props.tool.name === TOOL_GENERATE_IMAGE) && typeof path === 'string' && path ? path : null;
});

const { hasCopied: copied, copyToClipboard: copy } = useCopyToClipboard();
const { hasCopied: commandCopied, copyToClipboard: copyCommand } = useCopyToClipboard();
const ids = useId();

function handleFilePathClick(filePath: string): void {
  const line = readMeta.value?.startLine ?? 1;
  postMessage({ type: 'openFile', filePath, line });
}
</script>

<template>
  <OverlayShell
    max-width="47.5rem"
    :title="tool.name"
    :subtitle="subtitle"
    :icon="toolIcon"
    :status-badge="statusBadge"
    @close="emit('close')"
  >
    <template #header-actions>
      <ToolCancelControl
        :tool-call="tool"
        :source="cancelSource"
      />
      <OverlayHeaderAction
        v-if="openableFile"
        :label="t('overlays.tool.openFile')"
        :title="openableFile"
        :icon="ExternalLink"
        @click="handleFilePathClick(openableFile)"
      />
    </template>

    <div class="flex flex-col gap-3 px-4.5 pt-3.5 pb-4.5 text-13">
      <section class="overflow-hidden rounded-10 border border-(--d-border) bg-(--d-card)">
        <button
          type="button"
          class="flex h-8.5 w-full items-center gap-2 px-3 text-left text-xs font-semibold text-(--d-muted) transition-colors hover:bg-(--d-hover)"
          :aria-expanded="isInputExpanded"
          :aria-controls="isInputExpanded ? `${ids}-input` : undefined"
          @click="isInputExpanded = !isInputExpanded"
        >
          <ChevronRight
            class="size-3.25 transition-transform duration-200"
            :class="isInputExpanded && 'rotate-90'"
            aria-hidden="true"
          />
          <CornerDownRight
            class="size-3 text-(--d-faint)"
            aria-hidden="true"
          />
          {{ t('toolOverlay.input') }}
        </button>
        <Transition name="t-fade">
          <div
            v-if="isInputExpanded"
            :id="`${ids}-input`"
          >
            <dl
              v-if="inputRows.length"
              class="grid grid-cols-[max-content_minmax(0,1fr)] items-baseline gap-x-4.5 gap-y-2 pt-0.5 pr-3.5 pb-3 pl-8.25 text-xs"
            >
              <template
                v-for="row in inputRows"
                :key="row.key"
              >
                <dt class="text-(--d-faint)">
                  {{ row.label }}
                </dt>
                <dd class="m-0 min-w-0">
                  <button
                    v-if="row.kind === 'file'"
                    type="button"
                    class="font-mono text-11.5 break-all text-(--d-accent) hover:underline"
                    :title="row.value"
                    @click="handleFilePathClick(row.value)"
                  >
                    {{ displayPath(row.value) }}
                  </button>
                  <code
                    v-else-if="row.kind === 'code'"
                    class="rounded-5 bg-(--d-hover) px-1.75 py-px font-mono text-11.5 break-all text-(--d-text)"
                  >{{ row.value }}</code>
                  <span
                    v-else-if="row.kind === 'badge'"
                    class="rounded-full bg-[color-mix(in_srgb,var(--tone,currentColor)_14%,transparent)] px-2 py-px text-11 font-medium"
                    :class="row.tone"
                  >{{ row.value }}</span>
                  <span
                    v-else
                    class="whitespace-pre-wrap wrap-break-word text-(--d-text) text-pretty"
                  >{{ row.value }}</span>
                </dd>
              </template>
            </dl>
            <p
              v-else-if="!shellCommand"
              class="pt-0.5 pr-3.5 pb-3 pl-8.25 text-xs text-(--d-faint) italic"
            >
              {{ t('toolOverlay.noInput') }}
            </p>
            <div
              v-if="shellCommand"
              class="mx-3 mb-3 ml-8.25 flex items-start gap-2 rounded-lg border border-(--d-border) bg-(--d-code) py-2.25 pr-1.5 pl-3"
            >
              <span
                class="min-w-0 flex-1 font-mono text-xs break-all whitespace-pre-wrap"
                data-testid="tool-overlay-command"
              ><span
                class="text-(--d-accent) select-none"
                aria-hidden="true"
              >{{ tool.name === 'PowerShell' ? 'PS> ' : '$ ' }}</span><span>{{ shellCommand }}</span></span>
              <button
                type="button"
                class="-my-1 flex flex-none rounded-md p-1.25 transition-colors hover:bg-(--d-border) hover:text-(--d-text)"
                :class="commandCopied ? 'text-(--d-success)' : 'text-(--d-faint)'"
                :title="commandCopied ? t('overlays.tool.copied') : t('overlays.tool.copyCommand')"
                :aria-label="commandCopied ? t('overlays.tool.copied') : t('overlays.tool.copyCommand')"
                data-testid="tool-overlay-copy-command"
                @click="copyCommand(shellCommand)"
              >
                <component
                  :is="commandCopied ? Check : Copy"
                  class="size-3"
                  aria-hidden="true"
                />
              </button>
            </div>
          </div>
        </Transition>
      </section>

      <div
        v-if="readMeta"
        class="flex items-center gap-3 rounded-10 border border-(--d-border) bg-(--d-card) px-3 py-2.5"
      >
        <span class="flex size-7 flex-none items-center justify-center rounded-lg bg-(--d-accent-soft) text-(--d-accent)">
          <FileText
            class="size-3.5"
            aria-hidden="true"
          />
        </span>
        <div class="flex min-w-0 flex-1 flex-col gap-1.5">
          <div class="flex items-baseline gap-2 text-xs">
            <span class="font-semibold">{{ readMeta.isPartial
              ? t('toolOverlay.readInfo.linesRange', { start: readMeta.startLine, end: readMeta.endLine })
              : t('toolOverlay.readInfo.allLines') }}</span>
            <span class="text-(--d-faint)">{{ t('toolOverlay.readInfo.ofTotal', { total: readMeta.totalLines }) }}</span>
            <span
              v-if="readMeta.isPartial"
              class="ms-auto font-mono text-11 text-(--d-faint)"
            >{{ readMeta.percentage }}%</span>
          </div>
          <div class="h-1 overflow-hidden rounded-full bg-(--d-hover)">
            <div
              class="d-bar h-full origin-left rounded-full bg-(--d-accent) opacity-75"
              :style="{ transform: `scaleX(${readMeta.percentage / 100})`, animation: 'none' }"
            />
          </div>
        </div>
      </div>

      <div
        v-if="toolSearchMeta"
        class="flex flex-col gap-2 rounded-10 border border-(--d-border) bg-(--d-card) px-3 py-2.5"
      >
        <div class="flex items-center gap-3 text-xs font-semibold">
          <span class="flex size-7 flex-none items-center justify-center rounded-lg bg-(--d-accent-soft) text-(--d-accent)">
            <Search
              class="size-3.5"
              aria-hidden="true"
            />
          </span>
          {{ t('toolOverlay.toolSearchInfo.matchCount', { count: toolSearchMeta.matches.length, total: toolSearchMeta.totalDeferredTools }) }}
        </div>
        <div
          v-if="toolSearchMeta.matches.length > 0"
          class="flex flex-wrap gap-1.5 pl-10"
        >
          <code
            v-for="name in toolSearchMeta.matches"
            :key="name"
            class="rounded-5 bg-(--d-accent-soft) px-1.5 py-px font-mono text-11.5 text-(--d-accent-text)"
          >{{ name }}</code>
        </div>
        <div
          v-if="toolSearchMeta.pendingMcpServers?.length"
          class="pl-10 text-xs"
        >
          <span class="text-(--d-faint)">{{ t('toolOverlay.toolSearchInfo.pendingServers') }}:</span>
          <span class="ml-1">{{ toolSearchMeta.pendingMcpServers.join(', ') }}</span>
        </div>
      </div>

      <div
        v-if="cronCreateMeta"
        class="flex flex-col gap-2 rounded-10 border border-(--d-border) bg-(--d-card) px-3 py-2.5 text-xs"
      >
        <div class="flex flex-wrap items-center gap-3">
          <span class="flex size-7 flex-none items-center justify-center rounded-lg bg-(--d-accent-soft) text-(--d-accent)">
            <Clock
              class="size-3.5"
              aria-hidden="true"
            />
          </span>
          <span class="font-semibold">{{ cronCreateMeta.humanSchedule }}</span>
          <span
            class="rounded-full bg-[color-mix(in_srgb,var(--tone,currentColor)_14%,transparent)] px-2 py-px text-11 font-medium"
            :class="cronCreateMeta.recurring ? 'd-tone-accent' : 'd-tone-warning'"
          >{{ cronCreateMeta.recurring ? t('toolOverlay.cronInfo.recurring') : t('toolOverlay.cronInfo.oneShot') }}</span>
          <span
            v-if="cronCreateMeta.durable"
            class="rounded-full bg-[color-mix(in_srgb,var(--tone,currentColor)_14%,transparent)] px-2 py-px text-11 font-medium d-tone-success"
          >{{ t('toolOverlay.cronInfo.durable') }}</span>
        </div>
        <div
          v-if="intervalLabel"
          class="flex items-center gap-1.5 pl-10"
        >
          <span class="text-(--d-faint)">{{ t('toolOverlay.cronInfo.interval') }}:</span>
          <span class="font-medium">{{ intervalLabel }}</span>
        </div>
        <div class="flex items-center gap-2 pl-10">
          <span class="text-(--d-faint)">{{ t('toolOverlay.cronInfo.jobId') }}:</span>
          <code class="rounded-5 bg-(--d-hover) px-1.5 py-px font-mono text-11.5">{{ cronCreateMeta.jobId }}</code>
        </div>
      </div>

      <div
        v-if="cronListMeta"
        class="flex flex-col gap-2 rounded-10 border border-(--d-border) bg-(--d-card) px-3 py-2.5 text-xs"
      >
        <div class="flex items-center gap-3 font-semibold">
          <span class="flex size-7 flex-none items-center justify-center rounded-lg bg-(--d-accent-soft) text-(--d-accent)">
            <Clock
              class="size-3.5"
              aria-hidden="true"
            />
          </span>
          {{ cronListMeta.jobs.length > 0 ? t('toolOverlay.cronInfo.jobCount', { count: cronListMeta.jobs.length }) : t('toolOverlay.cronInfo.noJobs') }}
        </div>
        <div
          v-if="cronListMeta.jobs.length > 0"
          class="flex flex-col gap-1.5 pl-10"
        >
          <div
            v-for="job in cronListMeta.jobs"
            :key="job.id"
            class="flex items-start gap-2 rounded-lg bg-(--d-hover) px-2 py-1.5"
          >
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="font-medium">{{ job.humanSchedule }}</span>
                <code class="font-mono text-11 text-(--d-faint)">{{ job.cron }}</code>
                <span
                  v-if="job.recurring"
                  class="rounded-full bg-(--d-accent-soft) px-1.5 text-10.5 text-(--d-accent-text)"
                >{{ t('toolOverlay.cronInfo.recurring') }}</span>
              </div>
              <p class="truncate text-(--d-muted)">
                {{ job.prompt }}
              </p>
            </div>
            <code class="flex-none font-mono text-11 text-(--d-faint)">{{ job.id }}</code>
          </div>
        </div>
      </div>

      <div
        v-if="showLiveOutput"
        class="flex flex-col gap-1.5"
      >
        <p class="flex items-center gap-1.5 text-10 tracking-[.06em] text-(--d-faint) uppercase">
          <span
            class="d-pulsing size-1.5 rounded-full bg-(--d-accent)"
            aria-hidden="true"
          />{{ t('toolOverlay.liveOutput') }}
        </p>
        <LiveOutputPane
          :output="liveOutputText"
          :truncated="tool.liveOutputTruncated === true"
          height-class="h-[45vh]"
        />
      </div>
      <div
        v-else-if="isRunning"
        class="flex items-center justify-center gap-2.25 py-6.5 text-12.5 text-(--d-muted)"
      >
        <LoaderCircle
          class="size-4 d-spinning text-(--d-accent)"
          aria-hidden="true"
        />{{ t('toolOverlay.running') }}
      </div>

      <div
        v-if="isFailed && tool.errorMessage"
        role="alert"
        class="flex items-start gap-2.25 rounded-10 border border-[color-mix(in_srgb,var(--d-danger)_35%,transparent)] bg-[color-mix(in_srgb,var(--d-danger)_8%,transparent)] px-3 py-2.25 text-(--d-danger-text)"
      >
        <CircleX
          class="size-3.5 mt-0.5 flex-none"
          aria-hidden="true"
        />
        <span class="font-mono text-xs wrap-break-word">{{ tool.errorMessage }}</span>
      </div>

      <section
        v-if="hasResult"
        class="overflow-hidden rounded-10 border border-(--d-border) bg-(--d-card)"
      >
        <div class="flex h-8.5 items-center gap-2 pr-2 pl-3">
          <button
            type="button"
            class="flex min-w-0 flex-1 items-center gap-2 self-stretch text-left text-xs font-semibold text-(--d-muted)"
            :aria-expanded="isResponseExpanded"
            :aria-controls="isResponseExpanded ? `${ids}-output` : undefined"
            @click="isResponseExpanded = !isResponseExpanded"
          >
            <ChevronRight
              class="size-3.25 flex-none transition-transform duration-200"
              :class="isResponseExpanded && 'rotate-90'"
              aria-hidden="true"
            />
            <component
              :is="isFailed ? CircleX : CircleCheck"
              class="size-3 flex-none"
              :class="isFailed ? 'text-(--d-danger)' : 'text-(--d-success)'"
              aria-hidden="true"
            />
            {{ t('toolOverlay.response') }}
            <span
              v-if="resultLineCount > 0"
              class="min-w-0 truncate font-mono text-11 font-normal text-(--d-faint)"
            >{{ t('overlays.tool.lines', { n: resultLineCount }, resultLineCount) }}</span>
          </button>
          <button
            v-if="tool.result?.trim()"
            type="button"
            class="flex flex-none rounded-md p-1.25 transition-colors hover:bg-(--d-border) hover:text-(--d-text)"
            :class="copied ? 'text-(--d-success)' : 'text-(--d-faint)'"
            :title="copied ? t('overlays.tool.copied') : t('overlays.tool.copy')"
            :aria-label="copied ? t('overlays.tool.copied') : t('overlays.tool.copy')"
            @click="copy(tool.result ?? '')"
          >
            <component
              :is="copied ? Check : Copy"
              class="size-3"
              aria-hidden="true"
            />
          </button>
        </div>
        <Transition name="t-fade">
          <div
            v-if="isResponseExpanded"
            :id="`${ids}-output`"
            class="flex flex-col gap-3 border-t border-(--d-border) bg-(--d-code)"
          >
            <template v-if="tool.result?.trim()">
              <MarkdownRenderer
                v-if="useMarkdownResponse"
                class="px-3.5 py-2.5"
                :content="tool.result ?? ''"
                :base-url="webFetchBaseUrl"
              />
              <template v-else-if="isCodeSearch">
                <div
                  v-if="codeSearchBlocks.length"
                  class="flex flex-col gap-4 px-3.5 py-2.5"
                >
                  <div
                    v-for="(block, i) in codeSearchBlocks"
                    :key="i"
                    class="flex flex-col gap-1.5"
                  >
                    <a
                      v-if="block.url"
                      :href="sanitizeUrl(block.url)"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="text-xs font-medium break-all text-(--d-accent) hover:underline"
                    >{{ block.title }}</a>
                    <div
                      v-else
                      class="text-xs font-medium break-all"
                    >
                      {{ block.title }}
                    </div>
                    <div
                      v-if="block.meta"
                      class="text-11 text-(--d-faint)"
                    >
                      {{ block.meta }}
                    </div>
                    <CodeBlock
                      :code="block.code"
                      :language="block.language"
                    />
                  </div>
                </div>
                <CodeBlock
                  v-else
                  :code="tool.result ?? ''"
                  language="text"
                />
              </template>
              <template v-else-if="isResultTooLarge">
                <p class="px-3.5 pt-2.5 text-xs text-(--d-faint)">
                  {{ t('toolOverlay.largeOutput', { lines: resultLineCount }) }}
                </p>
                <div class="max-h-[46vh] overflow-auto px-3.5 pb-2.5 font-mono text-11.5 leading-[1.7] break-all whitespace-pre-wrap">
                  <span>{{ tool.result }}</span>
                </div>
              </template>
              <div
                v-else-if="responseLanguage === 'text'"
                class="max-h-[46vh] overflow-auto px-3.5 py-2.5 font-mono text-11.5 leading-[1.7] whitespace-pre"
                data-testid="tool-overlay-output-text"
              >
                <span>{{ tool.result }}</span>
              </div>
              <CodeBlock
                v-else
                bare
                :code="tool.result ?? ''"
                :language="responseLanguage"
              />
            </template>
            <ToolResultImages
              :tool="tool"
              :owner="owner"
              @open="lightboxImageUrl = $event"
            />
          </div>
        </Transition>
      </section>

      <p
        v-else-if="!isFailed && !isRunning"
        class="py-6.5 text-center text-12.5 text-(--d-muted)"
      >
        {{ isUnrecorded ? t('toolOverlay.outcomeUnrecorded') : t('toolOverlay.noResponse') }}
      </p>
    </div>

    <ImageLightbox
      :open="lightboxImageUrl !== null"
      :image-url="lightboxImageUrl ?? ''"
      @close="lightboxImageUrl = null"
    />
  </OverlayShell>
</template>
