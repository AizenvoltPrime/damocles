<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { getLanguageFromPath, type DiffLine, type FileDiff } from '@/utils/parseUnifiedDiff';
import { highlightDiffLines, type HighlightedDiffLine } from '@/utils/highlightDiff';
import { codeHighlightTheme, useCodeHighlighter } from '@/composables/code-highlighter';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { escapeHtml } from '@shared/utils';

const { t } = useI18n();
const settingsStore = useSettingsStore();
const highlighter = useCodeHighlighter();

const props = withDefaults(
  defineProps<{
    diff: FileDiff;
    fileName: string;
    maxHeight?: string;
  }>(),
  {
    maxHeight: '25rem',
  }
);

const highlightedLines = ref<HighlightedDiffLine[]>([]);
const isMounted = ref(true);
// Counts highlight runs: only the latest one writes, so a slower earlier run never lands last.
let highlightRun = 0;

const language = computed(() => getLanguageFromPath(props.fileName));
// The sign and code columns, plus both line number columns when the lines have real numbers.
const columnCount = computed(() => (props.diff.numbered ? 4 : 2));

async function highlightLines() {
  if (!isMounted.value) return;
  const run = ++highlightRun;

  const lines = props.diff.lines;
  try {
    const result = await highlightDiffLines(lines, language.value, codeHighlightTheme(settingsStore.hostCapabilities.damoclesTheme), highlighter);
    if (isMounted.value && run === highlightRun) {
      highlightedLines.value = result;
    }
  } catch {
    if (isMounted.value && run === highlightRun) {
      highlightedLines.value = lines.map((l) => ({
        ...l,
        highlightedContent: escapeHtml(l.content),
      }));
    }
  }
}

function getLineTypeClass(type: DiffLine['type']): string {
  switch (type) {
    case 'addition':
      return 'bg-(--d-add)';
    case 'deletion':
      return 'bg-(--d-del)';
    default:
      return '';
  }
}

function getSignClass(type: DiffLine['type']): string {
  switch (type) {
    case 'addition':
      return 'text-(--d-success-text)';
    case 'deletion':
      return 'text-(--d-danger-text)';
    default:
      return '';
  }
}

function getLineNumberClass(type: DiffLine['type']): string {
  return type === 'addition' || type === 'deletion' ? 'text-(--d-faint-text)' : 'text-(--d-faint)';
}

function getLineIndicator(type: DiffLine['type']): string {
  switch (type) {
    case 'addition':
      return '+';
    case 'deletion':
      return '-';
    default:
      return '';
  }
}

watch(
  [() => props.diff, () => props.fileName, () => settingsStore.hostCapabilities.damoclesTheme],
  highlightLines,
  { immediate: true }
);

onMounted(() => {
  isMounted.value = true;
});

onUnmounted(() => {
  isMounted.value = false;
});
</script>

<template>
  <div
    class="overflow-hidden bg-(--d-code)"
    data-testid="diff-view"
    :data-numbered="diff.numbered"
  >
    <p
      v-if="diff.omitted"
      class="px-3 py-2 text-xs text-(--d-muted)"
      data-testid="diff-omitted"
    >
      {{ t(`diffView.omitted.${diff.omitted}`) }}
    </p>
    <p
      v-else-if="diff.empty"
      class="px-3 py-2 text-xs text-(--d-muted)"
      data-testid="diff-empty"
    >
      {{ t(`diffView.empty.${diff.empty}`) }}
    </p>
    <div
      v-else
      class="overflow-auto py-1"
      :style="{ maxHeight }"
    >
      <table class="w-full border-collapse font-mono text-11.5 leading-[1.7]">
        <tbody>
          <template
            v-for="(line, idx) in highlightedLines"
            :key="idx"
          >
            <tr v-if="line.type === 'gap'">
              <td
                :colspan="columnCount"
                class="py-0.5 text-center text-11 text-(--d-faint)"
              >
                <span v-if="line.hiddenCount">{{ t('diffView.hiddenLines', { n: line.hiddenCount }, line.hiddenCount) }}</span>
                <span v-else>───</span>
              </td>
            </tr>
            <tr v-else-if="line.type === 'noNewline'">
              <td
                :colspan="columnCount"
                class="pl-12 text-11 text-(--d-faint) italic"
                data-testid="diff-no-newline"
              >
                {{ t('diffView.noNewline') }}
              </td>
            </tr>
            <tr
              v-else
              :class="getLineTypeClass(line.type)"
            >
              <template v-if="diff.numbered">
                <td
                  class="w-8 pr-1 text-right align-top select-none"
                  :class="getLineNumberClass(line.type)"
                  data-diff-line="old"
                >
                  {{ line.oldLineNum ?? '' }}
                </td>
                <td
                  class="w-8 pr-2 text-right align-top select-none"
                  :class="getLineNumberClass(line.type)"
                  data-diff-line="new"
                >
                  {{ line.newLineNum ?? '' }}
                </td>
              </template>
              <td
                class="w-3.5 align-top select-none"
                :class="[getSignClass(line.type), !diff.numbered && 'pl-2']"
              >
                {{ getLineIndicator(line.type) }}
              </td>
              <!-- eslint-disable vue/no-v-html -- Shiki output, or the escaped fallback -->
              <td
                class="diff-code pr-4 align-top break-all whitespace-pre"
                v-html="line.highlightedContent || '&nbsp;'"
              />
              <!-- eslint-enable vue/no-v-html -->
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
@layer app {
  /* Important against Shiki's inline backgrounds; it also beats a theme's important background (docs/themes.md "Custom CSS"). */
  .diff-code :deep(span) {
    background: transparent !important;
  }
}
</style>
