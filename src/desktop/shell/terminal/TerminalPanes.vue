<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useElementSize } from '@vueuse/core';
import { remPx } from '@/composables/useRemPx';
import type { DamoclesShellApi, ShellPlatform } from '../../preload/shell-channels';
import { MIN_TERMINAL_PANE_FRACTION, type TerminalGroupInfo, type TerminalState } from '../../preload/terminal-channels';
import Sash from '../layout/Sash.vue';
import { equalSizes, moveSash, paneMinPx, paneOffsets, RESIZE_PANE_CELLS, resizePaneWidths, TERMINAL_PANE_MIN_REM, toFractions } from './terminal-split';
import TerminalView from './TerminalView.vue';

// Every terminal's view, each in its group's pane box; only the active group's panes show, side by side, with a sash
// between each two. A view never moves to another parent, so a split or unsplit keeps its xterm.
const props = defineProps<{ api: DamoclesShellApi; terminal: TerminalState; platform: ShellPlatform; splitShortcut: string }>();
const { t } = useI18n();

const root = ref<HTMLElement | null>(null);
const { width } = useElementSize(root);

const activeGroup = computed(() => {
  const activeId = props.terminal.activeId;
  return activeId === null ? null : props.terminal.groups.find((group) => group.paneIds.includes(activeId)) ?? null;
});
const multi = computed(() => (activeGroup.value?.paneIds.length ?? 0) > 1);
const titles = computed(() => new Map(props.terminal.terminals.map((terminal) => [terminal.id, terminal.title])));

// Sizes the user moved to, shown until main publishes the group again, so a pane never snaps back in between.
const held = shallowRef<{ readonly groupId: string; readonly sizes: readonly number[] } | null>(null);
// A drag's sizes not yet sent; the sash's commit sends them.
let unsent = false;
const published = computed(() => new Map(props.terminal.groups.map((group) => [group.id, `${group.paneIds.join(' ')}|${group.sizes.join(' ')}`])));
watch(published, (next, before) => {
  const id = held.value?.groupId;
  if (id === undefined || next.get(id) === before.get(id)) return;
  held.value = null;
  unsent = false;
});

function sizesOf(group: TerminalGroupInfo): readonly number[] {
  const hold = held.value;
  return hold?.groupId === group.id && hold.sizes.length === group.paneIds.length ? hold.sizes : group.sizes;
}

const pct = (fraction: number): string => `${Math.round(fraction * 1e6) / 1e4}%`;

// Each pane's left edge and width as fractions of the area.
const boxes = computed(() => {
  const out = new Map<string, { readonly left: number; readonly width: number }>();
  for (const group of props.terminal.groups) {
    const sizes = sizesOf(group);
    const offsets = paneOffsets(sizes);
    group.paneIds.forEach((id, index) => out.set(id, { left: offsets[index] ?? 0, width: sizes[index] ?? 0 }));
  }
  return out;
});

const shown = (id: string): boolean => activeGroup.value?.paneIds.includes(id) === true;

function boxStyle(id: string): Record<string, string> {
  const box = boxes.value.get(id);
  return box ? { left: pct(box.left), width: pct(box.width) } : { left: '0%', width: '100%' };
}

const minPx = computed(() => paneMinPx(width.value, Math.max(1, activeGroup.value?.paneIds.length ?? 1), remPx(TERMINAL_PANE_MIN_REM), MIN_TERMINAL_PANE_FRACTION));
const widthsOf = (group: TerminalGroupInfo): number[] => sizesOf(group).map((size) => size * width.value);

function send(group: TerminalGroupInfo, sizes: readonly number[]): void {
  held.value = { groupId: group.id, sizes };
  unsent = false;
  props.api.terminal.resizePanes({ groupId: group.id, sizes: [...sizes] });
}

const sashes = computed(() => {
  const group = activeGroup.value;
  if (!group || width.value <= 0) return [];
  const sizes = sizesOf(group);
  const offsets = paneOffsets(sizes);
  return group.paneIds.slice(0, -1).map((left, index) => {
    const right = group.paneIds[index + 1]!;
    const after = 1 - (offsets[index + 1] ?? 1);
    return {
      key: `${left}|${right}`,
      index,
      offset: offsets[index + 1] ?? 1,
      controls: `terminal-pane-${left} terminal-pane-${right}`,
      label: t('terminal.split.resize', { left: titles.value.get(left) ?? left, right: titles.value.get(right) ?? right }),
      valueText: t('terminal.split.sizes', { left: titles.value.get(left) ?? left, leftPercent: Math.round((sizes[index] ?? 0) * 100), right: titles.value.get(right) ?? right, rightPercent: Math.round((sizes[index + 1] ?? 0) * 100) }),
      value: Math.round(after * width.value),
      min: Math.round((group.paneIds.length - index - 1) * minPx.value),
      max: Math.round(width.value - (index + 1) * minPx.value),
    };
  });
});

