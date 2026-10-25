<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { KeyRound } from 'lucide-vue-next';
import { MODEL_VENDOR_NAMES } from '@shared/model-vendor';
import type { SettingsAccountId } from '@shared/settings-sections';
import type { AuthFailure } from '@/stores/useUIStore';
import DockBanner from './DockBanner.vue';

const props = defineProps<{
  failure: AuthFailure;
}>();

const emit = defineEmits<{
  (e: 'open-account', account: SettingsAccountId): void;
  (e: 'dismiss'): void;
}>();

const { t } = useI18n();

const isAnthropic = computed(() => props.failure.account === 'anthropic');

const providerName = computed(() => MODEL_VENDOR_NAMES[props.failure.account]);

const message = computed(() => {
  if (props.failure.reason === 'noApiAccess') return t('authBanner.noApiAccess', { provider: providerName.value });
  return isAnthropic.value ? t('authBanner.sessionExpired') : t('authBanner.rejected', { provider: providerName.value });
});
</script>

<template>
  <DockBanner
    tone="warning"
    :icon="KeyRound"
    :title="t('authBanner.title', { provider: providerName })"
    data-testid="auth-banner"
    @dismiss="emit('dismiss')"
  >
    <p
      class="text-xs text-(--d-text)"
      data-testid="auth-banner-message"
    >
      {{ message }}
    </p>
    <p
      v-if="isAnthropic"
      class="mt-0.5 pb-0.5 text-xs text-(--d-muted)"
    >
      {{ t('authBanner.independenceNote') }}
    </p>
    <template #actions>
      <button
        type="button"
        class="d-press flex h-7.5 shrink-0 items-center rounded-9 bg-(--d-accent) px-3.25 text-12.5 font-semibold text-(--d-on-accent)"
        data-testid="auth-banner-action"
        @click="emit('open-account', failure.account)"
      >
        {{ isAnthropic ? t('authBanner.signIn') : t('authBanner.openSettings') }}
      </button>
    </template>
  </DockBanner>
</template>
