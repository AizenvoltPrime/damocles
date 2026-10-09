<script setup lang="ts">
import { computed, nextTick, onMounted, ref, shallowRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useVirtualList } from '@vueuse/core';
import { Check, CornerDownLeft, Search } from 'lucide-vue-next';
import { remPx } from '@/composables/useRemPx';
import { useSlidingIndicator } from '@/composables/useSlidingIndicator';
import SlidingIndicator from '@/components/SlidingIndicator.vue';
import ProjectAvatar from '../../components/ProjectAvatar.vue';
import { ariaKeyshortcuts, highlightSegments, keycaps, type QuickPickItem, type QuickPickModel, type QuickPickRow } from '../quick-pick';
import { createPointerMoveFilter } from '../pointer-moved';

// A combobox over a virtualized listbox: Quick Open's files and the command palette's commands. Each keystroke asks `load`,
// and an answer to an older query is dropped.
const props = defineProps<{
  label: string;
  placeholder: string;
  load: (query: string) => Promise<QuickPickModel>;
  // the palette opens with ">" typed, as VS Code's Show All Commands does
  initialQuery?: string;
  emptyText?: string | undefined;
  // the project folder main limited the list to, shown as a chip before the query
  scope?: { readonly project: string; readonly label: string } | undefined;
}>();
// shift: the row was taken with Shift+Enter or Shift+click, which the new-terminal pick reads as the current project
const emit = defineEmits<{ accept: [id: string, shift: boolean]; cancel: [] }>();
const { t } = useI18n();

// rem of an item row (the reference's 28px) and a group label row.
const ITEM_REM = 1.75;
const SEPARATOR_REM = 1.625;

const query = ref(props.initialQuery ?? '');
const model = shallowRef<QuickPickModel>({ rows: [] });
const loaded = ref(false);
const active = ref(0);
const input = ref<HTMLInputElement | null>(null);
const listId = useId();
let generation = 0;

const rows = computed(() => model.value.rows);
const itemIndices = computed(() => rows.value.flatMap((row, index) => (row.kind === 'item' ? [index] : [])));
const activeRow = computed(() => itemIndices.value[active.value]);
const rowHeight = (row: QuickPickRow | undefined): number => remPx(row?.kind === 'separator' ? SEPARATOR_REM : ITEM_REM);
const { list: visible, containerProps, wrapperProps } = useVirtualList(rows, { itemHeight: (index) => rowHeight(rows.value[index]), overscan: 6 });

// The keyboard and pointer position slides between rows as one indicator; it is measured among the rendered rows.
const wrapper = ref<HTMLElement | null>(null);
const renderedActive = computed(() => visible.value.filter(({ data }) => data.kind === 'item').findIndex(({ index }) => index === activeRow.value));
const { box, animate } = useSlidingIndicator(wrapper, '[data-quick-pick-item]', renderedActive);

const optionId = (index: number): string => `${listId}-${index}`;
const activeDescendant = computed(() => (renderedActive.value >= 0 && activeRow.value !== undefined ? optionId(activeRow.value) : undefined));

async function refresh(): Promise<void> {
  const asked = ++generation;
  const next = await props.load(query.value);
  if (asked !== generation) return;
  model.value = next;
  loaded.value = true;
  active.value = 0;
  containerProps.ref.value?.scrollTo({ top: 0 });
  const start = itemIndices.value.findIndex((index) => {
    const row = next.rows[index];
    return row?.kind === 'item' && row.item.id === next.activeId;
  });
  // Revealed once the list has laid out the new rows.
  if (start > 0) {
    active.value = start;
    void nextTick(() => reveal(activeRow.value));
  }
}
watch(query, () => void refresh());
// A pick with steps hands in each step's loader; the query starts over with it.
watch(() => props.load, () => {
  query.value = '';
  void refresh();
});

function reveal(rowIndex: number | undefined): void {
  const container = containerProps.ref.value;
  if (!container || rowIndex === undefined) return;
  let top = 0;
  for (let i = 0; i < rowIndex; i++) top += rowHeight(rows.value[i]);
  // A group's first item brings its label into view with it.
  const previous = rows.value[rowIndex - 1];
  const labelTop = previous?.kind === 'separator' ? top - rowHeight(previous) : top;
  const bottom = top + rowHeight(rows.value[rowIndex]);
  if (labelTop < container.scrollTop) container.scrollTop = labelTop;
  else if (bottom > container.scrollTop + container.clientHeight) container.scrollTop = bottom - container.clientHeight;
}

