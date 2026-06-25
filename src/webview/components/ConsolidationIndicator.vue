<script setup lang="ts">
import { computed } from 'vue';
import { storeToRefs } from 'pinia';
import { Button } from '@/components/ui/button';
import { IconDatabase } from '@/components/icons';
import { useConsolidationStore } from '@/stores/useConsolidationStore';

const store = useConsolidationStore();
const { pendingCount, isRunning, lastResult, isOverlayOpen } = storeToRefs(store);

defineEmits<{ (e: 'click'): void }>();

const badge = computed(() => (pendingCount.value > 99 ? '99+' : String(pendingCount.value)));

/** Surface a failure even when the overlay is closed; clears on a later non-failed run. A failed
 *  pass releases its turns back to the queue, so the violet count badge is usually present too — the
 *  error dot sits at the opposite (bottom-right) corner so both remain visible. */
const showErrorDot = computed(
  () => !isOverlayOpen.value && !isRunning.value && lastResult.value?.status === 'failed',
);
</script>

<template>
  <Button
    variant="ghost"
    size="icon-sm"
    class="relative text-muted-foreground hover:bg-muted hover:text-foreground"
    title="Memory consolidation"
    @click="$emit('click')"
  >
    <IconDatabase :size="16" />
    <span
      v-if="pendingCount > 0"
      class="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-1 rounded-full bg-violet-500 text-white text-[9px] leading-[14px] font-semibold text-center tabular-nums pointer-events-none"
    >{{ badge }}</span>
    <span
      v-if="showErrorDot"
      class="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full bg-error ring-2 ring-background pointer-events-none"
      title="Last consolidation failed"
    />
    <span
      v-if="isRunning"
      class="absolute inset-0 m-auto h-7 w-7 rounded-full border-2 border-transparent border-t-primary animate-spin pointer-events-none"
    />
  </Button>
</template>
