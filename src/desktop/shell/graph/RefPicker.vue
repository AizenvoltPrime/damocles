<script setup lang="ts">
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useVirtualList } from '@vueuse/core';
import { Check, Cloud, GitBranch, GitFork, Info, Search, Tag, TriangleAlert, WandSparkles } from 'lucide-vue-next';
import type { Component } from 'vue';
import { Button } from '@/components/ui/button';
import { remPx } from '@/composables/useRemPx';
import { useSlidingIndicator } from '@/composables/useSlidingIndicator';
import SlidingIndicator from '@/components/SlidingIndicator.vue';
import { visibleText } from '@shared/visible-text';
import { MAX_GRAPH_CHOICE_REFS } from '../../preload/shell-channels';
import type { OverlayAnswer, OverlayRequest } from '../../preload/overlay-channels';
import { placePopup } from '../overlay/placement';
import { trapTab } from '../overlay/focus-trap';
import { createPointerMoveFilter } from '../overlay/pointer-moved';
import { choiceOfSelection, isPicked, pickerRows, selectionOf, toggleSelection, type PickerRow, type RefGroup } from './graph-model';

// The Graph's ref picker (A.4; VS Code's HistoryItemRefPicker, canSelectMany): a filter over a virtualized multi-select listbox.
// Custom markup: Popover and Command need their trigger in this document and do not virtualize, and the anchor is in the shell
// view, so the panel places itself at the rect it is sent. Escape and a click outside leave the choice as it was.
const props = defineProps<{ request: Extract<OverlayRequest, { kind: 'refPicker' }> }>();
const emit = defineEmits<{ answer: [answer: OverlayAnswer] }>();
const { t, locale } = useI18n();

// rem of an option row and a group label row
const OPTION_REM = 1.75;
const GROUP_REM = 1.5;
// rem the list may take before it scrolls
const LIST_MAX_REM = 18;

const root = ref<HTMLElement | null>(null);
const input = ref<HTMLInputElement | null>(null);
const listId = useId();
const noticeId = useId();
const filter = ref('');
const selection = ref(selectionOf(props.request.selected));
const active = ref(0);
const position = ref<{ left: number; top: number }>({ left: props.request.anchor.x, top: props.request.anchor.y + props.request.anchor.height });

const specialLabels = computed(() => ({ auto: t('graph.auto'), all: t('graph.all') }));
const rows = computed(() => pickerRows(props.request.refs, filter.value, specialLabels.value));
const options = computed(() => rows.value.flatMap((row, index) => (row.kind === 'group' ? [] : [index])));
const activeRow = computed(() => options.value[active.value]);
const rowHeight = (row: PickerRow | undefined): number => remPx(row?.kind === 'group' ? GROUP_REM : OPTION_REM);
const { list: visible, containerProps, wrapperProps } = useVirtualList(rows, { itemHeight: (index) => rowHeight(rows.value[index]), overscan: 6 });
const listHeight = computed(() => Math.min(rows.value.reduce((sum, row) => sum + rowHeight(row), 0), remPx(LIST_MAX_REM)));

const wrapper = ref<HTMLElement | null>(null);
const renderedActive = computed(() => visible.value.filter(({ data }) => data.kind !== 'group').findIndex(({ index }) => index === activeRow.value));
const { box, animate } = useSlidingIndicator(wrapper, '[data-ref-option]', renderedActive);

const optionId = (index: number): string => `${listId}-${index}`;
const activeDescendant = computed(() => (renderedActive.value >= 0 && activeRow.value !== undefined ? optionId(activeRow.value) : undefined));
const itemOf = (row: PickerRow): 'auto' | 'all' | string => (row.kind === 'special' ? row.id : row.kind === 'ref' ? row.ref.id : '');

const GROUP_ICONS: Readonly<Record<RefGroup, Component>> = { branches: GitBranch, remotes: Cloud, tags: Tag };
const picked = computed(() => (selection.value.kind === 'refs' ? selection.value.refs.length : 0));
const atLimit = computed(() => picked.value >= MAX_GRAPH_CHOICE_REFS);

watch(filter, () => {
  active.value = 0;
  containerProps.ref.value?.scrollTo({ top: 0 });
});

function reveal(rowIndex: number | undefined): void {
  const container = containerProps.ref.value;
  if (!container || rowIndex === undefined) return;
  let top = 0;
  for (let i = 0; i < rowIndex; i++) top += rowHeight(rows.value[i]);
  const previous = rows.value[rowIndex - 1];
  const labelTop = previous?.kind === 'group' ? top - rowHeight(previous) : top;
  const bottom = top + rowHeight(rows.value[rowIndex]);
  if (labelTop < container.scrollTop) container.scrollTop = labelTop;
  else if (bottom > container.scrollTop + container.clientHeight) container.scrollTop = bottom - container.clientHeight;
}

