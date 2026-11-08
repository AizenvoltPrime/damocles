<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowReactive, shallowRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useVirtualList } from '@vueuse/core';
import { Check, CornerDownLeft, Search } from 'lucide-vue-next';
import { remPx } from '@/composables/useRemPx';
import { useSlidingIndicator } from '@/composables/useSlidingIndicator';
import SlidingIndicator from '@/components/SlidingIndicator.vue';
import ProjectAvatar from '../../components/ProjectAvatar.vue';
import FileIcon from '../../components/FileIcon.vue';
import { ariaKeyshortcuts, highlightSegments, keycaps, type QuickPickItem, type QuickPickModel, type QuickPickRow } from '../quick-pick';
import { createPointerMoveFilter } from '../pointer-moved';
import { Button } from '@/components/ui/button';

// A combobox over a virtualized listbox: Quick Open's files and the command palette's commands. Each keystroke asks `load`,
// and an answer to an older query is dropped.
const props = defineProps<{
  label: string;
  placeholder: string;
  // undefined keeps the rows shown, for a pick on its way out
  load: (query: string) => Promise<QuickPickModel | undefined>;
  // the palette opens with ">" typed, as VS Code's Show All Commands does
  initialQuery?: string;
  emptyText?: string | undefined;
  // the project folder main limited the list to, shown as a chip before the query
  scope?: { readonly project: string; readonly label: string } | undefined;
  // characters the query may hold, where the answer carries it
  maxLength?: number | undefined;
  // checkbox rows, at most max checked, accepted together through acceptMany
  pickMany?: { readonly max: number } | undefined;
}>();
// shift: the row was taken with Shift+Enter or Shift+click, which the new-terminal pick reads as that project's host's default
// shell; query: the text typed when it was taken. acceptMany: the checked rows, or the list's active one alone while none is
// checked.
const emit = defineEmits<{ accept: [id: string, shift: boolean, query: string]; acceptMany: [ids: string[]]; cancel: [] }>();
const { t } = useI18n();

// rem of an item row (the reference's 28px) and a group label row.
const ITEM_REM = 1.75;
const SEPARATOR_REM = 1.625;
// rem of an unlabelled rule, which sets a picker's commands apart from the matches while filtering
const RULE_REM = 0.5625;

const query = ref(props.initialQuery ?? '');
const model = shallowRef<QuickPickModel>({ rows: [] });
const loaded = ref(false);
const active = ref(0);
const input = ref<HTMLInputElement | null>(null);
const okButton = ref<{ $el: HTMLButtonElement } | null>(null);
const listId = useId();
// With pickMany the list takes keyboard focus, as VS Code's canSelectMany list does, so Space checks a row there and types in
// the field.
const focusedPart = ref<'input' | 'list' | 'ok'>('input');
const listFocused = computed(() => focusedPart.value === 'list');
let generation = 0;

const rows = computed(() => model.value.rows);
const itemIndices = computed(() => rows.value.flatMap((row, index) => (row.kind === 'item' ? [index] : [])));
const activeRow = computed(() => itemIndices.value[active.value]);
const rowHeight = (row: QuickPickRow | undefined): number => remPx(row?.kind === 'separator' ? (row.label === '' ? RULE_REM : SEPARATOR_REM) : ITEM_REM);
const { list: visible, containerProps, wrapperProps } = useVirtualList(rows, { itemHeight: (index) => rowHeight(rows.value[index]), overscan: 6 });

// The keyboard and pointer position slides between rows as one indicator; it is measured among the rendered rows.
const wrapper = ref<HTMLElement | null>(null);
const renderedActive = computed(() => visible.value.filter(({ data }) => data.kind === 'item').findIndex(({ index }) => index === activeRow.value));
const { box, animate } = useSlidingIndicator(wrapper, '[data-quick-pick-item]', renderedActive);

const optionId = (index: number): string => `${listId}-${index}`;
const hintText = computed(() => [model.value.hint, model.value.notice].filter((part) => part !== undefined).join(' · '));
const activeDescendant = computed(() => (renderedActive.value >= 0 && activeRow.value !== undefined ? optionId(activeRow.value) : undefined));

