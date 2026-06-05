<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

const props = defineProps<{
  explanation: string | null;
  category: 'cyber' | 'bio' | null;
}>();

const categoryLabel = computed(() => {
  if (props.category === 'cyber') return t('refusal.category.cyber');
  if (props.category === 'bio') return t('refusal.category.bio');
  return null;
});

const body = computed(() => props.explanation?.trim() || t('refusal.noExplanation'));
</script>

<template>
  <div class="mx-4 mb-3 rounded-lg border border-warning/40 bg-warning/10">
    <div class="px-4 py-3 flex items-start gap-3">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="mt-0.5 shrink-0 text-warning"
      >
        <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
        <path d="M12 8v4" />
        <path d="M12 16h.01" />
      </svg>

      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <span class="text-sm font-semibold text-foreground">{{ t('refusal.title') }}</span>
          <span
            v-if="categoryLabel"
            class="px-1.5 py-0.5 rounded text-xs font-medium bg-warning/20 text-warning border border-warning/30"
          >
            {{ categoryLabel }}
          </span>
        </div>
        <p class="mt-1 text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap break-words">
          {{ body }}
        </p>
      </div>
    </div>
  </div>
</template>
