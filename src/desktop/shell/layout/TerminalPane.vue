<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronDown, Columns2, Maximize2, Minimize2, Plus, X } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import type { OverlayMenuItem } from '../../preload/overlay-channels';
import type { DamoclesShellApi, ShellState } from '../../preload/shell-channels';
import { MAX_TERMINAL_GROUP_PANES, type TerminalInfo } from '../../preload/terminal-channels';
import { groupPanes, TERMINAL_STORE } from '../terminal/terminal-store';
import { terminalGlyph } from '../terminal/terminal-icons';
import { isShiftF10, isXtermInput } from '../terminal/terminal-keys';
import { openTabMenu, terminalStatusLabel } from '../terminal/terminal-menu';
import TerminalPanel from '../terminal/TerminalPanel.vue';
import TerminalRename from '../terminal/TerminalRename.vue';
import PaneGrip from './PaneGrip.vue';

// The terminal pane: the header strip (grip, title, the one terminal's tab or the active terminal's name beside the list,
// and the pane actions) over the terminals.
const props = defineProps<{ api: DamoclesShellApi; state: ShellState; maximized: boolean; hideShortcut: string }>();
const emit = defineEmits<{ toggleMaximize: []; hide: [] }>();
const { t } = useI18n();
const store = inject(TERMINAL_STORE)!;

const root = ref<HTMLElement | null>(null);
const maximizeLabel = computed(() => (props.maximized ? t('grid.terminal.restore') : t('grid.terminal.maximize')));
const terminals = computed(() => store.state.value?.terminals ?? []);
const active = computed(() => store.active.value);
const canCreate = computed(() => store.state.value?.canCreate === true);
const activeGlyph = computed(() => (active.value ? terminalGlyph(active.value) : null));
const tab = ref<HTMLElement | null>(null);
const newGroup = ref<HTMLElement | null>(null);
const newMenuOpen = ref(false);
// role="tab" makes the tab's content presentational, so it names itself without its Kill button's label.
const tabLabel = computed(() => (active.value ? [active.value.title, active.value.description, active.value.projectName, terminalStatusLabel(active.value, t)].filter((part) => part).join(', ') : ''));
const canSplit = computed(() => active.value !== null && groupPanes(store.state.value, active.value.id) < MAX_TERMINAL_GROUP_PANES);

// Shift+click starts the default profile in the current project; a plain click opens the new-terminal quick pick.
async function onNew(event: MouseEvent): Promise<void> {
  if (!event.shiftKey) {
    props.api.terminal.openNew();
    return;
  }
  const result = await props.api.terminal.create({ profileId: null, projectKey: null });
  if (result.ok) store.requestFocus(result.id);
}

// F6 parts: focus anywhere in the pane is the terminal part. The skip list and Edit › Paste apply only while that focus is an
// xterm's input, not a row, the tab or a field (Find, the inline rename), so main needs to know which.
function onFocusIn(event: FocusEvent): void {
  props.api.reportFocusedPart('terminal');
  props.api.terminal.reportInputFocus(isXtermInput(event.target));
}

function onFocusOut(event: FocusEvent): void {
  if (isXtermInput(event.target)) props.api.terminal.reportInputFocus(false);
  if (event.relatedTarget instanceof Node && root.value?.contains(event.relatedTarget)) return;
  props.api.reportFocusedPart(null);
}

// A kill removes the focused xterm, row or tab with its terminal; focus then goes to the new active pane, as in VS Code.
// Read before the DOM updates, while the killed terminal's elements still hold focus.
watch(() => store.state.value, (next) => {
  const focused = document.activeElement;
  const owner = focused instanceof HTMLElement && root.value?.contains(focused) ? focused.closest<HTMLElement>('[data-terminal-id]')?.dataset.terminalId : undefined;
  if (owner === undefined || !next?.activeId || next.terminals.some((terminal) => terminal.id === owner)) return;
  store.requestFocus(next.activeId);
}, { flush: 'pre' });

function focusTab(id: string): void {
  props.api.terminal.select(id);
  store.requestFocus(id);
}

function openMenu(terminal: TerminalInfo, anchor: { x: number; y: number; width: number; height: number }): void {
  void openTabMenu({ api: props.api, store, t, platform: props.state.platform }, terminal, { panes: groupPanes(store.state.value, terminal.id), shortcut: props.state.shortcuts.splitTerminal }, anchor);
}

function onTabContextMenu(event: MouseEvent, terminal: TerminalInfo): void {
  event.preventDefault();
  openMenu(terminal, { x: event.clientX, y: event.clientY, width: 0, height: 0 });
}

