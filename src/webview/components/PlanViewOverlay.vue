<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { IconFileText, IconExternalLink } from '@/components/icons';
import MarkdownRenderer from './MarkdownRenderer.vue';
import OverlayShell from './OverlayShell.vue';
import { useVSCode } from '@/composables/useVSCode';
import { usePlanViewStore } from '@/stores/usePlanViewStore';

const { t } = useI18n();
const { postMessage } = useVSCode();
const planViewStore = usePlanViewStore();

defineProps<{
  planContent: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

function handleOpenInEditor() {
  if (planViewStore.viewingPlanPath) {
    postMessage({ type: 'openFile', filePath: planViewStore.viewingPlanPath });
  }
}
</script>

<template>
  <OverlayShell
    :title="t('planView.title')"
    :subtitle="t('planView.subtitle')"
    :icon="IconFileText"
    icon-class="text-primary"
    @close="emit('close')"
  >
    <template #header-actions>
      <Button
        v-if="planViewStore.viewingPlanPath"
        variant="ghost"
        size="icon-sm"
        class="text-muted-foreground hover:text-foreground hover:bg-background shrink-0"
        :title="t('planView.openInEditor')"
        @click="handleOpenInEditor"
      >
        <IconExternalLink :size="16" />
      </Button>
    </template>

    <div class="p-4">
      <MarkdownRenderer :content="planContent" />
    </div>
  </OverlayShell>
</template>
