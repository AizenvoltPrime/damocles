<script setup lang="ts">
import { ref, computed, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ToolCall } from '@shared/types/session';
import { TOOL_MONITOR, isShellTool } from '@shared/tool-names';
import { cronToIntervalLabel } from '@shared/utils/cron';
import { useMonitorStore } from '@/stores/useMonitorStore';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import {
  IconCheck,
  IconXCircle,
  IconWarning,
  IconChevronDown,
  IconFile,
  IconFileText,
  IconTerminal,
  IconSearch,
  IconGlobe,
  IconClock,
  IconCode,
} from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import CodeBlock from './CodeBlock.vue';
import OverlayShell from './OverlayShell.vue';
import { useVSCode } from '@/composables/useVSCode';
import { sanitizeUrl } from '@/lib/sanitize-url';

const TOOL_ICON_MAP: Record<string, Component> = {
  Bash: IconTerminal,
  PowerShell: IconTerminal,
  Read: IconFile,
  Grep: IconSearch,
  Glob: IconSearch,
  WebFetch: IconGlobe,
  WebSearch: IconSearch,
  CodeSearch: IconCode,
  FeedRead: IconGlobe,
  YouTubeTranscript: IconFileText,
  ToolSearch: IconSearch,
  CronCreate: IconClock,
  CronDelete: IconClock,
  CronList: IconClock,
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
const { postMessage } = useVSCode();
const monitorStore = useMonitorStore();

const props = defineProps<{
  tool: ToolCall;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const isInputExpanded = ref(true);
const isResponseExpanded = ref(true);

const toolIcon = computed((): Component => {
  return TOOL_ICON_MAP[props.tool.name] || IconSearch;
});

const subtitle = computed(() => {
  const input = props.tool.input;
  if (isShellTool(props.tool.name) && input.description) return input.description as string;
  if (props.tool.name === 'Read' && input.file_path) return input.file_path as string;
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
  return t('toolOverlay.builtInTool');
});

const effectiveStatus = computed(() => {
  if (props.tool.name === TOOL_MONITOR) {
    const monitor = monitorStore.getByToolUseId(props.tool.id);
    if (monitor) return monitor.status;
  }
  return props.tool.status;
});

const isRunning = computed(() => {
  const s = effectiveStatus.value;
  return s === 'running' || s === 'pending' || s === 'starting' || s === 'monitoring';
});
const isFailed = computed(() => effectiveStatus.value === 'failed');
const isCompleted = computed(() => effectiveStatus.value === 'completed');

const statusBadge = computed(() => {
  const s = effectiveStatus.value;
  if (s === 'starting') {
    return { label: t('monitor.starting'), class: 'bg-primary/30 text-primary border-primary/30', showSpinner: true };
  }
  if (s === 'monitoring') {
    return { label: t('monitor.monitoring'), class: 'bg-primary/30 text-primary border-primary/30', showSpinner: true };
  }
  if (s === 'stopped') {
    return { label: t('monitor.stopped'), class: 'bg-warning/30 text-warning border-warning/30', icon: IconWarning };
  }
  if (isRunning.value) {
    return { label: t('toolOverlay.statusRunning'), class: 'bg-primary/30 text-primary border-primary/30', showSpinner: true };
  }
  if (isCompleted.value) {
    return { label: t('toolOverlay.statusCompleted'), class: 'bg-success/30 text-success border-success/30', icon: IconCheck };
  }
  if (isFailed.value) {
    return { label: t('toolOverlay.statusFailed'), class: 'bg-error/30 text-error border-error/30', icon: IconXCircle };
  }
  return { label: props.tool.status, class: 'bg-muted text-muted-foreground border-muted', icon: IconWarning };
});

const hasResult = computed(() => Boolean(props.tool.result?.trim()));

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
    return EXT_LANG_MAP[ext] ?? 'text';
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
    return EXT_LANG_MAP[ext ?? ''] || 'text';
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

function handleFilePathClick(filePath: string): void {
  const line = readMeta.value?.startLine ?? 1;
  postMessage({ type: 'openFile', filePath, line });
}
</script>

<template>
  <OverlayShell
    :title="tool.name"
    :subtitle="subtitle"
    :icon="toolIcon"
    :status-badge="statusBadge"
    @close="emit('close')"
  >
    <div class="p-4 space-y-4">
      <!-- Running state -->
      <div v-if="isRunning" class="text-center text-muted-foreground text-sm py-8">
        <LoadingSpinner :size="24" class="mx-auto mb-2" />
        <p>{{ t('toolOverlay.running') }}</p>
      </div>

      <!-- Error state -->
      <div v-else-if="isFailed && tool.errorMessage" class="text-error">
        <div class="flex items-center gap-2 mb-2 text-xs font-medium">
          <IconXCircle :size="14" />
          <span>{{ t('common.error') }}</span>
        </div>
        <div class="pl-2 font-mono text-sm">{{ tool.errorMessage }}</div>
      </div>

      <!-- Normal state -->
      <template v-else>
        <!-- Input Section -->
        <Collapsible v-model:open="isInputExpanded">
          <CollapsibleTrigger
            class="group flex items-center gap-2 py-1.5 px-2 -mx-2 rounded-md transition-colors cursor-pointer hover:bg-muted/50 w-full"
          >
            <IconChevronDown
              :size="14"
              class="text-muted-foreground transition-transform duration-200"
              :class="{ '-rotate-90': !isInputExpanded }"
            />
            <span class="text-xs font-medium text-muted-foreground">{{ t('toolOverlay.input') }}</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div class="mt-2 space-y-2">
              <!-- Bash / PowerShell -->
              <template v-if="isShellTool(tool.name)">
                <div v-if="tool.input.description" class="text-xs text-muted-foreground italic pl-2">
                  {{ tool.input.description }}
                </div>
                <CodeBlock :code="(tool.input.command as string) || ''" :language="tool.name === 'PowerShell' ? 'powershell' : 'bash'" />
              </template>

              <!-- Read -->
              <template v-else-if="tool.name === 'Read'">
                <div v-if="tool.input.file_path" class="flex items-center gap-2 pl-2">
                  <span class="text-xs text-muted-foreground font-medium">{{ t('toolOverlay.filePath') }}</span>
                  <span
                    class="text-xs font-mono text-primary cursor-pointer hover:underline"
                    @click="handleFilePathClick(tool.input.file_path as string)"
                  >{{ tool.input.file_path }}</span>
                </div>
                <div v-if="tool.input.offset != null || tool.input.limit != null" class="flex items-center gap-4 pl-2 text-xs text-muted-foreground">
                  <span v-if="tool.input.offset != null">{{ t('toolOverlay.offset') }}: {{ tool.input.offset }}</span>
                  <span v-if="tool.input.limit != null">{{ t('toolOverlay.limit') }}: {{ tool.input.limit }}</span>
                </div>
              </template>

              <!-- Grep -->
              <template v-else-if="tool.name === 'Grep'">
                <div class="flex items-center gap-2 pl-2">
                  <span class="text-xs text-muted-foreground font-medium">{{ t('toolOverlay.pattern') }}</span>
                  <code class="text-xs font-mono text-foreground bg-muted px-1.5 py-0.5 rounded">{{ tool.input.pattern }}</code>
                </div>
                <div v-if="tool.input.path" class="flex items-center gap-2 pl-2">
                  <span class="text-xs text-muted-foreground font-medium">{{ t('toolOverlay.searchPath') }}</span>
                  <span class="text-xs font-mono text-foreground/70">{{ tool.input.path }}</span>
                </div>
                <div v-if="tool.input.glob" class="flex items-center gap-2 pl-2">
                  <span class="text-xs text-muted-foreground font-medium">{{ t('toolOverlay.globFilter') }}</span>
                  <code class="text-xs font-mono text-foreground/70">{{ tool.input.glob }}</code>
                </div>
                <div v-if="tool.input.output_mode" class="flex items-center gap-2 pl-2">
                  <span class="text-xs text-muted-foreground font-medium">{{ t('toolOverlay.outputMode') }}</span>
                  <span class="text-xs text-foreground/70">{{ tool.input.output_mode }}</span>
                </div>
                <div v-if="tool.input['-A'] != null || tool.input['-B'] != null || tool.input['-C'] != null || tool.input.context != null" class="flex items-center gap-4 pl-2 text-xs text-muted-foreground">
                  <span v-if="tool.input['-A'] != null">-A {{ tool.input['-A'] }}</span>
                  <span v-if="tool.input['-B'] != null">-B {{ tool.input['-B'] }}</span>
                  <span v-if="tool.input['-C'] != null || tool.input.context != null">-C {{ tool.input['-C'] ?? tool.input.context }}</span>
                </div>
              </template>

              <!-- Glob -->
              <template v-else-if="tool.name === 'Glob'">
                <div class="flex items-center gap-2 pl-2">
                  <span class="text-xs text-muted-foreground font-medium">{{ t('toolOverlay.pattern') }}</span>
                  <code class="text-xs font-mono text-foreground bg-muted px-1.5 py-0.5 rounded">{{ tool.input.pattern }}</code>
                </div>
                <div v-if="tool.input.path" class="flex items-center gap-2 pl-2">
                  <span class="text-xs text-muted-foreground font-medium">{{ t('toolOverlay.searchPath') }}</span>
                  <span class="text-xs font-mono text-foreground/70">{{ tool.input.path }}</span>
                </div>
              </template>

              <!-- Ls -->
              <template v-else-if="tool.name === 'Ls'">
                <div class="flex items-center gap-2 pl-2">
                  <span class="text-xs text-muted-foreground font-medium">{{ t('toolOverlay.searchPath') }}</span>
                  <span class="text-xs font-mono text-foreground/70">{{ (tool.input.path as string) || '.' }}</span>
                </div>
              </template>

              <!-- WebFetch -->
              <template v-else-if="tool.name === 'WebFetch'">
                <div class="flex items-center gap-2 pl-2">
                  <span class="text-xs text-muted-foreground font-medium">{{ t('toolOverlay.url') }}</span>
                  <span class="text-xs font-mono text-foreground/70 break-all">{{ webFetchTargets }}</span>
                </div>
                <div v-if="tool.input.prompt" class="pl-2">
                  <span class="text-xs text-muted-foreground font-medium">{{ t('toolOverlay.prompt') }}</span>
                  <p class="text-xs text-foreground/70 italic mt-1">{{ tool.input.prompt }}</p>
                </div>
              </template>

              <!-- WebSearch -->
              <template v-else-if="tool.name === 'WebSearch'">
                <div class="flex items-start gap-2 pl-2">
                  <span class="text-xs text-muted-foreground font-medium shrink-0">{{ t('toolOverlay.query') }}</span>
                  <code class="text-xs font-mono text-foreground bg-muted px-1.5 py-0.5 rounded break-words">{{ webSearchQueries }}</code>
                </div>
                <div v-if="(tool.input.allowed_domains as string[] | undefined)?.length" class="pl-2">
                  <span class="text-xs text-muted-foreground font-medium">{{ t('toolOverlay.allowedDomains') }}</span>
                  <span class="text-xs text-foreground/70 ml-1">{{ (tool.input.allowed_domains as string[]).join(', ') }}</span>
                </div>
                <div v-if="(tool.input.blocked_domains as string[] | undefined)?.length" class="pl-2">
                  <span class="text-xs text-muted-foreground font-medium">{{ t('toolOverlay.blockedDomains') }}</span>
                  <span class="text-xs text-foreground/70 ml-1">{{ (tool.input.blocked_domains as string[]).join(', ') }}</span>
                </div>
              </template>

              <!-- CodeSearch -->
              <template v-else-if="tool.name === 'CodeSearch'">
                <div class="flex items-start gap-2 pl-2">
                  <span class="text-xs text-muted-foreground font-medium shrink-0">{{ t('toolOverlay.query') }}</span>
                  <code class="text-xs font-mono text-foreground bg-muted px-1.5 py-0.5 rounded break-words">{{ tool.input.query }}</code>
                </div>
              </template>

              <!-- FeedRead -->
              <template v-else-if="tool.name === 'FeedRead'">
                <div class="flex items-center gap-2 pl-2">
                  <span class="text-xs text-muted-foreground font-medium">{{ t('toolOverlay.url') }}</span>
                  <span class="text-xs font-mono text-foreground/70 break-all">{{ tool.input.url }}</span>
                </div>
                <div v-if="tool.input.limit != null" class="flex items-center gap-2 pl-2">
                  <span class="text-xs text-muted-foreground font-medium">{{ t('toolOverlay.limit') }}</span>
                  <span class="text-xs text-foreground/70">{{ tool.input.limit }}</span>
                </div>
              </template>

              <!-- YouTubeTranscript -->
              <template v-else-if="tool.name === 'YouTubeTranscript'">
                <div class="flex items-center gap-2 pl-2">
                  <span class="text-xs text-muted-foreground font-medium">{{ t('toolOverlay.url') }}</span>
                  <span class="text-xs font-mono text-foreground/70 break-all">{{ tool.input.url }}</span>
                </div>
                <div v-if="tool.input.lang" class="flex items-center gap-2 pl-2">
                  <span class="text-xs text-muted-foreground font-medium">{{ t('toolOverlay.language') }}</span>
                  <span class="text-xs text-foreground/70">{{ tool.input.lang }}</span>
                </div>
              </template>

              <!-- ToolSearch -->
              <template v-else-if="tool.name === 'ToolSearch' && Array.isArray(tool.input.tools)">
                <div class="flex items-start gap-2 pl-2">
                  <span class="text-xs text-muted-foreground font-medium shrink-0">{{ t('tools.title') }}</span>
                  <code class="text-xs font-mono text-foreground bg-muted px-1.5 py-0.5 rounded break-words">{{ (tool.input.tools as string[]).join(', ') }}</code>
                </div>
              </template>

              <!-- CronCreate -->
              <template v-else-if="tool.name === 'CronCreate'">
                <div class="flex items-center gap-2 pl-2">
                  <span class="text-xs text-muted-foreground font-medium">{{ t('toolOverlay.cronInfo.cronExpression') }}</span>
                  <code class="text-xs font-mono text-foreground bg-muted px-1.5 py-0.5 rounded">{{ tool.input.cron }}</code>
                </div>
                <div v-if="tool.input.prompt" class="pl-2">
                  <span class="text-xs text-muted-foreground font-medium">{{ t('toolOverlay.cronInfo.prompt') }}</span>
                  <p class="text-xs text-foreground/70 mt-1 whitespace-pre-wrap">{{ tool.input.prompt }}</p>
                </div>
                <div class="flex items-center gap-3 pl-2">
                  <code class="text-xs px-1.5 py-0.5 rounded" :class="tool.input.recurring !== false ? 'bg-primary/15 text-primary' : 'bg-amber-500/15 text-amber-400'">
                    {{ tool.input.recurring !== false ? t('toolOverlay.cronInfo.recurring') : t('toolOverlay.cronInfo.oneShot') }}
                  </code>
                  <code v-if="tool.input.durable" class="text-xs px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400">
                    {{ t('toolOverlay.cronInfo.durable') }}
                  </code>
                </div>
              </template>

              <!-- CronDelete -->
              <template v-else-if="tool.name === 'CronDelete'">
                <div class="flex items-center gap-2 pl-2">
                  <span class="text-xs text-muted-foreground font-medium">{{ t('toolOverlay.cronInfo.jobId') }}</span>
                  <code class="text-xs font-mono text-foreground bg-muted px-1.5 py-0.5 rounded">{{ tool.input.id }}</code>
                </div>
              </template>

              <!-- CronList -->
              <template v-else-if="tool.name === 'CronList'">
                <div class="text-xs text-muted-foreground italic pl-2">{{ t('toolOverlay.cronInfo.listJobs') }}</div>
              </template>

              <!-- Monitor -->
              <template v-else-if="tool.name === 'Monitor'">
                <div v-if="tool.input.description" class="text-xs text-muted-foreground italic pl-2">
                  {{ tool.input.description }}
                </div>
                <CodeBlock :code="(tool.input.command as string) || ''" language="bash" />
                <div class="flex items-center gap-4 pl-2 text-xs text-muted-foreground">
                  <span v-if="tool.input.persistent">{{ t('monitor.persistent') }}</span>
                  <span v-else-if="tool.input.timeout_ms != null">{{ t('monitor.timeout') }}: {{ tool.input.timeout_ms }}ms</span>
                </div>
              </template>

              <!-- Fallback -->
              <div v-else class="text-sm text-muted-foreground italic pl-2">
                {{ t('toolOverlay.noInput') }}
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>

        <!-- Read File Info Card -->
        <div v-if="readMeta" class="rounded-lg border border-border/40 bg-gradient-to-r from-muted/40 to-muted/20 overflow-hidden">
          <div class="flex items-center gap-3 px-3 py-2.5">
            <div class="flex items-center justify-center w-7 h-7 rounded-md bg-primary/10">
              <IconFileText :size="14" class="text-primary" />
            </div>

            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-3 text-xs">
                <span class="text-foreground font-medium">
                  {{ readMeta.isPartial
                    ? t('toolOverlay.readInfo.linesRange', { start: readMeta.startLine, end: readMeta.endLine })
                    : t('toolOverlay.readInfo.allLines')
                  }}
                </span>
                <span class="text-muted-foreground">
                  {{ t('toolOverlay.readInfo.ofTotal', { total: readMeta.totalLines }) }}
                </span>
              </div>

              <div v-if="readMeta.isPartial" class="mt-1.5 flex items-center gap-2">
                <div class="flex-1 h-1 rounded-full bg-muted overflow-hidden">
                  <div
                    class="h-full rounded-full bg-primary/60 transition-all duration-300"
                    :style="{ width: readMeta.percentage + '%' }"
                  />
                </div>
                <span class="text-xs tabular-nums text-muted-foreground font-medium shrink-0">{{ readMeta.percentage }}%</span>
              </div>
            </div>
          </div>
        </div>

        <!-- ToolSearch Info Card -->
        <div v-if="toolSearchMeta" class="rounded-lg border border-border/40 bg-gradient-to-r from-muted/40 to-muted/20 overflow-hidden">
          <div class="px-3 py-2.5 space-y-2">
            <div class="flex items-center gap-3">
              <div class="flex items-center justify-center w-7 h-7 rounded-md bg-primary/10">
                <IconSearch :size="14" class="text-primary" />
              </div>
              <span class="text-xs text-foreground font-medium">
                {{ t('toolOverlay.toolSearchInfo.matchCount', { count: toolSearchMeta.matches.length, total: toolSearchMeta.totalDeferredTools }) }}
              </span>
            </div>

            <div v-if="toolSearchMeta.matches.length > 0" class="flex flex-wrap gap-1.5 pl-10">
              <code
                v-for="name in toolSearchMeta.matches"
                :key="name"
                class="text-xs font-mono text-primary/80 bg-primary/10 px-1.5 py-0.5 rounded"
              >{{ name }}</code>
            </div>

            <div v-if="toolSearchMeta.pendingMcpServers?.length" class="pl-10">
              <span class="text-xs text-muted-foreground font-medium">{{ t('toolOverlay.toolSearchInfo.pendingServers') }}:</span>
              <span class="text-xs text-foreground/70 ml-1">{{ toolSearchMeta.pendingMcpServers.join(', ') }}</span>
            </div>
          </div>
        </div>

        <!-- CronCreate Info Card -->
        <div v-if="cronCreateMeta" class="rounded-lg border border-border/40 bg-gradient-to-r from-muted/40 to-muted/20 overflow-hidden">
          <div class="px-3 py-2.5 space-y-3">
            <div class="flex items-center gap-3">
              <div class="flex items-center justify-center w-7 h-7 rounded-md bg-primary/10">
                <IconClock :size="14" class="text-primary" />
              </div>
              <span class="text-xs text-foreground font-medium">{{ cronCreateMeta.humanSchedule }}</span>
              <code class="text-xs px-1.5 py-0.5 rounded" :class="cronCreateMeta.recurring ? 'bg-primary/15 text-primary' : 'bg-amber-500/15 text-amber-400'">
                {{ cronCreateMeta.recurring ? t('toolOverlay.cronInfo.recurring') : t('toolOverlay.cronInfo.oneShot') }}
              </code>
              <code v-if="cronCreateMeta.durable" class="text-xs px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400">
                {{ t('toolOverlay.cronInfo.durable') }}
              </code>
            </div>

            <!-- Interval label -->
            <div v-if="intervalLabel" class="pl-10 flex items-center gap-1.5 text-xs">
              <span class="text-muted-foreground">{{ t('toolOverlay.cronInfo.interval') }}:</span>
              <span class="font-medium text-foreground">{{ intervalLabel }}</span>
            </div>

            <div class="flex items-center gap-2 pl-10 text-xs">
              <span class="text-muted-foreground">{{ t('toolOverlay.cronInfo.jobId') }}:</span>
              <code class="font-mono text-foreground/70 bg-muted px-1.5 py-0.5 rounded">{{ cronCreateMeta.jobId }}</code>
            </div>
          </div>
        </div>

        <!-- CronList Info Card -->
        <div v-if="cronListMeta" class="rounded-lg border border-border/40 bg-gradient-to-r from-muted/40 to-muted/20 overflow-hidden">
          <div class="px-3 py-2.5 space-y-2">
            <div class="flex items-center gap-3">
              <div class="flex items-center justify-center w-7 h-7 rounded-md bg-primary/10">
                <IconClock :size="14" class="text-primary" />
              </div>
              <span class="text-xs text-foreground font-medium">
                {{ cronListMeta.jobs.length > 0
                  ? t('toolOverlay.cronInfo.jobCount', { count: cronListMeta.jobs.length })
                  : t('toolOverlay.cronInfo.noJobs')
                }}
              </span>
            </div>

            <div v-if="cronListMeta.jobs.length > 0" class="space-y-1.5 pl-10">
              <div
                v-for="job in cronListMeta.jobs"
                :key="job.id"
                class="flex items-start gap-2 rounded-md bg-muted/30 px-2 py-1.5"
              >
                <div class="flex-1 min-w-0 space-y-0.5">
                  <div class="flex items-center gap-2">
                    <span class="text-xs text-foreground font-medium">{{ job.humanSchedule }}</span>
                    <code class="text-xs font-mono text-muted-foreground">{{ job.cron }}</code>
                    <code v-if="job.recurring" class="text-xs px-1 py-0.5 rounded bg-primary/15 text-primary">
                      {{ t('toolOverlay.cronInfo.recurring') }}
                    </code>
                  </div>
                  <p class="text-xs text-foreground/60 truncate">{{ job.prompt }}</p>
                </div>
                <code class="text-xs font-mono text-muted-foreground shrink-0">{{ job.id }}</code>
              </div>
            </div>
          </div>
        </div>

        <!-- Response Section -->
        <Collapsible v-if="hasResult" v-model:open="isResponseExpanded">
          <CollapsibleTrigger
            class="group flex items-center gap-2 py-1.5 px-2 -mx-2 rounded-md transition-colors cursor-pointer hover:bg-muted/50 w-full"
          >
            <IconChevronDown
              :size="14"
              class="text-primary transition-transform duration-200"
              :class="{ '-rotate-90': !isResponseExpanded }"
            />
            <span class="text-xs font-medium text-primary">{{ t('toolOverlay.response') }}</span>
            <IconCheck :size="14" class="text-primary" />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div class="mt-2">
              <div v-if="useMarkdownResponse" class="pl-2">
                <MarkdownRenderer :content="tool.result ?? ''" :base-url="webFetchBaseUrl" />
              </div>
              <template v-else-if="isCodeSearch">
                <div v-if="codeSearchBlocks.length" class="space-y-4">
                  <div v-for="(block, i) in codeSearchBlocks" :key="i" class="space-y-1.5">
                    <a
                      v-if="block.url"
                      :href="sanitizeUrl(block.url)"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="text-xs font-medium text-primary hover:underline break-all"
                    >{{ block.title }}</a>
                    <div v-else class="text-xs font-medium text-foreground break-all">{{ block.title }}</div>
                    <div v-if="block.meta" class="text-[11px] text-muted-foreground">{{ block.meta }}</div>
                    <CodeBlock :code="block.code" :language="block.language" />
                  </div>
                </div>
                <CodeBlock v-else :code="tool.result ?? ''" language="text" />
              </template>
              <template v-else-if="isResultTooLarge">
                <div class="text-xs text-muted-foreground mb-1">
                  {{ t('toolOverlay.largeOutput', { lines: resultLineCount }) }}
                </div>
                <pre class="text-xs font-mono whitespace-pre-wrap break-all bg-muted/30 rounded-md p-3 max-h-[60vh] overflow-auto">{{ tool.result }}</pre>
              </template>
              <CodeBlock v-else :code="tool.result ?? ''" :language="responseLanguage" />
            </div>
          </CollapsibleContent>
        </Collapsible>

        <!-- No Response State -->
        <div v-else-if="!isFailed" class="text-center text-muted-foreground text-sm py-8">
          <p>{{ t('toolOverlay.noResponse') }}</p>
        </div>
      </template>
    </div>
  </OverlayShell>
</template>
