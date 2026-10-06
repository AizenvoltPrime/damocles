<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';
import type { DamoclesOverlayApi } from '../../preload/overlay-channels';
import { applyShellLocale } from '../i18n';
import { createChime } from './chime';
import ToastStack from './components/ToastStack.vue';

// The desktop popup window's page (D52): the toast stack, the only place toasts render, and the popups' sound.
const props = defineProps<{ api: DamoclesOverlayApi }>();

const stops: Array<() => void> = [];
onMounted(async () => {
  const chime = createChime();
  // Unsubscribed before the context closes, so no chime can open it again.
  stops.push(props.api.onChime(chime.play), chime.close);
  // Subscribed before the first read, so a language change between the two is not lost.
  stops.push(props.api.onState((state) => applyShellLocale(state.locale)));
  applyShellLocale((await props.api.getState()).locale);
});
onBeforeUnmount(() => {
  for (const stop of stops) stop();
});
</script>

<template>
  <div class="h-full">
    <ToastStack :api="api" />
  </div>
</template>
