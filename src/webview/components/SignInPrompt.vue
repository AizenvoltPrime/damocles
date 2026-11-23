<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { LogIn, Square } from 'lucide-vue-next';
import { PROVIDER_NAMES } from '@shared/types/messages';
import { usePermissionStore } from '@/stores/usePermissionStore';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useChatHost } from '@/composables/useChatHost';
import { useAttentionCard } from '@/composables/useAttention';
import { useDockCardVisibility } from '@/composables/useDockCardVisibility';
import { useLocalizedText } from '@/composables/useLocalizedText';
import { Button } from '@/components/ui/button';
import TrustedCheckingNote from './TrustedCheckingNote.vue';

// Sign-in needed: a turn waits for the sign-in of the device that started it, which is not attached, or whose sign-ins are
// not known yet (the request's reason, which the card says instead). Only a click on this device's "Continue with my
// sign-in" moves the turn to this device's sign-in; Stop ends the turn.
const { t } = useI18n();
const { rt } = useLocalizedText();
const store = usePermissionStore();
const host = useChatHost();
const { postMessage } = usePlatformBridge();

const current = computed(() => store.pendingSignIns[0]);
const providerName = computed(() => (current.value ? (PROVIDER_NAMES[current.value.provider] ?? current.value.provider) : ''));
const cardRef = ref<HTMLElement | null>(null);
useAttentionCard('input', cardRef);
const { isVisible, explain } = useDockCardVisibility(cardRef);

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
      class="d-dock-shadow rounded-14"
      data-trusted
    >
      <!-- One bounded element that scrolls inside itself under its answers, so the whole card always fits the page. -->
      <!-- Keyed by the request: the next request is a new element, which starts held (useTrustedVisibility). -->
      <div
        ref="cardRef"
        :key="current.requestId"
        class="max-h-[70dvh] overflow-x-hidden overflow-y-auto rounded-14 border border-[color-mix(in_srgb,var(--d-warning-fill)_45%,var(--d-border))] bg-(--d-card) text-(--d-text) [--attention-ring:var(--d-warning-fill)]"
        role="region"
        :aria-label="t('signIn.title')"
        data-dock-prompt
        data-trusted
        data-testid="sign-in-card"
        :data-provider="current.provider"
      >
        <header class="flex items-center gap-2.5 border-b border-(--d-border) bg-linear-to-b from-[color-mix(in_srgb,var(--d-warning-fill)_10%,transparent)] to-transparent px-3 py-2">
          <span
            class="d-ring [--tone:var(--d-warning-fill)] flex size-6.5 flex-none items-center justify-center rounded-lg bg-(--d-warning-fill)/15 text-(--d-warning-text)"
            aria-hidden="true"
          >
            <LogIn class="size-3.5" />
          </span>
          <div class="min-w-0 flex-1 truncate font-semibold">
            {{ t('signIn.title') }}
          </div>
        </header>

        <p
          class="px-3.5 pt-2.5 pb-3 text-13 text-pretty"
          data-testid="sign-in-body"
        >
          {{ current.reason ? rt(current.reason) : t('signIn.body', { provider: providerName, host: host.name }) }}
        </p>

        <div
          class="sticky bottom-0 flex flex-wrap justify-end gap-2 border-t border-(--d-border) bg-(--d-card) bg-linear-to-b from-(--d-panel) to-(--d-panel) px-3.5 py-2.5"
          role="group"
          :aria-label="t('signIn.title')"
          :aria-disabled="!isVisible || undefined"
        >
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
            class="d-press h-7.5 rounded-9 bg-(--d-accent-fill) px-3.5 text-12.5 font-semibold text-(--d-on-accent) transition-[filter] hover:bg-(--d-accent-fill) hover:brightness-110"
            @click="continueWithMine"
          >
            {{ t('signIn.continue') }}
          </Button>
        </div>
        <TrustedCheckingNote
          overlay
          class="bottom-0"
          :shown="explain"
          :text="t('trusted.checkingVisible')"
        />
      </div>
    </div>
  </Transition>
</template>
