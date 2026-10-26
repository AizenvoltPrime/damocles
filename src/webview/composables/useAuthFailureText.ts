import { computed, type ComputedRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { MODEL_VENDOR_NAMES } from '@shared/model-vendor';
import type { AuthFailure } from '@/stores/useUIStore';

/** The provider-named title and message of a refused or missing credential, the same on the live card and its replay. */
export function useAuthFailureText(failure: () => AuthFailure): { isAnthropic: ComputedRef<boolean>; title: ComputedRef<string>; message: ComputedRef<string> } {
  const { t } = useI18n();
  const isAnthropic = computed(() => failure().account === 'anthropic');
  const providerName = computed(() => MODEL_VENDOR_NAMES[failure().account]);
  const title = computed(() => t('authBanner.title', { provider: providerName.value }));
  const message = computed(() => {
    if (failure().reason === 'noApiAccess') return t('authBanner.noApiAccess', { provider: providerName.value });
    if (failure().reason === 'missing') return t('authBanner.missing', { provider: providerName.value });
    return isAnthropic.value ? t('authBanner.sessionExpired') : t('authBanner.rejected', { provider: providerName.value });
  });
  return { isAnthropic, title, message };
}
