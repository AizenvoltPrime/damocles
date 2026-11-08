<script setup lang="ts">
import { computed, inject, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useElementSize } from '@vueuse/core';
import { Columns2, LoaderCircle, Trash2 } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import SlidingIndicator from '@/components/SlidingIndicator.vue';
import { remPx } from '@/composables/useRemPx';
import { useSlidingIndicator, type IndicatorBox } from '@/composables/useSlidingIndicator';
import type { DamoclesShellApi, ShellPlatform } from '../../preload/shell-channels';
import { MAX_TERMINAL_GROUP_PANES, TERMINAL_LIST_DEFAULT_REM, TERMINAL_LIST_MAX_REM, TERMINAL_LIST_MIN_REM, type TerminalDropSide, type TerminalGroupInfo, type TerminalInfo } from '../../preload/terminal-channels';
import Sash from '../layout/Sash.vue';
import { prefersReducedMotion } from '@/utils/reducedMotion';
import { draggedTerminal, endTerminalDrag, leavePanelEnd, panelEndDrop, rowDropSide, startTerminalDrag, terminalDragOf, terminalDropOf } from './terminal-drag';
import { terminalGlyph } from './terminal-icons';
import { isShiftF10 } from './terminal-keys';
import { openTabMenu, terminalProjectLabel, terminalStatusLabel } from './terminal-menu';
import { moveLanded, TERMINAL_STORE } from './terminal-store';
import TerminalRename from './TerminalRename.vue';

// The vertical list of two or more terminals beside the active group (VS Code's terminal tabs list, terminalTabsList.ts),
// one row per pane in group order, resizable by its sash.
const props = defineProps<{
  api: DamoclesShellApi;
  platform: ShellPlatform;
  terminals: readonly TerminalInfo[];
  groups: readonly TerminalGroupInfo[];
  activeId: string | null;
  // main's Split Terminal key, which the row menu shows
  splitShortcut: string;
  widthRem: number;
  // px of the panel holding the list and the active terminal
  panelWidth: number;
}>();
const emit = defineEmits<{ select: [id: string]; kill: [id: string]; split: [id: string]; resize: [rem: number] }>();
const { t } = useI18n();
const store = inject(TERMINAL_STORE)!;

// rem the terminal itself keeps beside the list (the reference's 220px).
const TERMINAL_MIN_REM = 13.75;
// rem of the accent bar's inset from the row's top and bottom (the reference's 5px).
const BAR_INSET_REM = 0.3125;

const list = ref<HTMLElement | null>(null);
const dragRem = ref<number | null>(null);
const widthRem = computed(() => dragRem.value ?? props.widthRem);
const minPx = computed(() => remPx(TERMINAL_LIST_MIN_REM));
const maxPx = computed(() => Math.max(minPx.value, Math.min(remPx(TERMINAL_LIST_MAX_REM), props.panelWidth - remPx(TERMINAL_MIN_REM))));
const widthPx = computed(() => Math.min(Math.max(remPx(widthRem.value), minPx.value), maxPx.value));
// Each pane's place in its group, which a row of a multi-pane group draws as a tree and a screen reader hears.
const places = computed(() => {
  const out = new Map<string, { readonly index: number; readonly count: number; readonly groupId: string }>();
  for (const group of props.groups) group.paneIds.forEach((id, index) => out.set(id, { index, count: group.paneIds.length, groupId: group.id }));
  return out;
});
const activeGroupId = computed(() => (props.activeId === null ? undefined : places.value.get(props.activeId)?.groupId));

// VS Code's prefixes: ┌ on a group's first pane, ├ between, └ on its last.
function treeOf(id: string): 'first' | 'middle' | 'last' | null {
  const place = places.value.get(id);
  if (!place || place.count < 2) return null;
  return place.index === 0 ? 'first' : place.index === place.count - 1 ? 'last' : 'middle';
}

const spansProjects = computed(() => new Set(props.terminals.map((terminal) => terminal.projectKey)).size > 1);

function onResize(px: number): void {
  dragRem.value = px / remPx(1);
}

// The dragged width holds until main publishes the width it stored, so the list never snaps back in between.
function onCommit(): void {
  if (dragRem.value !== null) emit('resize', dragRem.value);
}
watch(() => props.widthRem, () => {
  dragRem.value = null;
});

