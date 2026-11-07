<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Link } from 'lucide-vue-next';
import type { DesignBriefView } from '@shared/types/design';
import TranscriptNotice from '../TranscriptNotice.vue';

// A brief is a request the main chat relayed (PD-47): shown as a note, never as a user message.
defineProps<{ brief: DesignBriefView }>();
const { t } = useI18n();
</script>

<template>
  <TranscriptNotice
    tone="design"
    :icon="Link"
    :title="brief.reopened ? t('design.brief.reopened') : t('design.brief.title')"
    data-testid="design-brief-note"
    :data-brief-id="brief.briefId"
  >
    <p class="text-12.5 wrap-break-word whitespace-pre-wrap text-(--d-text)">
      {{ brief.text }}
    </p>
  </TranscriptNotice>
</template>
