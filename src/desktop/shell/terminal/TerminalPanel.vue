<script setup lang="ts">
import { computed, inject, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useElementSize } from '@vueuse/core';
import { FolderPlus, Plus, SquareTerminal } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import type { DamoclesShellApi, ShellState } from '../../preload/shell-channels';
import { TERMINAL_STORE } from './terminal-store';
import TerminalPanes from './TerminalPanes.vue';
import TerminalList from './TerminalList.vue';

// The terminal pane's body: every terminal's view (the active group's panes shown), the list beside them once there are
// two, or the empty state.
const props = defineProps<{ api: DamoclesShellApi; state: ShellState }>();
const { t } = useI18n();
const store = inject(TERMINAL_STORE)!;

const root = ref<HTMLElement | null>(null);
const { width: panelWidth } = useElementSize(root);
const terminal = computed(() => store.state.value);
const terminals = computed(() => terminal.value?.terminals ?? []);
const creating = ref(false);

// A user action: the new terminal takes focus once its view opens.
async function createHere(): Promise<void> {
  creating.value = true;
  try {
    const result = await props.api.terminal.create({ profileId: null, projectKey: null });
    if (result.ok) store.requestFocus(result.id);
  } finally {
    creating.value = false;
  }
}

function select(id: string): void {
  props.api.terminal.select(id);
  store.requestFocus(id);
}
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
      />
      <Transition name="t-fade">
        <div
          v-if="terminal && terminals.length === 0"
          data-testid="terminal-empty"
          class="pane-empty absolute inset-0 flex flex-col items-center justify-center gap-2.5 p-6 text-center"
        >
          <span class="flex size-10 items-center justify-center rounded-xl border border-(--d-border) bg-(--d-panel) text-(--d-faint)">
            <SquareTerminal
              aria-hidden="true"
              class="size-5"
            />
          </span>
          <template v-if="terminal.canCreate">
            <p class="text-12.5 font-medium text-(--d-muted)">
              {{ t('grid.terminal.emptyTitle') }}
            </p>
            <p class="max-w-70 text-11.5 text-(--d-faint)">
              {{ t('terminal.emptyText', { shortcut: state.shortcuts.toggleTerminal }) }}
            </p>
            <Button
              size="sm"
              variant="outline"
              data-testid="terminal-empty-new"
              class="d-press mt-1 h-7 gap-1.5 rounded-7 border-(--d-border2) bg-(--d-card) px-3 text-xs hover:border-(--d-accent) hover:bg-(--d-card) [&_svg]:size-3.5"
              :disabled="creating"
              @click="createHere"
            >
              <Plus aria-hidden="true" />{{ t('terminal.new') }}
            </Button>
          </template>
          <template v-else-if="state.projects.length === 0">
            <p class="text-12.5 font-medium text-(--d-muted)">
              {{ t('terminal.noProject') }}
            </p>
            <Button
              size="sm"
              variant="outline"
              data-testid="terminal-empty-add-project"
              class="d-press mt-1 h-7 gap-1.5 rounded-7 border-(--d-border2) bg-(--d-card) px-3 text-xs hover:border-(--d-accent) hover:bg-(--d-card) [&_svg]:size-3.5"
              @click="api.addProject()"
            >
              <FolderPlus aria-hidden="true" />{{ t('projects.add') }}
            </Button>
          </template>
          <p
            v-else
            class="max-w-70 text-12.5 font-medium text-(--d-muted)"
          >
            {{ t('terminal.noShell') }}
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
  </div>
</template>
