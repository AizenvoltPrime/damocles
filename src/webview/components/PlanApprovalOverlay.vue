<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { IconSparkles, IconCheck, IconPencil, IconPaperPlane, IconBolt } from '@/components/icons';
import MarkdownRenderer from './MarkdownRenderer.vue';
import OverlayShell from './OverlayShell.vue';

const { t } = useI18n();

defineProps<{
  planContent: string;
}>();

const emit = defineEmits<{
  (e: 'approve', options: { approvalMode: 'acceptEdits' | 'manual'; clearContext?: boolean }): void;
  (e: 'feedback', text: string): void;
  (e: 'cancel'): void;
}>();

const feedbackText = ref('');
const canSubmitFeedback = computed(() => feedbackText.value.trim().length > 0);

function handleSendFeedback() {
  if (canSubmitFeedback.value) {
    emit('feedback', feedbackText.value.trim());
  }
}
</script>

<template>
  <OverlayShell
    :title="t('planApproval.readyToCode')"
    :subtitle="t('planApproval.reviewPlan')"
    :icon="IconSparkles"
    icon-class="text-primary"
    @close="emit('cancel')"
  >
    <div class="p-4">
      <MarkdownRenderer :content="planContent" />
    </div>

    <template #footer>
      <footer class="shrink-0 border-t border-border/30 bg-muted p-4 space-y-3">
        <Textarea
          v-model="feedbackText"
          :placeholder="t('planApproval.feedbackPlaceholder')"
          class="resize-none max-h-32"
          @keydown.enter.ctrl="handleSendFeedback"
        />
        <div class="flex justify-end gap-2">
          <Button variant="outline" :disabled="!canSubmitFeedback" @click="handleSendFeedback">
            <IconPaperPlane :size="16" class="mr-2" />
            {{ t('planApproval.sendFeedback') }}
          </Button>
          <Button variant="outline" @click="emit('approve', { approvalMode: 'manual' })">
            <IconPencil :size="16" class="mr-2" />
            {{ t('planApproval.manualApprove') }}
          </Button>
          <Button variant="outline" @click="emit('approve', { approvalMode: 'acceptEdits' })">
            <IconCheck :size="16" class="mr-2" />
            {{ t('planApproval.autoAccept') }}
          </Button>
          <Button @click="emit('approve', { approvalMode: 'acceptEdits', clearContext: true })">
            <IconBolt :size="16" class="mr-2" />
            {{ t('planApproval.clearContextAndAccept') }}
          </Button>
        </div>
      </footer>
    </template>
  </OverlayShell>
</template>