function resetWidth(): void {
  dragRem.value = TERMINAL_LIST_DEFAULT_REM;
  emit('resize', TERMINAL_LIST_DEFAULT_REM);
}

// The active row by its own attribute, never by position: a killed row stays in the list while it leaves.
const ROW = '[data-terminal-row]:not(.terminal-row-leave-active)';
const activeIndex = computed(() => props.terminals.findIndex((terminal) => terminal.id === props.activeId));
const { box, animate, measure } = useSlidingIndicator(list, ROW, activeIndex);
watch(() => props.terminals.map((terminal) => terminal.id).join('\n'), () => void nextTick(measure));
const { width: listWidth } = useElementSize(list);
watch(listWidth, () => void nextTick(measure));
// The reference's active row: a hover-tinted box with a 2px accent bar inset at its left edge; both slide by transform.
const barBox = shallowRef<IndicatorBox | null>(null);
watch(box, (row) => {
  const inset = remPx(BAR_INSET_REM);
  barBox.value = row ? { x: row.x, y: row.y + inset, width: remPx(0.125), height: Math.max(0, row.height - 2 * inset) } : null;
});

function rowElement(id: string | undefined): HTMLElement | null {
  return id === undefined ? null : list.value?.querySelector<HTMLElement>(`[data-terminal-row][data-terminal-id="${CSS.escape(id)}"]`) ?? null;
}

function openMenu(terminal: TerminalInfo, anchor: { x: number; y: number; width: number; height: number }): void {
  void openTabMenu({ api: props.api, store, t, platform: props.platform }, terminal, { panes: places.value.get(terminal.id)?.count ?? 0, shortcut: props.splitShortcut }, anchor);
}

// By layout offsets rather than scrollIntoView, which would measure a moved row where its slide's transform still holds it.
function revealRow(row: HTMLElement): void {
  const scroller = list.value;
  if (!scroller) return;
  const top = row.offsetTop;
  const bottom = top + row.offsetHeight;
  const next = top < scroller.scrollTop ? top : bottom > scroller.scrollTop + scroller.clientHeight ? bottom - scroller.clientHeight : null;
  if (next !== null) scroller.scrollTo({ top: next, behavior: prefersReducedMotion() ? 'instant' : 'smooth' });
}

// A move reorders the rows in the DOM, which takes focus from a moved row; the row the keyboard stood on gets it back.
watch(() => props.terminals.map((terminal) => terminal.id).join('\n'), () => {
  const focused = document.activeElement;
  const id = focused instanceof HTMLElement && focused.matches('[data-terminal-row]') && list.value?.contains(focused) ? focused.dataset.terminalId : undefined;
  if (id !== undefined) {
    void nextTick(() => {
      const element = rowElement(id);
      if (!element) return;
      if (document.activeElement !== element) element.focus({ preventScroll: true });
      revealRow(element);
    });
  }
}, { flush: 'pre' });

function onContextMenu(event: MouseEvent, terminal: TerminalInfo): void {
  event.preventDefault();
  openMenu(terminal, { x: event.clientX, y: event.clientY, width: 0, height: 0 });
}

// Arrow keys move focus along the list (roving tabindex); Enter or Space shows the terminal, Delete kills it, F2 renames
// it and Shift+F10 opens its menu under the row. The menu key reaches onContextMenu as the browser's contextmenu event.
function onKeydown(event: KeyboardEvent, index: number, terminal: TerminalInfo): void {
  const count = props.terminals.length;
  // Alt+Up and Alt+Down move the row (VS Code's list has no key for it; the Projects list uses these).
  if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
    if (event.ctrlKey || event.metaKey || event.shiftKey) return;
    const delta = event.key === 'ArrowUp' ? -1 : 1;
    if (index + delta >= 0 && index + delta < count) store.move({ kind: 'step', id: terminal.id, delta });
    event.preventDefault();
    return;
  }
  const target = ({ ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: count - 1 } as Record<string, number>)[event.key];
  if (target !== undefined) rowElement(props.terminals[(target + count) % count]?.id)?.focus();
  else if (event.key === 'Enter' || event.key === ' ') emit('select', terminal.id);
  else if (event.key === 'Delete') emit('kill', terminal.id);
  else if (event.key === 'F2' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) store.startRename(terminal.id, 'tab');
  else if (isShiftF10(event)) {
    const row = (event.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(terminal, { x: row.left, y: row.top, width: row.width, height: row.height });
  } else return;
  event.preventDefault();
}

