<script setup lang="ts">
import { LoaderCircle } from 'lucide-vue-next';
import SettingButton from './SettingButton.vue';

defineProps<{
  state: 'ok' | 'off' | 'busy';
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
      <span
        class="sm-account-dot"
        aria-hidden="true"
      />
      {{ status }}
      <LoaderCircle
        v-if="state === 'busy'"
        class="size-3 sm-spin"
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
