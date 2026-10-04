<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { ClipboardList, ExternalLink, FileText } from 'lucide-vue-next';
import MarkdownRenderer from './MarkdownRenderer.vue';
import OverlayShell from './OverlayShell.vue';
import OverlayHeaderAction from './OverlayHeaderAction.vue';
import { usePlatformBridge } from '@/composables/usePlatformBridge';
import { useFolderRelativePath } from '@/composables/useFolderRelativePath';
import { usePlanViewStore } from '@/stores/usePlanViewStore';

const { t } = useI18n();
const { postMessage } = usePlatformBridge();
const planViewStore = usePlanViewStore();
const relativePath = useFolderRelativePath();

defineProps<{
  planContent: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const shownPath = computed(() => (planViewStore.viewingPlanPath ? relativePath(planViewStore.viewingPlanPath) : null));

function handleOpenInEditor() {
  if (!planViewStore.viewingPlanPath) return;
  postMessage({ type: 'openFile', filePath: planViewStore.viewingPlanPath });
  emit('close');
}
</script>

<template>
  <OverlayShell
    :title="t('planView.title')"
    :subtitle="t('planView.subtitle')"
    :icon="ClipboardList"
    data-testid="plan-view-overlay"
    @close="emit('close')"
  >
    <template #header-actions>
      <OverlayHeaderAction
        v-if="planViewStore.viewingPlanPath"
        :label="t('planView.openInEditor')"
        :icon="ExternalLink"
        data-testid="plan-view-open"
        @click="handleOpenInEditor"
      />
    </template>

    <article class="mx-auto max-w-180 px-6.5 pt-5 pb-8 text-13.5 leading-[1.7]">
      <div
        v-if="shownPath"
        class="mb-3.5 flex min-w-0 items-center gap-2 font-mono text-11.5 text-(--d-faint)"
        :title="planViewStore.viewingPlanPath ?? undefined"
        data-testid="plan-view-path"
      >
        <FileText
          class="size-3 flex-none"
          aria-hidden="true"
        />
        <span class="truncate">{{ shownPath }}</span>
      </div>
      <MarkdownRenderer
        class="plan-body"
        :content="planContent"
      />
    </article>
  </OverlayShell>
</template>

<style scoped>
.plan-body :deep(h1) {
  margin-top: 0;
  font-size: 1.375rem;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.plan-body :deep(h1 + .markdown-p) {
  color: var(--d-muted);
}

.plan-body :deep(h2) {
  font-size: 0.7188rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--d-faint);
}
</style>
