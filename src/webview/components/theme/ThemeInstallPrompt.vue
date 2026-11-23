<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ThemeInstallAnswer } from '@shared/themes/install';
import ThemeInstallCard from './ThemeInstallCard.vue';
import { useThemePromptStore } from '@/stores/useThemePromptStore';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useAttentionCard } from '@/composables/useAttention';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useConnectionStore } from '@/stores/useConnectionStore';
import { installThumbs } from '@/utils/install-thumbs';

// The agent's ThemeSet install, docked above the composer: the install card for the oldest open themeInstall prompt.
const emit = defineEmits<{
  /** The card left while it held focus; the page hands focus on. */
  (e: 'release-focus'): void;
}>();

const store = useThemePromptStore();
const settingsStore = useSettingsStore();
const connectionStore = useConnectionStore();
const { postMessage } = usePlatformBridge();
const current = computed(() => store.installPrompts[0]);
const cardRef = ref<InstanceType<typeof ThemeInstallCard> | null>(null);
useAttentionCard('approval', () => cardRef.value?.$el as HTMLElement | undefined);

// The prompt whose Install this view sent. Core closes the card when it takes the answer, and the ThemeSet tool card shows
// the call running until the theme is written. An Install core does not take is answered with the card again, and a preview
// that changed under the press arrives as an update: either clears this, and a progress tick does not.
const installing = ref<string | null>(null);
watch(() => current.value?.preview, () => {
  installing.value = null;
});
// the page's image cache holds the thumbnails, never the store
const thumbs = computed(() => (current.value ? installThumbs(current.value.promptId) : {}));

function answer(reply: ThemeInstallAnswer): void {
  const promptId = current.value?.promptId;
  if (promptId === undefined) return;
  // The card stays until core closes it; core takes Cancel at any time.
  if (reply.choice === 'cancel') {
    postMessage({ type: 'resolveThemeInstall', promptId, choice: 'cancel' });
    return;
  }
  if (installing.value === promptId) return;
  postMessage(reply.onClash === undefined
    ? { type: 'resolveThemeInstall', promptId, choice: 'install', useArrangement: reply.useArrangement }
    : { type: 'resolveThemeInstall', promptId, choice: 'install', onClash: reply.onClash, useArrangement: reply.useArrangement });
  installing.value = promptId;
}

function allowFlash(sha256: string): void {
  const prompt = current.value;
  if (prompt !== undefined) postMessage({ type: 'allowThemeInstallFlash', promptId: prompt.promptId, installId: prompt.preview.installId, sha256 });
}
</script>

<template>
  <Transition name="t-up">
    <div
      v-if="current"
      class="d-dock-shadow rounded-14"
      data-trusted
    >
      <!-- Keyed by the request: the next request is a new card, which starts held (useTrustedVisibility). -->
      <ThemeInstallCard
        ref="cardRef"
        :key="current.promptId"
        :preview="current.preview"
        variant="dock"
        :gated="settingsStore.hostCapabilities.damoclesTheme"
        :quiet="connectionStore.awayShown"
        :busy="installing === current.promptId"
        :progress="current.progress"
        :thumbs="thumbs"
        :other-device="current.otherDevice"
        @answer="answer"
        @allow-flash="allowFlash"
        @release-focus="emit('release-focus')"
      />
    </div>
  </Transition>
</template>
