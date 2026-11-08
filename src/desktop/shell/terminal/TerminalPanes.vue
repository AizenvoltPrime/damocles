<script setup lang="ts">
import { computed, inject, ref, shallowRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useElementSize } from '@vueuse/core';
import { Ban } from 'lucide-vue-next';
import { remPx } from '@/composables/useRemPx';
import { authorityKeyOfProject } from '@shared/project-location';
import type { DamoclesShellApi, ShellHost, ShellPlatform } from '../../preload/shell-channels';
import { MAX_TERMINAL_GROUP_PANES, MIN_TERMINAL_PANE_FRACTION, type TerminalDropSide, type TerminalGroupInfo, type TerminalInfo, type TerminalState } from '../../preload/terminal-channels';
import Sash from '../layout/Sash.vue';
import { draggedTerminal, endTerminalDrag, paneDropSide, terminalDragOf, terminalDropOf } from './terminal-drag';
import { moveLanded, TERMINAL_STORE } from './terminal-store';
import { equalSizes, moveSash, paneMinPx, paneOffsets, RESIZE_PANE_CELLS, resizePaneWidths, TERMINAL_PANE_MIN_REM, toFractions } from './terminal-split';
import TerminalView from './TerminalView.vue';

// Every terminal's view, each in its group's pane box; only the active group's panes show, side by side, with a sash
// between each two. A view never remounts, so a split, unsplit or move keeps its xterm: an editor terminal's view is
// teleported into its editor tab's host, the same element moving as VS Code's attachToElement moves it.
// hosts: the saved SSH hosts, whose reconnect phase a remote terminal's label and dim wait on
const props = defineProps<{ api: DamoclesShellApi; terminal: TerminalState; platform: ShellPlatform; splitShortcut: string; hosts: readonly ShellHost[] }>();
const hostOf = (projectKey: string | null): ShellHost | undefined => (projectKey === null ? undefined : props.hosts.find((host) => host.authorityKey === authorityKeyOfProject(projectKey)));
const { t } = useI18n();
const store = inject(TERMINAL_STORE)!;

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

// The teleport target is the host element itself, never a selector: Teleport resolves a selector once, at mount, and a
// panel terminal mounts before its editor host exists. Null keeps the view in its pane box.
function editorHost(terminal: TerminalInfo): HTMLElement | null {
  return terminal.placement === 'editor' ? store.editorHosts.value.get(terminal.id) ?? null : null;
}

const shown = (id: string): boolean => activeGroup.value?.paneIds.includes(id) === true;
const viewShown = (terminal: TerminalInfo): boolean => (terminal.placement === 'editor' ? editorHost(terminal) !== null && store.editorShown.value === terminal.id : shown(terminal.id));

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

// A terminal dragged over a shown pane joins that pane's group on the half under the pointer (VS Code's
// TerminalInstanceDragAndDropController). A worktree Setup task on either side, or a full group the terminal is not in,
// refuses it, as main's join does; its own pane and the half beside its own place take nothing.
type JoinRefusal = 'task' | 'full';
const paneDrop = shallowRef<{ readonly paneId: string; readonly side: TerminalDropSide; readonly refused: JoinRefusal | null } | null>(null);
watch(draggedTerminal, (id) => {
  if (id === null) paneDrop.value = null;
});

function refusesJoin(id: string, paneId: string): JoinRefusal | null {
  if ([id, paneId].some((candidate) => props.terminal.terminals.find((terminal) => terminal.id === candidate)?.task === true)) return 'task';
  const group = props.terminal.groups.find((candidate) => candidate.paneIds.includes(paneId));
  return group !== undefined && group.paneIds.length >= MAX_TERMINAL_GROUP_PANES && !group.paneIds.includes(id) ? 'full' : null;
}

function onPaneDragOver(event: DragEvent, paneId: string): void {
  const id = terminalDragOf(event);
  if (id === null || id === paneId) return;
  const side = paneDropSide((event.currentTarget as HTMLElement).getBoundingClientRect(), event.clientX);
  const refused = refusesJoin(id, paneId);
  if (refused === null && moveLanded(props.terminal, { kind: 'join', id, target: paneId, side })) {
    if (paneDrop.value?.paneId === paneId) paneDrop.value = null;
    return;
  }
  event.preventDefault();
  event.dataTransfer!.dropEffect = refused ? 'none' : 'move';
  const current = paneDrop.value;
  if (current?.paneId !== paneId || current.side !== side || current.refused !== refused) paneDrop.value = { paneId, side, refused };
}

function onPaneDragLeave(event: DragEvent, paneId: string): void {
  if (paneDrop.value?.paneId === paneId && !(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) paneDrop.value = null;
}

function onPaneDrop(event: DragEvent, paneId: string): void {
  paneDrop.value = null;
  const id = terminalDropOf(event);
  if (id === null) return;
  event.preventDefault();
  endTerminalDrag();
  if (id === paneId || refusesJoin(id, paneId) !== null) return;
  store.move({ kind: 'join', id, target: paneId, side: paneDropSide((event.currentTarget as HTMLElement).getBoundingClientRect(), event.clientX) });
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
      @dragenter="onPaneDragOver($event, item.id)"
      @dragover="onPaneDragOver($event, item.id)"
      @dragleave="onPaneDragLeave($event, item.id)"
      @drop="onPaneDrop($event, item.id)"
    >
      <Teleport
        defer
        :to="editorHost(item)"
        :disabled="editorHost(item) === null"
      >
        <TerminalView
          :api="api"
          :terminal="item"
          :shown="viewShown(item)"
          :settings="terminal.settings"
          :pass-keys="terminal.passKeys"
          :platform="platform"
          :split-shortcut="splitShortcut"
          :remote-host="hostOf(item.projectKey)"
          :screen-reader="terminal.screenReader"
          @resize-pane="(direction: 'left' | 'right', cellPx: number) => resizePane(item.id, direction, cellPx)"
        />
      </Teleport>
      <!-- After the view, so it paints above the xterm by DOM order. -->
      <Transition name="terminal-drop">
        <div
          v-if="paneDrop?.paneId === item.id"
          aria-hidden="true"
          data-testid="terminal-drop-overlay"
          :data-side="paneDrop.refused ? undefined : paneDrop.side"
          :data-refused="paneDrop.refused ? 'true' : undefined"
          class="terminal-drop-overlay"
        >
          <span
            v-if="paneDrop.refused"
            class="flex items-center gap-1.5 rounded-full border border-(--d-border2) bg-(--d-card) px-3 py-1 text-12 text-(--d-muted) shadow-(--d-shadow)"
          >
            <Ban
              aria-hidden="true"
              class="size-3.5 text-(--d-danger-text)"
            />{{ paneDrop.refused === 'task' ? t('terminal.arrange.task') : t('terminal.arrange.full', { max: MAX_TERMINAL_GROUP_PANES }) }}
          </span>
        </div>
      </Transition>
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