// Native drag and drop (VS Code's TerminalTabsDragAndDrop): a row dropped on another row's upper or lower half moves before or
// after it, below the last row it leaves its group for one of its own at the end. The line shows where it lands: beside the
// target row within its own group, else at the edge of the target's group, which the dragged row's whole group moves past.
type ListDrop = { readonly kind: 'reorder'; readonly target: string; readonly side: TerminalDropSide } | { readonly kind: 'detach' };
const dropLine = shallowRef<{ readonly y: number; readonly kind: ListDrop['kind'] } | null>(null);

function rowsInOrder(): HTMLElement[] {
  return [...(list.value?.querySelectorAll<HTMLElement>(ROW) ?? [])];
}

// The row under clientY, or null below the last row.
function rowAt(rows: readonly HTMLElement[], clientY: number): HTMLElement | null {
  const last = rows.at(-1);
  if (!last || clientY >= last.getBoundingClientRect().bottom) return null;
  return rows.find((candidate) => clientY < candidate.getBoundingClientRect().bottom) ?? rows[0]!;
}

const endY = (rows: readonly HTMLElement[]): number => {
  const last = rows.at(-1);
  return last ? last.offsetTop + last.offsetHeight : 0;
};

// null where a drop changes nothing: the dragged row's own row, the halves beside its own place, and below the rows for a
// terminal already alone at the end
function dropAt(id: string, clientY: number): { readonly drop: ListDrop; readonly y: number } | null {
  const rows = rowsInOrder();
  if (rows.length === 0) return null;
  const row = rowAt(rows, clientY);
  if (!row) return moveLanded(store.state.value, { kind: 'detach', id }) ? null : { drop: { kind: 'detach' }, y: endY(rows) };
  const target = row.dataset.terminalId!;
  const side = rowDropSide(row.getBoundingClientRect(), clientY);
  if (moveLanded(store.state.value, { kind: 'reorder', id, target, side })) return null;
  const targetGroup = places.value.get(target)?.groupId;
  const landing = targetGroup === places.value.get(id)?.groupId ? [target] : props.groups.find((group) => group.id === targetGroup)?.paneIds ?? [target];
  const edgeRow = rowElement(side === 'before' ? landing[0] : landing.at(-1)) ?? row;
  return { drop: { kind: 'reorder', target, side }, y: edgeRow.offsetTop + (side === 'before' ? 0 : edgeRow.offsetHeight) };
}

// Over the header strip the line marks the end of the list, where the terminal lands.
const shownLine = computed(() => dropLine.value ?? (panelEndDrop.value === 'header' ? { y: endY(rowsInOrder()), kind: 'detach' as const } : null));

// Hovering a row during a drag shows its terminal after a moment, so a pane of another group can take the drop (VS Code's 500 ms).
const REVEAL_MS = 500;
let revealTimer: ReturnType<typeof setTimeout> | undefined;
let revealTarget: string | undefined;

function stopReveal(): void {
  clearTimeout(revealTimer);
  revealTimer = undefined;
  revealTarget = undefined;
}
onBeforeUnmount(stopReveal);

function onDragStart(event: DragEvent, terminal: TerminalInfo): void {
  startTerminalDrag(event, terminal.id);
}

function onDragEnd(): void {
  endTerminalDrag();
  dropLine.value = null;
  stopReveal();
}

// The area below the rows is a part of the panel's end target; a drop that changes nothing is not taken.
function onListDragOver(event: DragEvent): void {
  const id = terminalDragOf(event);
  if (id === null) return;
  const at = dropAt(id, event.clientY);
  dropLine.value = at ? { y: at.y, kind: at.drop.kind } : null;
  if (at) {
    event.preventDefault();
    event.dataTransfer!.dropEffect = 'move';
  }
  if (at?.drop.kind === 'detach') panelEndDrop.value = 'list';
  else leavePanelEnd('list');
  const under = rowAt(rowsInOrder(), event.clientY)?.dataset.terminalId;
  const hovered = under === id ? undefined : under;
  if (hovered === revealTarget) return;
  stopReveal();
  if (hovered === undefined || hovered === props.activeId) return;
  revealTarget = hovered;
  revealTimer = setTimeout(() => {
    revealTimer = undefined;
    props.api.terminal.select(hovered);
  }, REVEAL_MS);
}

