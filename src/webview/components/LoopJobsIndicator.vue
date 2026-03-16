<script setup lang="ts">
import { IconRepeat } from '@/components/icons';
import { useLoopJobsStore } from '@/stores/useLoopJobsStore';

const store = useLoopJobsStore();

defineEmits<{
  (e: 'click'): void;
}>();
</script>

<template>
  <button
    v-if="store.activeJobCount > 0"
    class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium
           bg-amber-500/15 text-amber-400 hover:bg-amber-500/25 transition-colors cursor-pointer border-0"
    @click="$emit('click')"
  >
    <IconRepeat :size="12" class="animate-spin" style="animation-duration: 3s" />
    <span class="tabular-nums">{{ store.activeJobCount }}</span>
    <span>{{ store.activeJobCount === 1 ? 'job' : 'jobs' }}</span>
  </button>
</template>
