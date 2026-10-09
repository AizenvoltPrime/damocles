<script setup lang="ts">
import { inject, nextTick, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Input } from '@/components/ui/input';
import type { DamoclesShellApi } from '../../preload/shell-channels';
import { MAX_TERMINAL_NAME_LENGTH, type TerminalInfo } from '../../preload/terminal-channels';
import { renameRequestName } from './terminal-menu';
import { TERMINAL_STORE } from './terminal-store';

// The inline rename field that takes a list row's or the tab's title in place, as VS Code's tabs list does: Enter and blur
// commit, Escape cancels, and an emptied field restores the automatic title.
const props = defineProps<{ api: DamoclesShellApi; terminal: TerminalInfo }>();
// done: the rename ended and focus goes back to the row or tab it was started from
const emit = defineEmits<{ done: [] }>();
const { t } = useI18n();
const store = inject(TERMINAL_STORE)!;

const draft = ref(props.terminal.title);
const field = ref<InstanceType<typeof Input> | null>(null);
let finished = false;

onMounted(() => void nextTick(() => {
  const input = field.value?.$el as HTMLInputElement | undefined;
  input?.focus();
  input?.select();
}));

function finish(commit: boolean): void {
  if (finished) return;
  finished = true;
  const name = commit ? renameRequestName(draft.value, props.terminal) : undefined;
  if (name !== undefined) props.api.terminal.rename({ id: props.terminal.id, name });
  const returnTo = store.renaming.value?.returnTo;
  store.endRename();
  if (returnTo === 'terminal') store.requestFocus(props.terminal.id);
  else emit('done');
}

function onKeydown(event: KeyboardEvent): void {
  // The row's own keys (arrows, Delete, Enter, Space) must not act while its title is being edited.
  event.stopPropagation();
  if (event.key === 'Enter') finish(true);
  else if (event.key === 'Escape') finish(false);
  else return;
  event.preventDefault();
}
</script>

<template>
  <Input
    ref="field"
    v-model="draft"
    data-testid="terminal-rename-input"
    :maxlength="MAX_TERMINAL_NAME_LENGTH"
    :aria-label="t('terminal.renameLabel', { title: terminal.title })"
    :placeholder="t('terminal.renamePlaceholder')"
    spellcheck="false"
    autocomplete="off"
    class="terminal-rename -ml-1.25 h-5 min-w-0 flex-1 rounded-5 border-(--d-accent) bg-(--d-input) px-1 py-0 text-(--d-text) shadow-[0_0_0_2px_var(--d-accent-soft)] focus-visible:ring-0 focus-visible:ring-offset-0"
    @keydown="onKeydown"
    @blur="finish(true)"
    @click.stop
    @mousedown.stop
    @dblclick.stop
    @contextmenu.stop
  />
</template>
