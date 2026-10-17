<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { ArrowRight, X } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { visibleText } from '@shared/visible-text';

// The Compare zone's title row: the conflict's current side against its incoming side (merge-conflict's compare command).
defineProps<{ current: string; incoming: string }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useI18n();
</script>

<template>
  <div class="flex h-full items-center gap-2 border-b border-(--d-border) bg-(--d-panel) pr-1.5 pl-3 text-12">
    <span class="shrink-0 font-medium text-(--d-text)">{{ t('conflict.compareHeading') }}</span>
    <span class="flex min-w-0 items-center gap-1.5 truncate text-11.5">
      <span class="truncate text-(--d-success-text)">{{ t('conflict.current') }}<template v-if="current"> · {{ visibleText(current) }}</template></span>
      <ArrowRight
        aria-hidden="true"
        class="size-3 shrink-0 text-(--d-faint-text)"
      />
      <span class="truncate text-(--d-info-text)">{{ t('conflict.incoming') }}<template v-if="incoming"> · {{ visibleText(incoming) }}</template></span>
    </span>
    <span class="flex-1" />
    <Button
      size="icon"
      variant="ghost"
      data-testid="conflict-compare-close"
      class="d-press size-6 rounded-md text-(--d-muted) hover:bg-(--d-border2) hover:text-(--d-text) [&_svg]:size-3.5"
      :aria-label="t('quickDiff.close')"
      :title="t('quickDiff.close')"
      @click="emit('close')"
    >
      <X aria-hidden="true" />
    </Button>
  </div>
</template>
