<script setup lang="ts">
import { LoaderCircle, TriangleAlert } from 'lucide-vue-next';
import SettingButton from './SettingButton.vue';

defineProps<{
  /** warn: the credential needs the user (a refused token); it shows a warning icon, not the dot. */
  state: 'ok' | 'off' | 'busy' | 'warn';
  status: string;
  action: string;
  /** Names the action for assistive technology, e.g. "Manage Anthropic". */
  actionLabel: string;
  expanded: boolean;
  controls: string;
}>();

const emit = defineEmits<{
  (e: 'toggle'): void;
}>();
</script>

<template>
  <div class="sm-account">
    <span
      class="sm-account-status"
      :data-state="state"
      role="status"
    >
      <TriangleAlert
        v-if="state === 'warn'"
        class="size-3"
        aria-hidden="true"
      />
      <span
        v-else
        class="sm-account-dot"
        aria-hidden="true"
      />
      {{ status }}
      <LoaderCircle
        v-if="state === 'busy'"
        class="size-3 d-spinning [--spin-duration:.8s]"
        aria-hidden="true"
      />
    </span>
    <SettingButton
      :aria-label="actionLabel"
      :aria-expanded="expanded ? 'true' : 'false'"
      :aria-controls="controls"
      @click="emit('toggle')"
    >
      {{ action }}
    </SettingButton>
  </div>
</template>
