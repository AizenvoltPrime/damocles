<script setup lang="ts">
import { onBeforeUnmount, onMounted, provide } from 'vue';
import type { DamoclesOverlayApi, OverlayState } from '../../preload/overlay-channels';
import { createPageCharacters, PAGE_CHARACTERS } from '../characters';
import { applyShellLocale } from '../i18n';
import { createChime } from './chime';
import ToastStack from './components/ToastStack.vue';

// The desktop popup window's page (D52): the toast stack, the only place toasts render, and the popups' sound.
const props = defineProps<{ api: DamoclesOverlayApi }>();
const pageCharacters = createPageCharacters();
provide(PAGE_CHARACTERS, pageCharacters.characters);

const stops: Array<() => void> = [];
onMounted(async () => {
  const chime = createChime();
  // Unsubscribed before the context closes, so no chime can open it again.
  stops.push(props.api.onChime(chime.play), chime.close);
  // Subscribed before the first read, so a language change between the two is not lost.
  const apply = (state: OverlayState): void => {
    void applyShellLocale(state.locale);
    pageCharacters.set(state.characters);
  };
  stops.push(props.api.onState(apply));
  apply(await props.api.getState());
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
