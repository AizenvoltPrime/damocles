<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { ArrowDown, ArrowUp, CaseSensitive, Regex, WholeWord, X } from 'lucide-vue-next';
import type { ISearchOptions, SearchAddon } from '@xterm/addon-search';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { searchDecorations, watchHostTheme } from './terminal-theme';

// The terminal's find widget, in the editor's find widget style: a card hanging from the pane's top edge with the query, the
// three match options, the match count and previous, next and close.
const props = defineProps<{ search: SearchAddon }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();

const input = ref<HTMLInputElement | null>(null);
const query = ref('');
const options = ref({ caseSensitive: false, wholeWord: false, regex: false });
const results = shallowRef<{ index: number; count: number } | null>(null);
// addon-search builds the RegExp without catching, so a pattern still being typed (`(`) is checked first.
const invalid = computed(() => {
  if (!options.value.regex || query.value === '') return false;
  try {
    new RegExp(query.value);
    return false;
  } catch {
    return true;
  }
});
let decorations = searchDecorations(getComputedStyle(document.documentElement));

const searchOptions = (incremental: boolean): ISearchOptions => ({ ...options.value, incremental, decorations });

function find(direction: 'next' | 'previous', incremental = false): void {
  if (query.value === '' || invalid.value) {
    props.search.clearDecorations();
    results.value = null;
    return;
  }
  if (direction === 'next') props.search.findNext(query.value, searchOptions(incremental));
  else props.search.findPrevious(query.value, searchOptions(incremental));
}

function setOption(key: keyof typeof options.value, value: boolean): void {
  options.value = { ...options.value, [key]: value };
  find('next', true);
}

const status = computed(() => {
  if (invalid.value) return t('terminal.find.invalid');
  if (query.value === '' || !results.value) return '';
  const { index, count } = results.value;
  if (count === 0) return t('terminal.find.none');
  return index < 0 ? t('terminal.find.count', { count }, count) : t('terminal.find.position', { index: index + 1, count });
});

// Enter and F3 search from the query field only; on a button Enter activates that button.
function onKeydown(event: KeyboardEvent): void {
  if ((event.key === 'Enter' || event.key === 'F3') && event.target === input.value) find(event.shiftKey ? 'previous' : 'next');
  else if (event.key === 'Escape') emit('close');
  else return;
  event.preventDefault();
  event.stopPropagation();
}

const stops: Array<() => void> = [];
onMounted(() => {
  const subscription = props.search.onDidChangeResults(({ resultIndex, resultCount }) => {
    results.value = { index: resultIndex, count: resultCount };
  });
  stops.push(() => subscription.dispose());
  stops.push(watchHostTheme(() => {
    decorations = searchDecorations(getComputedStyle(document.documentElement));
    find('next', true);
  }));
  void nextTick(() => input.value?.focus());
});
onBeforeUnmount(() => {
  for (const stop of stops) stop();
  props.search.clearDecorations();
});

defineExpose({ focus: () => input.value?.select() });

const OPTIONS = [
  { key: 'caseSensitive', label: 'terminal.find.matchCase', icon: CaseSensitive },
  { key: 'wholeWord', label: 'terminal.find.wholeWord', icon: WholeWord },
  { key: 'regex', label: 'terminal.find.regex', icon: Regex },
] as const;
</script>

<template>
  <div
    role="search"
    data-testid="terminal-find"
    class="terminal-find absolute top-0 right-3.5 z-10 flex h-9 items-center gap-1 rounded-b-lg border border-t-0 border-(--d-border2) bg-(--d-card) pr-1 pl-1.5 shadow-(--d-shadow)"
    @keydown="onKeydown"
  >
    <!-- A box around a bare input that also holds the option toggles, as the editor's and Search's find fields are. -->
    <div
      class="flex h-6.5 w-52 items-center gap-0.5 rounded-md border bg-(--d-input) pr-0.75 pl-2"
      :class="invalid ? 'border-(--d-danger)' : 'border-(--d-border2) focus-within:border-(--d-accent)'"
    >
      <input
        ref="input"
        v-model="query"
        type="text"
        spellcheck="false"
        autocomplete="off"
        data-testid="terminal-find-input"
        :aria-label="t('terminal.find.label')"
        :aria-invalid="invalid || undefined"
        :placeholder="t('terminal.find.placeholder')"
        class="min-w-0 flex-1 border-0 bg-transparent text-xs text-(--d-text) outline-none placeholder:text-(--d-faint)"
        @input="find('next', true)"
      >
      <Toggle
        v-for="option in OPTIONS"
        :key="option.key"
        :model-value="options[option.key]"
        size="sm"
        :data-testid="`terminal-find-${option.key}`"
        class="h-5 min-w-5 rounded-5 border border-transparent px-0 text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) focus-visible:ring-1 focus-visible:ring-(--d-accent) focus-visible:ring-offset-0 data-[state=on]:border-(--d-accent) data-[state=on]:bg-(--d-accent-soft) data-[state=on]:text-(--d-accent-text) [&_svg]:size-3.5"
        :aria-label="t(option.label)"
        :title="t(option.label)"
        @update:model-value="setOption(option.key, $event)"
      >
        <component
          :is="option.icon"
          aria-hidden="true"
        />
      </Toggle>
    </div>
    <span
      role="status"
      data-testid="terminal-find-status"
      class="min-w-17 px-1 text-11.5 whitespace-nowrap tabular-nums"
      :class="invalid || (results?.count === 0 && query !== '') ? 'text-(--d-danger-text)' : 'text-(--d-muted)'"
    >{{ status }}</span>
    <Button
      variant="ghost"
      size="icon"
      data-testid="terminal-find-previous"
      class="d-press size-6 rounded-md text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) [&_svg]:size-3.5"
      :disabled="query === ''"
      :aria-label="t('terminal.find.previous')"
      :title="t('terminal.find.previous')"
      @click="find('previous')"
    >
      <ArrowUp aria-hidden="true" />
    </Button>
    <Button
      variant="ghost"
      size="icon"
      data-testid="terminal-find-next"
      class="d-press size-6 rounded-md text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) [&_svg]:size-3.5"
      :disabled="query === ''"
      :aria-label="t('terminal.find.next')"
      :title="t('terminal.find.next')"
      @click="find('next')"
    >
      <ArrowDown aria-hidden="true" />
    </Button>
    <Button
      variant="ghost"
      size="icon"
      data-testid="terminal-find-close"
      class="d-press size-6 rounded-md text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) [&_svg]:size-3.5"
      :aria-label="t('terminal.find.close')"
      :title="t('terminal.find.close')"
      @click="emit('close')"
    >
      <X aria-hidden="true" />
    </Button>
  </div>
</template>
