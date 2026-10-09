<script setup lang="ts">
import { Check, X } from 'lucide-vue-next';
import type { CommandStatus } from './terminal-commands';

// One command's gutter mark inside its xterm decoration (custom markup: xterm owns the decoration element and positions it
// on the command's row, where no shadcn part can sit). Running pulses softly and settles into a check or a cross.
defineProps<{ status: CommandStatus; label: string }>();
const emit = defineEmits<{ activate: [element: HTMLElement]; hover: [element: HTMLElement | null] }>();

function onClick(event: MouseEvent): void {
  event.preventDefault();
  event.stopPropagation();
  emit('activate', event.currentTarget as HTMLElement);
}
</script>

<template>
  <!-- Not a tab stop: the xterm keeps keyboard focus, and Ctrl+Up then Shift+F10 reaches the same actions. -->
  <button
    type="button"
    tabindex="-1"
    data-testid="terminal-mark"
    :data-status="status"
    :aria-label="label"
    class="terminal-mark d-press"
    @mousedown.prevent
    @click="onClick"
    @mouseenter="emit('hover', $event.currentTarget as HTMLElement)"
    @mouseleave="emit('hover', null)"
  >
    <Transition
      name="terminal-mark-settle"
      mode="out-in"
    >
      <span
        v-if="status === 'running'"
        key="running"
        aria-hidden="true"
        class="terminal-mark-running d-ring"
      />
      <span
        v-else
        :key="status"
        aria-hidden="true"
        class="terminal-mark-face"
      >
        <Check
          v-if="status === 'success'"
          class="size-2"
          :stroke-width="3"
        />
        <X
          v-else
          class="size-2"
          :stroke-width="3"
        />
      </span>
    </Transition>
  </button>
</template>