// Rows of a folder just gone into slide in from the side they came from, each at the cascade step of the first render that
// showed it, by item id; a row rendered first once the list scrolled stays still.
const entering = ref<'forward' | 'back' | undefined>();
const entrySteps = shallowReactive(new Map<string, number>());
let entryScrolled = false;
let pendingEntry: { query: string; direction: 'forward' | 'back' } | undefined;
let enteringTimer: ReturnType<typeof setTimeout> | undefined;
// the longest row cascade (ENTER_STAGGER rows at 14 ms each, as the template's animation-delay) plus its 200 ms slide
const ENTER_STAGGER = 8;
const ENTER_MS = ENTER_STAGGER * 14 + 200;

function playEntry(direction: 'forward' | 'back'): void {
  clearTimeout(enteringTimer);
  entrySteps.clear();
  entryScrolled = false;
  entering.value = direction;
  enteringTimer = setTimeout(() => {
    entering.value = undefined;
    entrySteps.clear();
  }, ENTER_MS);
}
onBeforeUnmount(() => clearTimeout(enteringTimer));

// After the render, so a row's step is its rendered position, capped at ENTER_STAGGER; a row scrolled out of the rendered
// ones forgets its step.
watch(visible, (rendered) => {
  if (!entering.value) return;
  const ids = new Set(rendered.flatMap(({ data }) => (data.kind === 'item' ? [data.item.id] : [])));
  for (const id of [...entrySteps.keys()]) if (!ids.has(id)) entrySteps.delete(id);
  if (entryScrolled) return;
  rendered.forEach(({ data }, position) => {
    if (data.kind === 'item' && !entrySteps.has(data.item.id)) entrySteps.set(data.item.id, Math.min(position, ENTER_STAGGER));
  });
}, { flush: 'post' });

// show's own scroll to the top is no scroll of the user's
function onListScroll(): void {
  if (entering.value && (containerProps.ref.value?.scrollTop ?? 0) > 0) entryScrolled = true;
}

async function refresh(): Promise<void> {
  const asked = ++generation;
  show(asked, await props.load(query.value));
}