// Enter or Space shows the terminal, Delete kills it, F2 renames it and Shift+F10 opens its menu, as in the list; the menu
// key arrives as contextmenu.
function onTabKeydown(event: KeyboardEvent, terminal: TerminalInfo): void {
  if (event.key === 'Enter' || event.key === ' ') focusTab(terminal.id);
  else if (event.key === 'Delete') props.api.terminal.kill(terminal.id);
  else if (event.key === 'F2' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) store.startRename(terminal.id, 'tab');
  else if (isShiftF10(event)) {
    const tab = (event.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(terminal, { x: tab.left, y: tab.top, width: tab.width, height: tab.height });
  } else return;
  event.preventDefault();
}

// The New Terminal button's dropdown (VS Code's launch profile menu): each detected shell starts in the current project,
// and Select Default Profile... asks main's quick pick.
async function openNewMenu(): Promise<void> {
  const group = newGroup.value;
  const profiles = store.state.value?.profiles ?? [];
  if (!group || newMenuOpen.value) return;
  const rect = group.getBoundingClientRect();
  const items: OverlayMenuItem[] = [
    ...profiles.map((profile): OverlayMenuItem => ({ kind: 'item', id: `profile:${profile.id}`, label: profile.name, glyph: profile.customIcon ?? profile.icon, ...(profile.color ? { color: profile.color } : {}) })),
    ...(profiles.length > 0 ? [{ kind: 'separator' } as const] : []),
    { kind: 'item', id: 'selectDefaultProfile', label: t('terminal.newMenu.selectDefault') },
  ];
  newMenuOpen.value = true;
  try {
    const answer = await props.api.requestOverlay({ kind: 'menu', label: t('terminal.newMenu.label'), anchor: { x: rect.left, y: rect.top, width: rect.width, height: rect.height }, items });
    if (answer.kind !== 'menu') return;
    if (answer.itemId === 'selectDefaultProfile') {
      props.api.terminal.selectDefaultProfile();
      return;
    }
    const profile = profiles.find((option) => `profile:${option.id}` === answer.itemId);
    if (!profile) return;
    const result = await props.api.terminal.create({ profileId: profile.id, projectKey: null });
    if (result.ok) store.requestFocus(result.id);
  } finally {
    newMenuOpen.value = false;
  }
}
</script>

<template>
  <section
    ref="root"
    data-testid="terminal-pane"
    :aria-label="t('grid.terminal.title')"
    class="flex size-full min-h-0 min-w-0 flex-col bg-(--d-bg)"
    @focusin="onFocusIn"
    @focusout="onFocusOut"
  >
    <!-- The chat header's height (h-11.5), background and border, so the pane tops read as one row across the grid. -->
    <header class="flex h-11.5 shrink-0 items-stretch border-b border-(--d-border) bg-(--d-panel)">
      <span class="flex w-4 shrink-0 items-center justify-center">
        <PaneGrip
          pane="terminal"
          class="h-5 w-3"
        />
      </span>
      <h2 class="flex shrink-0 items-center pr-1.5 pl-0.5 text-11 font-semibold tracking-[.07em] text-(--d-muted) uppercase">
        {{ t('grid.terminal.title') }}
      </h2>
      <div class="relative flex min-w-0 flex-1 items-stretch">
        <Transition
          name="t-swap"
          mode="out-in"
        >
          <!-- The one terminal's tab, in the editor tab's look; no shadcn part draws a tab with a hover kill button. -->
          <div
            v-if="terminals.length === 1 && active"
            key="tab"
            role="tablist"
            :aria-label="t('terminal.listLabel')"
            class="flex min-w-0 items-stretch"
          >
            <div
              :id="`terminal-tab-${active.id}`"
              ref="tab"
              role="tab"
              aria-selected="true"
              :aria-controls="`terminal-panel-${active.id}`"
              :aria-label="tabLabel"
              aria-keyshortcuts="Delete F2 Shift+F10"
              tabindex="0"
              data-testid="terminal-tab"
              :data-terminal-id="active.id"
              :title="[active.title, active.description, active.projectName].filter((part) => part).join(' · ')"
              class="terminal-tab group/tab relative flex max-w-60 min-w-0 cursor-pointer items-center gap-1.75 border-x border-(--d-border) bg-(--d-bg) pr-1.5 pl-3 text-(--d-text) outline-none select-none"
              @click="focusTab(active.id)"
              @keydown="onTabKeydown($event, active)"
              @contextmenu="onTabContextMenu($event, active)"
            >
              <span
                aria-hidden="true"
                class="absolute inset-x-0 top-0 h-0.5 bg-(--d-accent)"
              />
              <component
                :is="activeGlyph?.icon"
                aria-hidden="true"
                data-testid="terminal-tab-icon"
                :data-glyph="active.customIcon ?? active.icon"
                :data-color="active.color ?? undefined"
                class="terminal-glyph size-3.25 shrink-0"
                :style="{ color: activeGlyph?.color }"
              />
              <TerminalRename
                v-if="store.renaming.value?.id === active.id"
                :api="api"
                :terminal="active"
                class="-mx-1.25 w-auto max-w-full flex-none text-12.5 field-sizing-content"
                @done="tab?.focus()"
              />
              <span
                v-else
                data-testid="terminal-tab-title"
                class="truncate text-12.5"
              >{{ active.title }}</span>
              <span
                v-if="active.description"
                data-testid="terminal-tab-description"
                class="max-w-30 shrink-0 truncate text-10.5 text-(--d-muted)"
              >{{ active.description }}</span>
              <span
                data-testid="terminal-tab-project"
                class="shrink-0 truncate font-mono text-10.5 text-(--d-faint-text)"
              >{{ active.projectName }}</span>
              <Button
                variant="ghost"
                size="icon"
                tabindex="-1"
                data-testid="terminal-tab-kill"
                class="terminal-tab-kill d-press size-4.5 shrink-0 rounded-5 text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) [&_svg]:size-3"
                :aria-label="t('terminal.kill', { title: active.title })"
                :title="t('terminal.killTitle')"
                @click.stop="api.terminal.kill(active.id)"
              >
                <X aria-hidden="true" />
              </Button>
            </div>
          </div>
          <p
            v-else-if="terminals.length > 1 && active"
            key="summary"
            data-testid="terminal-summary"
            class="flex min-w-0 items-center gap-1.5 px-1.5 text-xs whitespace-nowrap text-(--d-muted)"
          >
            <component
              :is="activeGlyph?.icon"
              aria-hidden="true"
              class="terminal-glyph size-3 shrink-0"
              :style="{ color: activeGlyph?.color }"
            />
            <span class="truncate text-(--d-text)">{{ active.title }}</span>
            <span
              v-if="active.description"
              class="shrink-0 truncate text-10.5 text-(--d-muted)"
            >{{ active.description }}</span>
            <span class="shrink-0 font-mono text-10.5 text-(--d-faint-text)">{{ active.projectName }}</span>
            <span class="shrink-0 text-10.5 text-(--d-faint-text)">· {{ t('terminal.count', { count: terminals.length }, terminals.length) }}</span>
          </p>
        </Transition>
      </div>
      <div class="flex shrink-0 items-center gap-0.5 px-1.5">
        <!-- VS Code's New Terminal split button: the main action and the launch profile dropdown, one hover group. -->
        <div
          ref="newGroup"
          role="group"
          :aria-label="t('terminal.new')"
          data-testid="terminal-new-group"
          class="terminal-new-group flex h-6.5 items-stretch rounded-md"
          :class="newMenuOpen ? 'bg-(--d-hover)' : ''"
        >
          <Button
            variant="ghost"
            size="icon"
            class="d-press h-full w-6.5 rounded-md rounded-r-none text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) [&_svg]:size-3.5"
            data-testid="terminal-new"
            :disabled="!canCreate"
            :aria-label="t('terminal.new')"
            :title="t('terminal.newTitle', { shortcut: state.shortcuts.newTerminal })"
            @click="onNew"
          >
            <Plus aria-hidden="true" />
          </Button>
          <span
            aria-hidden="true"
            class="terminal-new-divider my-1.5 w-px bg-(--d-border2)"
          />
          <Button
            variant="ghost"
            size="icon"
            class="d-press h-full w-4 rounded-md rounded-l-none text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) aria-expanded:text-(--d-text) [&_svg]:size-3"
            data-testid="terminal-new-menu"
            aria-haspopup="menu"
            :aria-expanded="newMenuOpen"
            :disabled="!canCreate"
            :aria-label="t('terminal.newMenu.button')"
            :title="t('terminal.newMenu.button')"
            @click="openNewMenu"
          >
            <ChevronDown aria-hidden="true" />
          </Button>
        </div>
        <!-- VS Code's Split Terminal toolbar button: splits the active pane, which main then focuses. -->
        <Button
          variant="ghost"
          size="icon"
          class="d-press size-6.5 rounded-md text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) [&_svg]:size-3.5"
          data-testid="terminal-split"
          :disabled="!canSplit"
          :aria-label="t('terminal.split.split')"
          :title="t('terminal.split.splitHint', { shortcut: state.shortcuts.splitTerminal })"
          @click="active && api.terminal.split(active.id)"
        >
          <Columns2 aria-hidden="true" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          class="d-press size-6.5 rounded-md text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) [&_svg]:size-3.5"
          data-testid="terminal-maximize"
          :aria-label="maximizeLabel"
          :title="maximizeLabel"
          :aria-pressed="maximized"
          @click="emit('toggleMaximize')"
        >
          <Minimize2
            v-if="maximized"
            aria-hidden="true"
          />
          <Maximize2
            v-else
            aria-hidden="true"
          />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          class="d-press size-6.5 rounded-md text-(--d-muted) hover:bg-(--d-hover) hover:text-(--d-text) [&_svg]:size-3.5"
          data-testid="terminal-hide"
          :aria-label="t('grid.terminal.hideName')"
          :title="t('grid.terminal.hide', { shortcut: hideShortcut })"
          @click="emit('hide')"
        >
          <X aria-hidden="true" />
        </Button>
      </div>
    </header>
    <TerminalPanel
      :api="api"
      :state="state"
    />
  </section>
</template>