function move(to: number): void {
  const count = options.value.length;
  if (count === 0) return;
  active.value = (to + count) % count;
  reveal(activeRow.value);
}

function toggle(rowIndex: number | undefined): void {
  const row = rowIndex === undefined ? undefined : rows.value[rowIndex];
  if (!row || row.kind === 'group') return;
  selection.value = toggleSelection(selection.value, itemOf(row));
}

function accept(): void {
  const choice = choiceOfSelection(selection.value);
  // a fresh array: the selection is reactive, and the context bridge cannot clone a proxy
  emit('answer', { kind: 'refPicker', choice: typeof choice === 'string' ? choice : [...choice] });
}

function onKeydown(event: KeyboardEvent): void {
  const page = Math.max(1, Math.floor(listHeight.value / remPx(OPTION_REM)) - 1);
  if (root.value && trapTab(event, root.value)) return;
  if (event.key === 'ArrowDown') move(active.value + 1);
  else if (event.key === 'ArrowUp') move(active.value - 1);
  else if (event.key === 'PageDown') move(Math.min(active.value + page, options.value.length - 1));
  else if (event.key === 'PageUp') move(Math.max(active.value - page, 0));
  // Refnames hold no spaces, so Space toggles the active option as in VS Code's multi-select pick.
  else if (event.key === ' ' && event.target === input.value) toggle(activeRow.value);
  else if (event.key === 'Enter' && event.target === input.value) accept();
  else return;
  event.preventDefault();
}

// A press outside the field must not take focus from it, or the keys stop answering.
function keepFocus(event: MouseEvent): void {
  if (event.target !== input.value && !(event.target instanceof Element && event.target.closest('button'))) event.preventDefault();
}

const pointerMoved = createPointerMoveFilter();
function onPointerMove(event: PointerEvent, rowIndex: number): void {
  if (!pointerMoved(event)) return;
  const index = options.value.indexOf(rowIndex);
  if (index >= 0) active.value = index;
}

function onClick(rowIndex: number): void {
  const index = options.value.indexOf(rowIndex);
  if (index >= 0) active.value = index;
  toggle(rowIndex);
}

// An option's accessible name: its name, Auto's or All's description, and on a group's first option the group's label.
function optionName(row: PickerRow, rowIndex: number): string {
  const previous = rows.value[rowIndex - 1];
  const group = previous?.kind === 'group' ? t(`graph.picker.group.${previous.group}`) : '';
  if (row.kind === 'special') return [specialLabels.value[row.id], t(`graph.picker.${row.id}Description`)].join(', ');
  return row.kind === 'ref' ? [visibleText(row.ref.name), group].filter((part) => part !== '').join(', ') : '';
}

onMounted(() => {
  const element = root.value;
  if (!element) return;
  // Layout size, not getBoundingClientRect: the entrance animation starts scaled down.
  position.value = placePopup(props.request.anchor, { width: element.offsetWidth, height: element.offsetHeight }, { width: window.innerWidth, height: window.innerHeight });
  void nextTick(() => input.value?.focus());
});
</script>