function show(asked: number, next: QuickPickModel | undefined): void {
  if (asked !== generation || !next) return;
  if (next.update) void next.update.then((later) => show(asked, later));
  // the folder's listing is the final model of its query, which a text answer with an update comes before
  if (pendingEntry?.query === query.value && !next.update) {
    playEntry(pendingEntry.direction);
    pendingEntry = undefined;
  }
  model.value = next;
  loaded.value = true;
  // a pickMany list has no active row until the keyboard enters it
  active.value = props.pickMany ? -1 : 0;
  containerProps.ref.value?.scrollTo({ top: 0 });
  const start = props.pickMany ? -1 : itemIndices.value.findIndex((index) => {
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
// A pick with steps hands in each step's loader; the query starts over with it, and the next step's rows slide in.
watch(() => props.load, () => {
  query.value = '';
  pendingEntry = { query: '', direction: 'forward' };
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

// Sets the query main built, then puts the caret where main asked once the field shows it; the field keeps focus.
function setQuery(text: string, caret: number | undefined): void {
  query.value = text;
  void nextTick(() => {
    const at = caret ?? text.length;
    input.value?.setSelectionRange(at, at);
  });
}

function descend(item: QuickPickItem): void {
  if (item.descend === undefined) return;
  // A longer query went down into a folder, a shorter one up to its parent.
  if (item.descend !== query.value) pendingEntry = { query: item.descend, direction: item.descend.length >= query.value.length ? 'forward' : 'back' };
  setQuery(item.descend, item.caret);
}

// Checks survive filtering: they belong to item ids, not to the rows shown.
const checked = shallowRef<ReadonlySet<string>>(new Set());
const full = computed(() => props.pickMany !== undefined && checked.value.size >= props.pickMany.max);
const blocked = (item: QuickPickItem): boolean => full.value && !checked.value.has(item.id);

function toggle(rowIndex: number | undefined): void {
  const row = rowIndex === undefined ? undefined : rows.value[rowIndex];
  if (row?.kind !== 'item' || row.item.disabled || blocked(row.item)) return;
  const next = new Set(checked.value);
  if (!next.delete(row.item.id)) next.add(row.item.id);
  checked.value = next;
}

function accept(rowIndex: number | undefined, shift: boolean): void {
  const row = rowIndex === undefined ? undefined : rows.value[rowIndex];
  if (props.pickMany && checked.value.size > 0) {
    emit('acceptMany', [...checked.value]);
    return;
  }
  if (row?.kind !== 'item' || row.item.disabled) return;
  if (props.pickMany) emit('acceptMany', [row.item.id]);
  else if (row.item.descend !== undefined) descend(row.item);
  else emit('accept', row.item.id, shift, query.value);
}

function acceptChecked(): void {
  if (checked.value.size > 0) emit('acceptMany', [...checked.value]);
}

function enterList(index: number): void {
  if (itemIndices.value.length === 0) return;
  active.value = index;
  reveal(activeRow.value);
  containerProps.ref.value?.focus({ preventScroll: true });
}

function focusInput(): void {
  active.value = -1;
  input.value?.focus();
}

// Tab moves between the field and OK while OK is enabled; the list is entered with the arrows.
function cycleFocus(from: 'input' | 'list' | 'ok', back: boolean): void {
  const ok = checked.value.size > 0 ? okButton.value?.$el : undefined;
  if (ok && (from === 'input' || (from === 'list' && !back))) ok.focus();
  else if (from !== 'input') focusInput();
}

// A key typed in the list goes to the field, which filters.
const typesText = (event: KeyboardEvent): boolean => (event.key.length === 1 || event.key === 'Backspace')
  && (event.getModifierState('AltGraph') || !(event.ctrlKey || event.metaKey || event.altKey));

// pickMany's keys, VS Code's canSelectMany model: in the field the arrows enter the list and Space types; in the list Space
// checks the active row, and moving past either end returns to the field. True when the key was handled.
function pickManyKey(event: KeyboardEvent, from: 'input' | 'list' | 'ok'): boolean {
  const last = itemIndices.value.length - 1;
  const page = Math.max(1, Math.floor((containerProps.ref.value?.clientHeight ?? 0) / remPx(ITEM_REM)) - 1);
  if (event.key === 'Escape') emit('cancel');
  else if (event.key === 'Tab') cycleFocus(from, event.shiftKey);
  else if (from === 'ok') return false;
  else if (event.key === 'Enter') {
    if (from === 'list') accept(activeRow.value, false);
    else acceptChecked();
  } else if (from === 'input') {
    if (event.key === 'ArrowDown' || event.key === 'PageDown') enterList(0);
    else if (event.key === 'ArrowUp' || event.key === 'PageUp') enterList(last);
    else return false;
  } else if (event.key === ' ') toggle(activeRow.value);
  else if (event.key === 'ArrowDown') {
    if (active.value >= last) focusInput();
    else move(active.value + 1);
  } else if (event.key === 'ArrowUp') {
    if (active.value <= 0) focusInput();
    else move(active.value - 1);
  } else if (event.key === 'PageDown') move(Math.min(active.value + page, last));
  else if (event.key === 'PageUp') move(Math.max(active.value - page, 0));
  else if (event.key === 'Home') move(0);
  else if (event.key === 'End') move(last);
  else {
    if (typesText(event)) input.value?.focus();
    return false;
  }
  return true;
}

function onPickManyKeydown(event: KeyboardEvent, from: 'list' | 'ok'): void {
  if (!pickManyKey(event, from)) return;
  event.preventDefault();
  event.stopPropagation();
}

function onInputFocus(): void {
  if (props.pickMany && focusedPart.value !== 'input') active.value = -1;
  focusedPart.value = 'input';
}

function complete(rowIndex: number | undefined): void {
  const row = rowIndex === undefined ? undefined : rows.value[rowIndex];
  if (row?.kind !== 'item') return;
  if (row.item.complete !== undefined) setQuery(row.item.complete, row.item.caret);
  else descend(row.item);
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

// An option's accessible name: its texts, and on a group's first option the group's label, as VS Code's quick pick names
// it, since the separator itself is presentational.
function optionName(item: QuickPickItem, rowIndex: number): string {
  const previous = rows.value[rowIndex - 1];
  const group = previous?.kind === 'separator' ? previous.label : '';
  const kind = item.folder ? t('quickOpen.folderKind') : undefined;
  return [item.label, kind, item.badge, item.description, item.hint, item.project, group].filter((part) => part !== undefined && part !== '').join(', ');
}

function onKeydown(event: KeyboardEvent): void {
  if (props.pickMany) {
    if (!pickManyKey(event, 'input')) return;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  const page = Math.max(1, Math.floor((containerProps.ref.value?.clientHeight ?? 0) / remPx(ITEM_REM)) - 1);
  if (event.key === 'ArrowDown') move(active.value + 1);
  else if (event.key === 'ArrowUp') move(active.value - 1);
  else if (event.key === 'PageDown') move(Math.min(active.value + page, itemIndices.value.length - 1));
  else if (event.key === 'PageUp') move(Math.max(active.value - page, 0));
  else if (event.key === 'Enter') accept(activeRow.value, event.shiftKey);
  else if (event.key === 'Escape') emit('cancel');
  // Focus stays in the combobox: the list is driven from it, and a Tab into the scroller would strand the keyboard.
  else if (event.key === 'Tab') {
    if (!event.shiftKey) complete(activeRow.value);
  } else return;
  event.preventDefault();
  event.stopPropagation();
}

// A press outside the field must not take focus from it, or Enter, Escape and the arrows stop answering.
function keepFocus(event: MouseEvent): void {
  if (event.target !== input.value) event.preventDefault();
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
    @mousedown="keepFocus"
  >
    <div class="flex shrink-0 items-center gap-1.5">
      <label
        class="quick-pick-input flex h-8 min-w-0 flex-1 items-center gap-2 rounded-lg border bg-(--d-input) px-2.5"
        :class="focusedPart === 'input' ? 'border-(--d-accent) shadow-[0_0_0_3px_var(--d-accent-soft)]' : 'border-(--d-border2)'"
      >
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
          :aria-activedescendant="pickMany ? undefined : activeDescendant"
          :aria-label="label"
          :placeholder="placeholder"
          :maxlength="maxLength"
          class="min-w-0 flex-1 border-0 bg-transparent text-13 text-(--d-text) outline-none placeholder:text-(--d-faint)"
          @focus="onInputFocus"
          @keydown="onKeydown"
        >
        <span
          v-if="pickMany"
          :id="`${listId}-count`"
          role="status"
          data-testid="quick-pick-count"
          class="quick-pick-count shrink-0 rounded-full px-1.75 text-11 font-medium tabular-nums"
          :class="checked.size > 0 ? 'bg-(--d-accent-soft) text-(--d-accent-text)' : 'text-(--d-faint-text)'"
        >{{ t('quickPick.count', { count: checked.size, max: pickMany.max }) }}</span>
      </label>
      <!-- VS Code's canSelectMany OK button, so a pointer alone can accept the checked rows -->
      <Button
        v-if="pickMany"
        ref="okButton"
        type="button"
        size="sm"
        data-testid="quick-pick-ok"
        :disabled="checked.size === 0"
        :aria-describedby="`${listId}-count`"
        class="h-8 shrink-0 rounded-lg px-3 text-12 font-semibold"
        @focus="focusedPart = 'ok'"
        @keydown="onPickManyKeydown($event, 'ok')"
        @click="acceptChecked"
      >
        {{ t('quickPick.ok') }}
      </Button>
    </div>
    <Transition name="t-swap-box">
      <p
        v-if="hintText"
        :key="hintText"
        data-testid="quick-pick-hint"
        class="flex items-center gap-1.5 px-2 pt-1.5 pb-0.5 text-11.5 text-(--d-faint-text)"
      >
        <CornerDownLeft
          v-if="model.hint"
          aria-hidden="true"
          class="size-3 shrink-0"
        /><span class="min-w-0">{{ hintText }}</span>
      </p>
    </Transition>
    <div
      v-bind="containerProps"
      :id="listId"
      role="listbox"
      :aria-multiselectable="pickMany ? 'true' : undefined"
      :aria-activedescendant="listFocused ? activeDescendant : undefined"
      :tabindex="pickMany ? -1 : undefined"
      :aria-label="label"
      data-testid="quick-pick-list"
      class="quick-pick-list mt-1 max-h-80 overflow-x-hidden overscroll-contain outline-none"
      @scroll="onListScroll"
      @focus="focusedPart = 'list'"
      @keydown="onPickManyKeydown($event, 'list')"
    >
      <div
        ref="wrapper"
        v-bind="wrapperProps"
        class="relative"
      >
        <!-- the ring marks the active row while the list itself has keyboard focus -->
        <SlidingIndicator
          :class="listFocused ? 'text-(--d-accent)' : 'text-(--d-accent-soft)'"
          :box="box"
          :radius="7"
          :animate="animate"
          :variant="listFocused ? 'ring' : 'soft'"
        />
        <template
          v-for="{ data: row, index } in visible"
          :key="row.kind === 'item' ? `item:${row.item.id}` : `separator:${index}`"
        >
          <div
            v-if="row.kind === 'separator'"
            role="presentation"
            :data-testid="row.label === '' ? 'quick-pick-rule' : 'quick-pick-group'"
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
            :aria-label="optionName(row.item, index)"
            :aria-selected="pickMany ? undefined : index === activeRow"
            :aria-disabled="row.item.disabled || blocked(row.item) ? 'true' : undefined"
            :aria-keyshortcuts="row.item.shortcut ? ariaKeyshortcuts(row.item.shortcut) : undefined"
            :aria-checked="pickMany ? (row.item.disabled ? undefined : checked.has(row.item.id)) : row.item.checked"
            class="relative flex items-center gap-2.25 rounded-7 px-2"
            :class="[
              row.item.disabled ? 'cursor-default opacity-50' : blocked(row.item) ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
              entering === 'forward' && entrySteps.has(row.item.id) ? 'animate-[d-pane-in_.2s_var(--ease-out)_both] [animation-delay:calc(var(--enter-step)*14ms)]' : '',
              entering === 'back' && entrySteps.has(row.item.id) ? 'animate-[d-slide_.2s_var(--ease-out)_both] [animation-delay:calc(var(--enter-step)*14ms)]' : '',
            ]"
            :style="{ height: `${rowHeight(row)}px`, ...(entrySteps.has(row.item.id) ? { '--enter-step': entrySteps.get(row.item.id) } : {}) }"
            @pointermove="onPointerMove($event, index)"
            @mousedown.prevent
            @click="pickMany ? toggle(index) : accept(index, $event.shiftKey)"
          >
            <!-- The option itself is the checkbox (aria-checked); a checkbox control inside an option would nest interactives. -->
            <span
              v-if="pickMany && !row.item.disabled"
              aria-hidden="true"
              data-testid="quick-pick-checkbox"
              :data-checked="checked.has(row.item.id) ? 'true' : undefined"
              class="quick-pick-checkbox flex size-3.5 shrink-0 items-center justify-center rounded-sm border"
            >
              <Check class="quick-pick-check size-2.75 stroke-3" />
            </span>
            <span
              v-else-if="pickMany"
              aria-hidden="true"
              class="size-3.5 shrink-0"
            />
            <FileIcon
              v-if="row.item.file !== undefined"
              :path="row.item.file"
              :directory="row.item.folder === true"
              data-testid="quick-pick-file-icon"
              :data-directory="row.item.folder ? 'true' : undefined"
              class="size-3.25 shrink-0"
            />
            <span
              v-else-if="row.item.icon"
              class="relative flex shrink-0"
            >
              <component
                :is="row.item.icon"
                aria-hidden="true"
                class="size-3.25"
                :style="{ color: row.item.iconColor }"
              />
              <!-- the ring matches the pick's background, so the dot reads apart from the icon's strokes -->
              <span
                v-if="row.item.iconDot"
                aria-hidden="true"
                data-testid="quick-pick-icon-dot"
                class="absolute -right-0.75 -bottom-0.5 size-1.75 rounded-full bg-(--tone) ring-2 ring-(--d-card)"
                :class="row.item.iconDot.class"
                :style="row.item.iconDot.style"
              />
            </span>
            <span
              class="shrink-0 whitespace-nowrap"
              :class="row.item.mono ? 'font-mono text-12' : 'text-12.5'"
            >
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
              v-if="row.item.checked && !pickMany"
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
            <span
              v-if="row.item.hint"
              data-testid="quick-pick-item-hint"
              class="shrink-0 font-mono text-10.5 text-(--d-faint-text)"
            >{{ row.item.hint }}</span>
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
      v-if="loaded && rows.length === 0 && model.failure"
      role="alert"
      data-testid="quick-pick-failed"
      class="px-2 py-3 text-center text-12 text-(--d-danger-text)"
    >
      {{ model.failure }}
    </p>
    <!-- One live region for the pick's life, so the text that appears in it (Detecting shells…, no matches) is announced. -->
    <div
      role="status"
      data-testid="quick-pick-status"
    >
      <p
        v-if="loaded && rows.length === 0 && !model.failure"
        data-testid="quick-pick-empty"
        class="animate-[d-fade_.16s_var(--ease-out)] px-2 py-3 text-center text-12 text-(--d-faint)"
      >
        {{ model.empty ?? emptyText ?? t('overlay.noMatches') }}
      </p>
    </div>
  </div>
</template>
