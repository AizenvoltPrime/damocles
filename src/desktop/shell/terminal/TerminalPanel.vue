<script setup lang="ts">
import { computed, inject, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useElementSize } from '@vueuse/core';
import { Plus, SquareTerminal } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import type { DamoclesShellApi, ShellState } from '../../preload/shell-channels';
import { draggedTerminal, panelEndDrop, panelEndTarget } from './terminal-drag';
import { panelTerminals, TERMINAL_STORE } from './terminal-store';
import TerminalPanes from './TerminalPanes.vue';
import TerminalList from './TerminalList.vue';

// The terminal pane's body: every terminal's view (the active group's panes shown), the list beside them once the panel
// holds two, or the empty state while it holds none, editor terminals aside.
const props = defineProps<{ api: DamoclesShellApi; state: ShellState }>();
const { t } = useI18n();
const store = inject(TERMINAL_STORE)!;

const root = ref<HTMLElement | null>(null);
const { width: panelWidth } = useElementSize(root);
const terminal = computed(() => store.state.value);
const terminals = computed(() => panelTerminals(terminal.value));

function select(id: string): void {
  props.api.terminal.select(id);
  store.requestFocus(id);
}

// The empty panel is a part of the panel's end target: an editor terminal's tab dropped there comes back into the panel, as
// Move Terminal into Panel does.
const emptyTarget = panelEndTarget('empty', store);
const emptyDrop = computed(() => (panelEndDrop.value === null ? null : terminal.value?.terminals.find((candidate) => candidate.id === draggedTerminal.value) ?? null));

// Announced politely once main's state shows the move the user made, wherever the moved terminal's row or tab is.
const announcement = ref('');
// A terminal moved into the editor area is announced by its editor tab, which takes focus.
watch(() => store.moved.value, async (moved) => {
  const state = store.state.value;
  const panel = panelTerminals(state);
  const position = moved ? panel.findIndex((candidate) => candidate.id === moved.id) : -1;
  if (!moved || !state || position < 0) return;
  const group = state.groups.find((candidate) => candidate.paneIds.includes(moved.id));
  const values = { title: panel[position]!.title, position: position + 1, count: panel.length, index: (group?.paneIds.indexOf(moved.id) ?? 0) + 1, panes: group?.paneIds.length ?? 1 };
  // emptied first, so a second identical move is announced again
  announcement.value = '';
  await nextTick();
  announcement.value = t(values.panes > 1 ? 'terminal.arrange.movedSplit' : 'terminal.arrange.moved', values);
});
</script>

<template>
  <div
    ref="root"
    class="flex min-h-0 flex-1"
  >
    <div class="relative min-w-0 flex-1">
      <TerminalPanes
        v-if="terminal"
        :api="api"
        :terminal="terminal"
        :platform="state.platform"
        :split-shortcut="state.shortcuts.splitTerminal"
        :hosts="state.hosts"
      />
      <Transition name="t-fade">
        <div
          v-if="terminal && terminals.length === 0"
          data-testid="terminal-empty"
          :data-drop="emptyDrop ? 'true' : undefined"
          class="terminal-empty pane-empty absolute inset-0 flex flex-col items-center justify-center gap-2.5 p-6 text-center"
          @dragenter="emptyTarget.over"
          @dragover="emptyTarget.over"
          @dragleave="emptyTarget.leave"
          @drop="emptyTarget.drop"
        >
          <span class="terminal-empty-icon flex size-10 items-center justify-center rounded-xl border border-(--d-border) bg-(--d-panel) text-(--d-faint)">
            <SquareTerminal
              aria-hidden="true"
              class="size-5"
            />
          </span>
          <p
            v-if="emptyDrop"
            data-testid="terminal-empty-drop"
            class="text-12.5 font-medium text-(--d-accent-text)"
          >
            {{ t('terminal.arrange.dropIntoPanel', { title: emptyDrop.title }) }}
          </p>
          <template v-else-if="terminal.canCreate">
            <p class="text-12.5 font-medium text-(--d-muted)">
              {{ t('grid.terminal.emptyTitle') }}
            </p>
            <p class="max-w-70 text-11.5 text-(--d-faint)">
              {{ t(state.projects.length === 0 ? 'terminal.emptyTextHome' : 'terminal.emptyText', { shortcut: state.shortcuts.toggleTerminal }) }}
            </p>
            <Button
              size="sm"
              variant="outline"
              data-testid="terminal-empty-new"
              class="d-press mt-1 h-7 gap-1.5 rounded-7 border-(--d-border2) bg-(--d-card) px-3 text-xs hover:border-(--d-accent) hover:bg-(--d-card) [&_svg]:size-3.5"
              @click="api.terminal.openNew()"
            >
              <Plus aria-hidden="true" />{{ t('terminal.new') }}
            </Button>
          </template>
          <p
            v-else-if="terminal.profilesReady"
            data-testid="terminal-no-shell"
            class="max-w-70 text-12.5 font-medium text-(--d-muted)"
          >
            {{ t('terminal.noShell') }}
          </p>
          <p
            v-else
            role="status"
            data-testid="terminal-detecting"
            class="max-w-70 text-11.5 text-(--d-faint)"
          >
            {{ t('terminal.detecting') }}
          </p>
        </div>
      </Transition>
    </div>
    <Transition name="terminal-list">
      <TerminalList
        v-if="terminal && terminals.length > 1"
        :api="api"
        :platform="state.platform"
        :terminals="terminals"
        :groups="terminal.groups"
        :active-id="terminal.activeId"
        :split-shortcut="state.shortcuts.splitTerminal"
        :width-rem="terminal.listWidthRem"
        :panel-width="panelWidth"
        @select="select"
        @kill="api.terminal.kill($event)"
        @split="api.terminal.split($event)"
        @resize="api.terminal.setListWidth($event)"
      />
    </Transition>
    <p
      data-testid="terminal-move-announcement"
      class="sr-only"
      role="status"
      aria-live="polite"
    >
      {{ announcement }}
    </p>
  </div>
</template>