function move(to: number): void {
  const count = itemIndices.value.length;
  if (count === 0) return;
  active.value = (to + count) % count;
  reveal(activeRow.value);
}

function accept(rowIndex: number | undefined, shift: boolean): void {
  const row = rowIndex === undefined ? undefined : rows.value[rowIndex];
  if (row?.kind === 'item' && !row.item.disabled) emit('accept', row.item.id, shift);
}

// A command's label: its "Category: " prefix quieter than its title, with the match highlights cut across both.
function labelParts(item: QuickPickItem): Array<{ text: string; match: boolean; category: boolean }> {
  const split = item.categoryLength ?? 0;
  return highlightSegments(item.label, item.labelMatches).flatMap((segment, index, all) => {
    const start = all.slice(0, index).reduce((sum, previous) => sum + previous.text.length, 0);
    const end = start + segment.text.length;
    if (end <= split) return [{ ...segment, category: true }];
    if (start >= split) return [{ ...segment, category: false }];
    return [{ text: segment.text.slice(0, split - start), match: segment.match, category: true }, { text: segment.text.slice(split - start), match: segment.match, category: false }];
  });
}

function onKeydown(event: KeyboardEvent): void {
  const page = Math.max(1, Math.floor((containerProps.ref.value?.clientHeight ?? 0) / remPx(ITEM_REM)) - 1);
  if (event.key === 'ArrowDown') move(active.value + 1);
  else if (event.key === 'ArrowUp') move(active.value - 1);
  else if (event.key === 'PageDown') move(Math.min(active.value + page, itemIndices.value.length - 1));
  else if (event.key === 'PageUp') move(Math.max(active.value - page, 0));
  else if (event.key === 'Enter') accept(activeRow.value, event.shiftKey);
  else if (event.key === 'Escape') emit('cancel');
  // Focus stays in the combobox: the list is driven from it, and a Tab into the scroller would strand the keyboard.
  else if (event.key !== 'Tab') return;
  event.preventDefault();
  event.stopPropagation();
}

const pointerMoved = createPointerMoveFilter();
function onPointerMove(event: PointerEvent, rowIndex: number): void {
  if (!pointerMoved(event)) return;
  const index = itemIndices.value.indexOf(rowIndex);
  if (index >= 0) active.value = index;
}

onMounted(() => {
  void refresh();
  void nextTick(() => {
    input.value?.focus();
    input.value?.setSelectionRange(query.value.length, query.value.length);
  });
});
</script>