function onListDragLeave(event: DragEvent): void {
  if (list.value?.contains(event.relatedTarget as Node | null)) return;
  dropLine.value = null;
  leavePanelEnd('list');
  stopReveal();
}

function onListDrop(event: DragEvent): void {
  dropLine.value = null;
  stopReveal();
  const id = terminalDropOf(event);
  if (id === null) return;
  event.preventDefault();
  endTerminalDrag();
  const drop = dropAt(id, event.clientY)?.drop;
  if (drop?.kind === 'detach') store.move({ kind: 'detach', id });
  else if (drop) store.move({ kind: 'reorder', id, target: drop.target, side: drop.side });
}

// Main's computed title, the working directory's folder when it is not the project's, and the project.
const rowTitle = (terminal: TerminalInfo): string => [terminal.title, terminal.description, terminalProjectLabel(terminal, t)].filter((part) => part).join(' · ');

// VS Code's splitTerminalAriaLabel: a pane of a multi-pane group says where it sits.
function splitLabel(id: string): string {
  const place = places.value.get(id);
  return place && place.count > 1 ? t('terminal.split.position', { index: place.index + 1, count: place.count }) : '';
}

// role="tab" makes a row's content presentational, so the row names itself without its buttons' labels.
const tabLabel = (terminal: TerminalInfo): string => [terminal.title, terminal.description, spansProjects.value ? terminalProjectLabel(terminal, t) : '', splitLabel(terminal.id), terminalStatusLabel(terminal, t)].filter((part) => part).join(', ');
</script>