<template>
  <div
    ref="root"
    role="dialog"
    aria-modal="true"
    data-testid="graph-ref-picker"
    :aria-label="t('graph.picker.label')"
    class="fixed flex w-80 animate-[d-pop_.14s_var(--ease-out)] flex-col gap-1 rounded-11 border border-(--d-border2) bg-(--d-card) p-1.5 text-(--d-text) shadow-(--d-shadow) in-[.overlay-pop-leave-active]:animate-[d-pop-out_.12s_ease-in_both]"
    :style="{ left: `${position.left}px`, top: `${position.top}px` }"
    @keydown="onKeydown"
    @mousedown="keepFocus"
  >
    <label class="flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-(--d-accent) bg-(--d-input) px-2 shadow-[0_0_0_3px_var(--d-accent-soft)]">
      <Search
        aria-hidden="true"
        class="size-3 shrink-0 text-(--d-faint)"
      />
      <input
        ref="input"
        v-model="filter"
        type="text"
        role="combobox"
        spellcheck="false"
        autocomplete="off"
        data-testid="graph-ref-filter"
        aria-autocomplete="list"
        aria-expanded="true"
        :aria-controls="listId"
        :aria-activedescendant="activeDescendant"
        :aria-describedby="request.failed || request.omitted > 0 ? noticeId : undefined"
        :aria-label="t('graph.picker.placeholder')"
        :placeholder="t('graph.picker.placeholder')"
        class="min-w-0 flex-1 border-0 bg-transparent text-xs text-(--d-text) outline-none placeholder:text-(--d-faint)"
      >
    </label>
    <div
      v-bind="containerProps"
      :id="listId"
      role="listbox"
      aria-multiselectable="true"
      data-testid="graph-ref-list"
      :aria-label="t('graph.picker.label')"
      class="overflow-x-hidden overscroll-contain"
      :style="{ height: `${listHeight}px` }"
    >
      <div
        ref="wrapper"
        v-bind="wrapperProps"
        class="relative"
      >
        <SlidingIndicator
          class="text-(--d-accent-soft)"
          :box="box"
          :radius="7"
          :animate="animate"
          variant="soft"
        />
        <template
          v-for="{ data: row, index } in visible"
          :key="row.kind === 'group' ? `group:${row.group}` : `option:${itemOf(row)}`"
        >
          <div
            v-if="row.kind === 'group'"
            role="presentation"
            data-testid="graph-ref-group"
            class="flex items-end border-t border-(--d-border) px-2 pb-0.5 text-10.5 font-semibold text-(--d-faint-text)"
            :style="{ height: `${rowHeight(row)}px` }"
          >
            {{ t(`graph.picker.group.${row.group}`) }}
          </div>
          <div
            v-else
            :id="optionId(index)"
            role="option"
            data-ref-option
            data-testid="graph-ref-option"
            :data-item="itemOf(row)"
            :aria-selected="isPicked(selection, itemOf(row))"
            :aria-disabled="row.kind === 'ref' && atLimit && !isPicked(selection, itemOf(row)) ? 'true' : undefined"
            :aria-label="optionName(row, index)"
            class="relative flex cursor-pointer items-center gap-2 rounded-7 px-2 aria-disabled:cursor-default aria-disabled:opacity-45"
            :style="{ height: `${rowHeight(row)}px` }"
            @pointermove="onPointerMove($event, index)"
            @mousedown.prevent
            @click="onClick(index)"
          >
            <!-- A checkbox look: the mark pops in when picked and is gone at once when not. -->
            <span
              aria-hidden="true"
              class="flex size-3.5 shrink-0 items-center justify-center rounded-5 border transition-colors duration-150"
              :class="isPicked(selection, itemOf(row)) ? 'border-(--d-accent) bg-(--d-accent) text-(--d-on-accent)' : 'border-(--d-border2) bg-(--d-input)'"
            >
              <Transition name="t-icon">
                <Check
                  v-if="isPicked(selection, itemOf(row))"
                  data-testid="graph-ref-check"
                  class="size-2.75"
                  :stroke-width="3"
                />
              </Transition>
            </span>
            <component
              :is="row.kind === 'special' ? (row.id === 'auto' ? WandSparkles : GitFork) : GROUP_ICONS[row.group]"
              aria-hidden="true"
              class="size-3.25 shrink-0 text-(--d-faint)"
            />
            <template v-if="row.kind === 'special'">
              <span class="shrink-0 text-xs font-medium">{{ specialLabels[row.id] }}</span>
              <span class="min-w-0 truncate text-11 text-(--d-faint)">{{ t(`graph.picker.${row.id}Description`) }}</span>
            </template>
            <span
              v-else
              class="min-w-0 truncate font-mono text-11.5"
              :title="visibleText(row.ref.name)"
            >{{ visibleText(row.ref.name) }}</span>
          </div>
        </template>
      </div>
    </div>
    <p
      v-if="rows.length === 0"
      class="px-2 py-1.5 text-xs text-(--d-faint)"
    >
      {{ t('graph.picker.empty') }}
    </p>
    <!-- Whatever is typed: the list may lack refs, and no filter brings them back. The filter field is described by them. -->
    <div
      v-if="request.failed || request.omitted > 0"
      :id="noticeId"
    >
      <p
        v-if="request.failed"
        data-testid="graph-ref-failed"
        class="flex items-center gap-1.5 px-2 py-1 text-11 text-(--d-warning-text)"
      >
        <TriangleAlert
          aria-hidden="true"
          class="size-3 shrink-0"
        />{{ t('graph.picker.failed') }}
      </p>
      <p
        v-if="request.omitted > 0"
        data-testid="graph-ref-omitted"
        class="flex items-center gap-1.5 px-2 py-1 text-11 text-(--d-faint)"
      >
        <Info
          aria-hidden="true"
          class="size-3 shrink-0"
        />{{ t('graph.picker.omitted', request.omitted, { named: { n: request.omitted.toLocaleString(locale) } }) }}
      </p>
    </div>
    <div class="flex items-center gap-2 border-t border-(--d-border) px-1 pt-1.5">
      <span
        data-testid="graph-ref-summary"
        role="status"
        class="min-w-0 flex-1 truncate text-11 text-(--d-faint)"
      >{{ atLimit ? t('graph.picker.limit', { n: MAX_GRAPH_CHOICE_REFS }) : picked > 0 ? t('graph.picker.selected', { n: picked }) : '' }}</span>
      <Button
        type="button"
        size="sm"
        data-testid="graph-ref-ok"
        class="d-press h-6 rounded-md px-3 text-xs"
        @click="accept"
      >
        {{ t('graph.picker.ok') }}
      </Button>
    </div>
  </div>
</template>
