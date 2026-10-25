<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { TriangleAlert } from 'lucide-vue-next';
import DockBanner from './DockBanner.vue';

const { t } = useI18n();

defineEmits<{
  (e: 'dismiss'): void;
}>();
</script>

<template>
  <DockBanner
    tone="warning"
    :icon="TriangleAlert"
    :title="t('allowanceBanner.title')"
    data-testid="allowance-banner"
    @dismiss="$emit('dismiss')"
  >
    <p class="pb-0.5 text-xs text-(--d-muted)">
      {{ t('allowanceBanner.message') }}
    </p>
  </DockBanner>
</template>
