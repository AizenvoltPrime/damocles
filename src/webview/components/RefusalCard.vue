<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { ShieldAlert } from 'lucide-vue-next';
import TranscriptNotice from './TranscriptNotice.vue';

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
  <TranscriptNotice
    tone="warning"
    :icon="ShieldAlert"
    :title="t('refusal.title')"
    :chip="categoryLabel ?? undefined"
  >
    <p class="text-12.5 wrap-break-word whitespace-pre-wrap">
      {{ body }}
    </p>
  </TranscriptNotice>
</template>
