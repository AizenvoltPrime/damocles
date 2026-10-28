<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { LogIn, Square } from 'lucide-vue-next';
import { PROVIDER_NAMES } from '@shared/types/messages';
import { usePermissionStore } from '@/stores/usePermissionStore';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useChatHost } from '@/composables/useChatHost';
import { useAttentionCard } from '@/composables/useAttention';
import { Button } from '@/components/ui/button';

// Sign-in needed: a turn waits for the sign-in of the device that started it, which is not attached. Only a click on this
// device's "Continue with my sign-in" moves the turn to this device's sign-in; Stop ends the turn.
const { t } = useI18n();
const store = usePermissionStore();
const host = useChatHost();
const { postMessage } = usePlatformBridge();

const current = computed(() => store.pendingSignIns[0]);
const providerName = computed(() => (current.value ? (PROVIDER_NAMES[current.value.provider] ?? current.value.provider) : ''));
const cardRef = ref<HTMLElement | null>(null);
useAttentionCard('input', cardRef);

function continueWithMine(): void {
  if (current.value) postMessage({ type: 'continueWithMySignIn', requestId: current.value.requestId });
}

function stop(): void {
  postMessage({ type: 'cancelSession' });
}
</script>

<template>
  <Transition name="t-up">
    <div
      v-if="current && host"
      ref="cardRef"
      class="overflow-hidden rounded-[0.875rem] border border-[color-mix(in_srgb,var(--d-warning)_45%,var(--d-border))] bg-(--d-card) text-(--d-text) shadow-(--d-shadow) [--attention-ring:var(--d-warning)]"
      role="region"
      :aria-label="t('signIn.title')"
      data-dock-prompt
      data-testid="sign-in-card"
      :data-provider="current.provider"
    >
      <header class="flex items-center gap-2.5 border-b border-(--d-border) bg-linear-to-b from-[color-mix(in_srgb,var(--d-warning)_10%,transparent)] to-transparent px-3 py-2">
        <span
          class="d-ring flex size-6.5 flex-none items-center justify-center rounded-lg bg-(--d-warning)/15 text-(--d-warning-text)"
          aria-hidden="true"
        >
          <LogIn class="size-3.5" />
        </span>
        <div class="min-w-0 flex-1 truncate font-semibold">
          {{ t('signIn.title') }}
        </div>
      </header>

      <p class="px-3.5 pt-2.5 pb-3 text-13 text-pretty">
        {{ t('signIn.body', { provider: providerName, host: host.name }) }}
      </p>

      <div class="flex flex-wrap justify-end gap-2 border-t border-(--d-border) bg-(--d-panel) px-3.5 py-2.5">
        <Button
          variant="outline"
          data-testid="sign-in-stop"
          class="d-press h-7.5 gap-1.5 rounded-9 border-(--d-border2) bg-transparent px-3 text-12.5 font-normal hover:bg-(--d-hover) hover:text-(--d-text) [&_svg]:size-3"
          @click="stop"
        >
          <Square aria-hidden="true" />
          {{ t('signIn.stop') }}
        </Button>
        <Button
          data-testid="sign-in-continue"
          class="d-press h-7.5 rounded-9 bg-(--d-accent) px-3.5 text-12.5 font-semibold text-(--d-on-accent) transition-[filter] hover:bg-(--d-accent) hover:brightness-110"
          @click="continueWithMine"
        >
          {{ t('signIn.continue') }}
        </Button>
      </div>
    </div>
  </Transition>
</template>
