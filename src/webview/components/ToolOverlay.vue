<script setup lang="ts">
import { ref, computed, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ToolCall } from '@shared/types/session';
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
} from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import CodeBlock from './CodeBlock.vue';
import OverlayShell from './OverlayShell.vue';
import { useVSCode } from '@/composables/useVSCode';

const TOOL_ICON_MAP: Record<string, Component> = {
  Bash: IconTerminal,
  Read: IconFile,
  Grep: IconSearch,
  Glob: IconSearch,
  WebFetch: IconGlobe,
  WebSearch: IconSearch,
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
  if (props.tool.name === 'Bash' && input.description) return input.description as string;
  if (props.tool.name === 'Read' && input.file_path) return input.file_path as string;
  if (props.tool.name === 'Grep' && input.pattern) return `/${input.pattern as string}/`;
  if (props.tool.name === 'Glob' && input.pattern) return input.pattern as string;
  if (props.tool.name === 'WebFetch' && input.url) return input.url as string;
  if (props.tool.name === 'WebSearch' && input.query) return input.query as string;
  return t('toolOverlay.builtInTool');
});

const isRunning = computed(() =>
  props.tool.status === 'running' || props.tool.status === 'pending'
);
const isFailed = computed(() => props.tool.status === 'failed');
const isCompleted = computed(() => props.tool.status === 'completed');

const statusBadge = computed(() => {
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
  props.tool.name === 'WebFetch' || props.tool.name === 'WebSearch'
);

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
            <!-- Bash -->
            <template v-if="tool.name === 'Bash'">
              <div v-if="tool.input.description" class="text-xs text-muted-foreground italic pl-2">
                {{ tool.input.description }}
              </div>
              <CodeBlock :code="(tool.input.command as string) || ''" language="bash" />
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

            <!-- WebFetch -->
            <template v-else-if="tool.name === 'WebFetch'">
              <div class="flex items-center gap-2 pl-2">
                <span class="text-xs text-muted-foreground font-medium">{{ t('toolOverlay.url') }}</span>
                <span class="text-xs font-mono text-foreground/70 break-all">{{ tool.input.url }}</span>
              </div>
              <div v-if="tool.input.prompt" class="pl-2">
                <span class="text-xs text-muted-foreground font-medium">{{ t('toolOverlay.prompt') }}</span>
                <p class="text-xs text-foreground/70 italic mt-1">{{ tool.input.prompt }}</p>
              </div>
            </template>

            <!-- WebSearch -->
            <template v-else-if="tool.name === 'WebSearch'">
              <div class="flex items-center gap-2 pl-2">
                <span class="text-xs text-muted-foreground font-medium">{{ t('toolOverlay.query') }}</span>
                <code class="text-xs font-mono text-foreground bg-muted px-1.5 py-0.5 rounded">{{ tool.input.query }}</code>
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
              <span class="text-[10px] tabular-nums text-muted-foreground font-medium shrink-0">{{ readMeta.percentage }}%</span>
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
              <MarkdownRenderer :content="tool.result ?? ''" />
            </div>
            <template v-else-if="isResultTooLarge">
              <div class="text-[10px] text-muted-foreground mb-1">
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
  </OverlayShell>
</template>