<template>
  <div
    data-testid="terminal-list"
    class="relative flex shrink-0 flex-col border-l border-(--d-border) bg-(--d-panel)"
    :style="{ width: `${widthPx}px` }"
  >
    <Sash
      orientation="vertical"
      data-testid="terminal-list-sash"
      class="absolute inset-y-0 -left-[0.15625rem] w-1.25"
      :label="t('terminal.resizeList')"
      :title="t('terminal.resizeListHint')"
      :value="widthPx"
      :min="minPx"
      :max="maxPx"
      @resize="onResize"
      @commit="onCommit"
      @dblclick="resetWidth"
    />
    <div
      ref="list"
      role="tablist"
      aria-orientation="vertical"
      :aria-label="t('terminal.listLabel')"
      :data-drop="panelEndDrop ? 'true' : undefined"
      class="terminal-list relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto p-1"
      @dragenter="onListDragOver"
      @dragover="onListDragOver"
      @dragleave="onListDragLeave"
      @drop="onListDrop"
    >
      <SlidingIndicator
        class="text-(--d-hover)"
        :box="box"
        :radius="6"
        :animate="animate"
        variant="soft"
      />
      <SlidingIndicator
        class="text-(--d-accent)"
        data-testid="terminal-list-indicator"
        :box="barBox"
        :radius="1"
        :animate="animate"
      />
      <TransitionGroup name="terminal-row">
        <!-- A vertical tab row: no shadcn part draws a tab with a status mark and a hover-revealed kill button. -->
        <div
          v-for="(terminal, index) in terminals"
          :id="`terminal-row-${terminal.id}`"
          :key="terminal.id"
          data-terminal-row
          data-testid="terminal-row"
          :data-terminal-id="terminal.id"
          :data-status="terminal.status"
          role="tab"
          :aria-selected="terminal.id === activeId"
          :aria-controls="`terminal-panel-${terminal.id}`"
          :aria-label="tabLabel(terminal)"
          aria-keyshortcuts="Delete F2 Shift+F10 Alt+ArrowUp Alt+ArrowDown"
          :tabindex="terminal.id === activeId || (activeIndex < 0 && index === 0) ? 0 : -1"
          :title="rowTitle(terminal)"
          :draggable="store.renaming.value?.id !== terminal.id"
          :data-dragging="draggedTerminal === terminal.id ? 'true' : undefined"
          class="terminal-row group/row relative flex h-6.5 items-center gap-1.75 rounded-md pr-1 pl-3 outline-none select-none"
          :class="terminal.id === activeId ? 'text-(--d-text)' : 'text-(--d-muted) hover:bg-[color-mix(in_srgb,var(--d-hover)_55%,transparent)] hover:text-(--d-text)'"
          @click="emit('select', terminal.id)"
          @keydown="onKeydown($event, index, terminal)"
          @contextmenu="onContextMenu($event, terminal)"
          @dragstart="onDragStart($event, terminal)"
          @dragend="onDragEnd"
        >
          <span
            v-if="treeOf(terminal.id)"
            aria-hidden="true"
            data-testid="terminal-row-tree"
            :data-tree="treeOf(terminal.id)"
            class="terminal-tree absolute inset-y-0 left-1.5 w-1"
            :class="places.get(terminal.id)?.groupId === activeGroupId ? 'text-(--d-muted)' : 'text-(--d-faint)'"
          >
            <span
              class="absolute left-0 w-px bg-current"
              :class="{ first: 'top-1/2 bottom-0', middle: 'inset-y-0', last: 'top-0 bottom-1/2' }[treeOf(terminal.id)!]"
            />
            <span class="absolute top-1/2 left-0 h-px w-full bg-current" />
          </span>
          <span class="relative flex size-3.25 shrink-0 items-center justify-center">
            <LoaderCircle
              v-if="terminal.status === 'starting' || terminal.status === 'reconnecting'"
              aria-hidden="true"
              class="d-spinning size-3.25 text-(--d-muted)"
            />
            <component
              :is="terminalGlyph(terminal).icon"
              v-else
              aria-hidden="true"
              data-testid="terminal-row-icon"
              :data-glyph="terminal.customIcon ?? terminal.icon"
              :data-color="terminal.color ?? undefined"
              class="terminal-glyph size-3.25"
              :style="{ color: terminalGlyph(terminal).color }"
            />
            <span
              v-if="terminal.status !== 'starting' && terminal.status !== 'reconnecting'"
              aria-hidden="true"
              data-testid="terminal-row-status"
              class="terminal-status-dot absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full"
              :class="terminal.status === 'running' ? 'bg-(--d-success)' : terminal.exitCode === 0 ? 'bg-(--d-faint)' : 'bg-(--d-danger)'"
            />
          </span>
          <TerminalRename
            v-if="store.renaming.value?.id === terminal.id"
            :api="api"
            :terminal="terminal"
            class="text-xs"
            @done="rowElement(terminal.id)?.focus()"
          />
          <span
            v-else
            data-testid="terminal-row-title"
            class="min-w-0 flex-1 truncate text-xs"
          >{{ terminal.title }}</span>
          <span
            v-if="terminal.description"
            data-testid="terminal-row-description"
            class="max-w-[40%] shrink-0 truncate text-10.5 text-(--d-muted)"
          >{{ terminal.description }}</span>
          <span
            v-if="splitLabel(terminal.id)"
            class="sr-only"
            data-testid="terminal-row-split"
          >{{ splitLabel(terminal.id) }}</span>
          <span class="sr-only">{{ terminalStatusLabel(terminal, t) }}</span>
          <span
            v-if="spansProjects"
            data-testid="terminal-row-project"
            class="max-w-17 shrink-0 truncate font-mono text-10 text-(--d-faint-text)"
          >{{ terminalProjectLabel(terminal, t) }}</span>
          <Button
            variant="ghost"
            size="icon"
            tabindex="-1"
            data-testid="terminal-row-split-button"
            class="terminal-row-action d-press size-4.5 shrink-0 rounded-5 text-(--d-faint) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-2.75"
            :disabled="(places.get(terminal.id)?.count ?? 0) >= MAX_TERMINAL_GROUP_PANES"
            :aria-label="t('terminal.split.splitTitle', { title: terminal.title })"
            :title="t('terminal.split.splitHint', { shortcut: splitShortcut })"
            @click.stop="emit('split', terminal.id)"
          >
            <Columns2 aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            tabindex="-1"
            data-testid="terminal-row-kill"
            class="terminal-row-action d-press size-4.5 shrink-0 rounded-5 text-(--d-faint) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-2.75"
            :aria-label="t('terminal.kill', { title: terminal.title })"
            :title="t('terminal.killTitle')"
            @click.stop="emit('kill', terminal.id)"
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      </TransitionGroup>
      <Transition name="t-fade">
        <div
          v-if="shownLine"
          aria-hidden="true"
          data-testid="terminal-list-drop-line"
          :data-drop="shownLine.kind"
          class="terminal-drop-line pointer-events-none absolute inset-x-1 top-0 h-0.5 rounded-full bg-(--d-accent)"
          :style="{ transform: `translateY(${shownLine.y - 1}px)` }"
        />
      </Transition>
    </div>
  </div>
</template>
