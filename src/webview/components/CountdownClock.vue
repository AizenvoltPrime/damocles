<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useNow } from '@/composables/useNow';
import { countdownText, minutesLeft } from './host-update-clock';

// The time left until `to` (epoch ms). It is information, not motion, so it ticks in every motion setting. A screen reader
// hears the minutes, which change once a minute; live: they are a polite live region of their own (GOV.UK's timeout warning).
const props = defineProps<{ to: number; live?: boolean }>();
const { t } = useI18n();
const now = useNow();
const left = computed(() => props.to - now());
const spoken = computed(() => t('hostUpdate.minutes', { count: minutesLeft(left.value) }));
</script>

<template>
  <span
    aria-hidden="true"
    class="tabular-nums"
    data-testid="countdown-clock"
  >{{ countdownText(left) }}</span><span
    class="sr-only"
    :aria-live="live ? 'polite' : undefined"
    data-testid="countdown-spoken"
  >{{ spoken }}</span>
</template>
