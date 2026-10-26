<script setup lang="ts">
import { ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { ChevronRight, KeyRound } from 'lucide-vue-next';
import type { AuthFailure } from '@/stores/useUIStore';
import { useAuthFailureText } from '@/composables/useAuthFailureText';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import TranscriptNotice from './TranscriptNotice.vue';
import ErrorMessageText from './ErrorMessageText.vue';

const props = defineProps<{
  failure: AuthFailure;
  /** The call's error text. For `missing` it is pi's text, which is never shown. */
  details: string;
}>();

const { t } = useI18n();
const { title, message } = useAuthFailureText(() => props.failure);
const detailsOpen = ref(false);
const titleId = useId();
</script>

<template>
  <TranscriptNotice
    tone="danger"
    :icon="KeyRound"
    :title="title"
    :title-id="titleId"
  >
    <p
      class="text-12.5 text-(--d-text)"
      data-testid="auth-failure-notice-message"
    >
      {{ message }}
    </p>
    <!-- A missing credential's text is pi's, not the provider's, and can carry pi's CLI login help. -->
    <Collapsible
      v-if="failure.reason !== 'missing'"
      v-model:open="detailsOpen"
    >
      <CollapsibleTrigger as-child>
        <Button
          variant="ghost"
          class="h-auto gap-1 px-1 py-0.5 text-xs font-normal text-(--d-muted) hover:text-(--d-text) [&_svg]:size-3"
          :aria-describedby="titleId"
          data-testid="auth-failure-notice-details-toggle"
        >
          <ChevronRight
            class="transition-transform duration-200 ease-out"
            :class="detailsOpen && 'rotate-90'"
            aria-hidden="true"
          />
          {{ t('authBanner.details') }}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ErrorMessageText
          class="block text-xs wrap-break-word whitespace-pre-wrap text-(--d-muted)"
          :text="details"
          data-testid="auth-failure-notice-details"
        />
      </CollapsibleContent>
    </Collapsible>
  </TranscriptNotice>
</template>