function onSashResize(index: number, rightPx: number): void {
  const group = activeGroup.value;
  if (!group) return;
  held.value = { groupId: group.id, sizes: toFractions(moveSash(widthsOf(group), index, rightPx, minPx.value)) };
  unsent = true;
}

function onSashCommit(): void {
  const group = activeGroup.value;
  const hold = held.value;
  if (!group || !unsent || hold?.groupId !== group.id) return;
  send(group, hold.sizes);
}

function resetSizes(): void {
  const group = activeGroup.value;
  if (group) send(group, equalSizes(group.paneIds.length));
}

// Main's Resize Pane Left or Right for this pane: VS Code's four cells of its own font.
function resizePane(id: string, direction: 'left' | 'right', cellPx: number): void {
  const group = props.terminal.groups.find((candidate) => candidate.paneIds.includes(id));
  if (!group || group.paneIds.length < 2 || width.value <= 0) return;
  send(group, toFractions(resizePaneWidths(widthsOf(group), group.paneIds.indexOf(id), direction, RESIZE_PANE_CELLS * cellPx, minPx.value)));
}

// A click or Tab into a pane of the shown group makes it the active pane; main's own focus already did.
function choose(id: string): void {
  if (id !== props.terminal.activeId) props.api.terminal.select(id);
}

// A pane that joined the shown group grows in; one that left it fades out where it stood. A switch to another group,
// a restore and a new single terminal show at once.
const entering = shallowRef<ReadonlySet<string>>(new Set());
const ghosts = shallowRef<ReadonlyArray<{ readonly key: string; readonly left: number; readonly width: number }>>([]);
let ghostSeq = 0;
watch(() => {
  const group = activeGroup.value;
  return group ? { id: group.id, paneIds: [...group.paneIds], boxes: group.paneIds.map((id) => boxes.value.get(id)) } : null;
}, (next, before) => {
  if (!next || !before || next.id !== before.id) return;
  const joined = next.paneIds.filter((id) => !before.paneIds.includes(id));
  if (joined.length > 0) entering.value = new Set([...entering.value, ...joined]);
  const left = before.paneIds.flatMap((id, index) => (next.paneIds.includes(id) ? [] : [{ key: `${id}#${++ghostSeq}`, left: before.boxes[index]?.left ?? 0, width: before.boxes[index]?.width ?? 0 }]));
  if (left.length > 0) ghosts.value = [...ghosts.value, ...left];
});

function entered(id: string): void {
  const next = new Set(entering.value);
  next.delete(id);
  entering.value = next;
}

function faded(key: string): void {
  ghosts.value = ghosts.value.filter((ghost) => ghost.key !== key);
}
</script>

<template>
  <div
    ref="root"
    class="absolute inset-0 overflow-hidden"
  >
    <div
      v-for="item in terminal.terminals"
      v-show="shown(item.id)"
      :id="`terminal-pane-${item.id}`"
      :key="item.id"
      data-testid="terminal-pane-box"
      :data-terminal-id="item.id"
      :data-active="multi && item.id === terminal.activeId ? 'true' : undefined"
      class="terminal-pane absolute inset-y-0"
      :class="{ 'terminal-pane-enter': entering.has(item.id) }"
      :style="boxStyle(item.id)"
      @pointerdown.capture="choose(item.id)"
      @focusin="choose(item.id)"
      @animationend.self="entered(item.id)"
    >
      <TerminalView
        :api="api"
        :terminal="item"
        :shown="shown(item.id)"
        :settings="terminal.settings"
        :pass-keys="terminal.passKeys"
        :platform="platform"
        :split-shortcut="splitShortcut"
        :screen-reader="terminal.screenReader"
        :windows-build="terminal.windowsBuild"
        @resize-pane="(direction: 'left' | 'right', cellPx: number) => resizePane(item.id, direction, cellPx)"
      />
    </div>
    <div
      v-for="ghost in ghosts"
      :key="ghost.key"
      aria-hidden="true"
      data-testid="terminal-pane-ghost"
      class="terminal-pane-ghost pointer-events-none absolute inset-y-0 bg-(--d-bg)"
      :style="{ left: pct(ghost.left), width: pct(ghost.width) }"
      @animationend="faded(ghost.key)"
    />
    <Sash
      v-for="sash in sashes"
      :key="sash.key"
      orientation="vertical"
      data-testid="terminal-pane-sash"
      class="absolute inset-y-0 w-1.25"
      :style="{ left: `calc(${pct(sash.offset)} - 0.15625rem)` }"
      :aria-controls="sash.controls"
      :label="sash.label"
      :title="t('terminal.resizeListHint')"
      :value="sash.value"
      :value-text="sash.valueText"
      :min="sash.min"
      :max="sash.max"
      @resize="onSashResize(sash.index, $event)"
      @commit="onSashCommit"
      @dblclick="resetSizes"
    />
  </div>
</template>
