<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { Camera, X } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useTrustedVisibility } from '@/composables/useTrustedVisibility';
import { useSettingsStore } from '@/stores/useSettingsStore';
import TrustedCheckingNote from '../TrustedCheckingNote.vue';

// While this chat holds the screenshot grant: trusted UI drawn only from the themeScreenshotGrant of the grant's publisher, the way to end it.
const emit = defineEmits<{
  /** The strip left while it held focus; the page hands focus on. */
  (e: 'release-focus'): void;
}>();

const { t } = useI18n();
const { postMessage } = usePlatformBridge();
const settings = useSettingsStore();

const stripRef = ref<HTMLElement | null>(null);
// Never quiet: the strip sits outside the dimmed prompts, so it alone says why Revoke is held while the host is away.
const { isVisible, explain } = useTrustedVisibility(stripRef, () => settings.hostCapabilities.damoclesTheme);
// Revoke went out; the strip leaves when the grant's publisher says it ended.
const sent = ref(false);

function revoke(): void {
  if (!isVisible.value || sent.value) return;
  postMessage({ type: 'revokeThemeScreenshotGrant' });
  sent.value = true;
}

onBeforeUnmount(() => {
  if (stripRef.value?.contains(document.activeElement)) emit('release-focus');
});
</script>

<template>
  <div
    class="d-dock-shadow rounded-14"
    data-trusted
  >
    <section
      ref="stripRef"
      class="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-14 border border-[color-mix(in_srgb,var(--d-warning-fill)_45%,var(--d-border))] bg-(--d-card) py-2 ps-3 pe-2 text-(--d-text)"
      role="region"
      aria-labelledby="theme-screenshot-grant-title"
      data-trusted
      data-testid="theme-screenshot-grant"
    >
      <span
        class="flex size-6.5 flex-none items-center justify-center rounded-8 bg-[color-mix(in_srgb,var(--d-warning-fill)_16%,transparent)] text-(--d-warning)"
        aria-hidden="true"
      >
        <Camera class="size-3.5" />
      </span>
      <div class="relative min-w-0 flex-[1_1_12rem]">
        <!-- The text scrolls inside its own bounded box, so the strip always fits the page whole. -->
        <div
          class="-mx-1 max-h-18 overflow-y-auto rounded-md px-1 outline-none focus-visible:ring-1 focus-visible:ring-(--d-accent-fill)"
          role="region"
          :aria-label="t('themeAgent.grant.details')"
          tabindex="0"
          data-testid="theme-screenshot-grant-text"
        >
          <p class="text-xs text-pretty">
            <strong
              id="theme-screenshot-grant-title"
              class="font-semibold"
            >{{ t('themeAgent.grant.title') }}</strong>
            {{ ' ' }}
            <span
              id="theme-screenshot-grant-body"
              class="text-(--d-muted)"
            >{{ t('themeAgent.grant.body') }}</span>
          </p>
        </div>
        <TrustedCheckingNote
          id="theme-screenshot-grant-checking"
          cover
          :shown="explain"
          :text="t('trusted.checkingVisible')"
        />
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        class="ms-auto h-7 gap-1.5 rounded-8 border-(--d-border2) bg-transparent px-3 text-12 aria-disabled:text-(--d-muted) aria-disabled:hover:bg-transparent [&_svg]:size-3"
        :aria-disabled="!isVisible || sent || undefined"
        :aria-describedby="explain ? 'theme-screenshot-grant-checking' : 'theme-screenshot-grant-body'"
        data-testid="theme-screenshot-grant-revoke"
        @click="revoke"
      >
        <X aria-hidden="true" />{{ sent ? t('themeAgent.grant.revoking') : t('themeAgent.grant.revoke') }}
      </Button>
      <!-- The live region is mounted before its text: one inserted together with its text is often not announced. -->
      <span
        class="sr-only"
        role="status"
        data-testid="theme-screenshot-grant-status"
      >{{ sent ? t('themeAgent.grant.revoking') : '' }}</span>
    </section>
  </div>
</template>