<template>
  <div
    data-testid="quick-pick"
    class="quick-pick fixed top-11.5 left-1/2 flex w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 flex-col rounded-xl border border-(--d-border2) bg-(--d-card) p-1.5 text-(--d-text) shadow-(--d-shadow)"
  >
    <label class="quick-pick-input flex h-8 shrink-0 items-center gap-2 rounded-lg border border-(--d-accent) bg-(--d-input) px-2.5 shadow-[0_0_0_3px_var(--d-accent-soft)]">
      <Search
        aria-hidden="true"
        class="size-3.5 shrink-0 text-(--d-faint)"
      />
      <Transition
        name="t-chip"
        appear
      >
        <span
          v-if="scope"
          data-testid="quick-pick-scope"
          :title="scope.label"
          class="flex h-5 max-w-1/2 min-w-0 shrink-0 items-center gap-1.25 rounded-md bg-(--d-accent-soft) pr-1.75 pl-1 text-11.5 font-medium text-(--d-accent-text)"
        >
          <ProjectAvatar
            :name="scope.project"
            class="size-3.5 shrink-0 rounded text-[0.5rem]"
          />
          <span class="truncate">{{ scope.label }}</span>
        </span>
      </Transition>
      <!-- A combobox input: no shadcn part combines one with a virtualized listbox. -->
      <input
        ref="input"
        v-model="query"
        type="text"
        role="combobox"
        spellcheck="false"
        autocomplete="off"
        data-testid="quick-pick-input"
        aria-autocomplete="list"
        aria-expanded="true"
        :aria-controls="listId"
        :aria-activedescendant="activeDescendant"
        :aria-label="label"
        :placeholder="placeholder"
        class="min-w-0 flex-1 border-0 bg-transparent text-13 text-(--d-text) outline-none placeholder:text-(--d-faint)"
        @keydown="onKeydown"
      >
    </label>
    <Transition name="t-swap">
      <p
        v-if="model.hint"
        :key="model.hint"
        data-testid="quick-pick-hint"
        class="flex items-center gap-1.5 px-2 pt-1.5 pb-0.5 text-11.5 text-(--d-faint-text)"
      >
        <CornerDownLeft
          aria-hidden="true"
          class="size-3"
        />{{ model.hint }}
      </p>
    </Transition>
    <div
      v-bind="containerProps"
      :id="listId"
      role="listbox"
      :aria-label="label"
      data-testid="quick-pick-list"
      class="quick-pick-list mt-1 max-h-80 overflow-x-hidden overscroll-contain"
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
          :key="row.kind === 'item' ? `item:${row.item.id}` : `separator:${index}`"
        >
          <div
            v-if="row.kind === 'separator'"
            role="presentation"
            class="flex items-end border-t border-(--d-border) px-2 pb-0.5 text-10.5 text-(--d-faint-text)"
            :class="index === 0 ? 'border-t-0' : ''"
            :style="{ height: `${rowHeight(row)}px` }"
          >
            {{ row.label }}
          </div>
          <div
            v-else
            :id="optionId(index)"
            role="option"
            data-quick-pick-item
            data-testid="quick-pick-item"
            :data-item-id="row.item.id"
            :aria-selected="index === activeRow"
            :aria-disabled="row.item.disabled ? 'true' : undefined"
            :aria-keyshortcuts="row.item.shortcut ? ariaKeyshortcuts(row.item.shortcut) : undefined"
            :aria-checked="row.item.checked"
            class="relative flex items-center gap-2.25 rounded-7 px-2"
            :class="row.item.disabled ? 'cursor-default opacity-50' : 'cursor-pointer'"
            :style="{ height: `${rowHeight(row)}px` }"
            @pointermove="onPointerMove($event, index)"
            @mousedown.prevent
            @click="accept(index, $event.shiftKey)"
          >
            <component
              :is="row.item.icon"
              v-if="row.item.icon"
              aria-hidden="true"
              class="size-3.25 shrink-0"
              :style="{ color: row.item.iconColor }"
            />
            <span class="shrink-0 text-12.5 whitespace-nowrap">
              <template
                v-for="(segment, segmentIndex) in labelParts(row.item)"
                :key="segmentIndex"
              ><mark
                v-if="segment.match"
                class="quick-pick-match"
              >{{ segment.text }}</mark><span
                v-else-if="segment.category"
                class="text-(--d-muted)"
              >{{ segment.text }}</span><template v-else>{{ segment.text }}</template></template>
            </span>
            <span
              v-if="row.item.badge"
              data-testid="quick-pick-badge"
              class="shrink-0 rounded-full border border-(--d-border2) px-1.5 text-10/4 text-(--d-faint-text)"
            >{{ row.item.badge }}</span>
            <Check
              v-if="row.item.checked"
              aria-hidden="true"
              class="size-3.25 shrink-0 text-(--d-accent-text)"
            />
            <span class="min-w-0 flex-1 truncate text-11 text-(--d-faint-text)">
              <template
                v-for="(segment, segmentIndex) in highlightSegments(row.item.description ?? '', row.item.descriptionMatches)"
                :key="segmentIndex"
              ><mark
                v-if="segment.match"
                class="quick-pick-match"
              >{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template>
            </span>
            <ProjectAvatar
              v-if="row.item.project"
              :name="row.item.project"
              :title="row.item.project"
              class="size-4 rounded text-[0.5625rem]"
            />
            <span
              v-if="row.item.shortcut"
              aria-hidden="true"
              data-testid="quick-pick-shortcut"
              class="flex shrink-0 items-center gap-0.75"
            >
              <kbd
                v-for="(cap, capIndex) in keycaps(row.item.shortcut)"
                :key="capIndex"
                class="min-w-4.5 rounded-5 border border-(--d-border2) bg-(--d-panel) px-1.25 text-center font-mono text-10.5/4 text-(--d-muted)"
              >{{ cap }}</kbd>
            </span>
          </div>
        </template>
      </div>
    </div>
    <p
      v-if="loaded && rows.length === 0"
      data-testid="quick-pick-empty"
      class="px-2 py-3 text-center text-12 text-(--d-faint)"
    >
      {{ emptyText ?? t('overlay.noMatches') }}
    </p>
  </div>
</template>
