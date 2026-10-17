<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { FileDiff } from 'lucide-vue-next';
import RollingNumber from '@/components/RollingNumber.vue';

// The chat header's +N −M (D60): what this chat changed, which opens the review tab. Each number rolls to its new value.
defineProps<{ added: number; removed: number; files: number }>();
const emit = defineEmits<{ open: [] }>();
const { t } = useI18n();
</script>

<template>
  <button
    type="button"
    class="d-tool-btn gap-1.5 px-2"
    :title="t('chatHeader.reviewChanges', { n: files }, files)"
    :aria-label="t('chatHeader.reviewChangesLabel', { added, removed, n: files }, files)"
    data-testid="chat-header-changes"
    @click="emit('open')"
  >
    <FileDiff
      class="size-3.5"
      aria-hidden="true"
    />
    <span
      class="inline-flex font-mono text-11 text-(--d-success-text)"
      aria-hidden="true"
    >+<RollingNumber
      :value="added"
      test-id="chat-header-changes-added"
    /></span>
    <span
      class="inline-flex font-mono text-11 text-(--d-danger-text)"
      aria-hidden="true"
    >−<RollingNumber
      :value="removed"
      test-id="chat-header-changes-removed"
    /></span>
  </button>
</template>
