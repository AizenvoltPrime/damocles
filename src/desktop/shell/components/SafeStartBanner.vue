<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ShieldCheck } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import TrustedCheckingNote from '@/components/TrustedCheckingNote.vue';
import { useTrustedVisibility } from '@/composables/useTrustedVisibility';

// Safe start's banner under the title bar: trusted UI, so a theme never restyles or hides the way back to it.
defineProps<{ reason: 'launch' | 'crashLoop' | 'reset' }>();

const emit = defineEmits<{
  (e: 'useMine'): void;
  (e: 'openSettings'): void;
}>();

const { t } = useI18n();
const bannerRef = ref<HTMLElement | null>(null);
const { isVisible, explain } = useTrustedVisibility(bannerRef, true);
</script>

<template>
  <div
    ref="bannerRef"
    role="region"
    aria-labelledby="safe-start-title"
    data-trusted
    class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-(--d-border2) bg-(--d-card) py-2 ps-4 pe-3 text-12 text-(--d-text)"
    data-testid="safe-start-banner"
  >
    <span
      class="d-tone-warning flex size-6.5 flex-none items-center justify-center rounded-8 bg-(--tone)/15"
      aria-hidden="true"
    >
      <ShieldCheck class="size-4" />
    </span>
    <!-- The text scrolls inside its own bounded box, so the banner fits the window whole at every text size. -->
    <div class="relative min-w-0 flex-[1_1_16rem]">
      <p class="max-h-18 overflow-y-auto">
        <strong
          id="safe-start-title"
          class="font-semibold"
        >{{ reason === 'crashLoop' ? t('themes.safeStart.crashTitle') : reason === 'reset' ? t('themes.safeStart.resetTitle') : t('themes.safeStart.title') }}</strong>
        {{ ' ' }}
        <span class="text-(--d-muted)">{{ t('themes.safeStart.body') }}</span>
      </p>
      <TrustedCheckingNote
        cover
        :shown="explain"
        :text="t('themes.checkingVisible')"
      />
    </div>
    <div
      class="flex flex-wrap gap-1.5"
      role="group"
      aria-labelledby="safe-start-title"
      :aria-disabled="!isVisible || undefined"
    >
      <Button
        type="button"
        size="sm"
        class="h-7 rounded-8 px-3 text-12 font-semibold"
        data-testid="safe-start-use-mine"
        @click="emit('useMine')"
      >
        {{ t('themes.safeStart.useMine') }}
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        class="h-7 rounded-8 border-(--d-border2) bg-transparent px-3 text-12"
        @click="emit('openSettings')"
      >
        {{ t('themes.safeStart.openSettings') }}
      </Button>
    </div>
  </div>
</template>
