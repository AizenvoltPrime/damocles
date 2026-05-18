<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import type { ExploreEntry } from '@/stores/useExploreStore';
import { formatModelDisplayName } from '@shared/utils';
import { Card, CardHeader, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { IconCompass, IconCheck, IconXCircle, IconGear } from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';

const props = defineProps<{
  explore: ExploreEntry;
}>();

defineEmits<{
  (e: 'expand'): void;
}>();

const elapsedSeconds = ref(0);
let timerInterval: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  if (props.explore.status === 'running') {
    updateElapsed();
    timerInterval = setInterval(updateElapsed, 1000);
  } else {
    updateElapsed();
  }
});

onUnmounted(() => {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
});

function updateElapsed(): void {
  const endTime = props.explore.endTime ?? Date.now();
  elapsedSeconds.value = Math.floor((endTime - props.explore.startTime) / 1000);
}

const formattedDuration = computed(() => {
  const elapsed = elapsedSeconds.value;
  if (elapsed < 60) return `${elapsed}s`;
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
});

const cardClass = computed(() => {
  switch (props.explore.status) {
    case 'running': return 'border-primary/50 hover:border-primary/70';
    case 'completed': return 'border-success/50 hover:border-success/70';
    case 'failed': return 'border-error/50 hover:border-error/70';
    default: return 'border-border';
  }
});

const statusBadgeClass = computed(() => {
  switch (props.explore.status) {
    case 'running': return 'bg-primary/30 text-primary border-primary/30';
    case 'completed': return 'bg-success/30 text-success border-success/30';
    case 'failed': return 'bg-error/30 text-error border-error/30';
    default: return 'bg-primary/30 text-primary border-primary/30';
  }
});

const displayModel = computed(() => formatModelDisplayName(props.explore.model));

const formattedToolCount = computed(() => `${props.explore.toolCount} tools`);

const metadataItems = computed(() => [
  formattedToolCount.value,
  formattedDuration.value,
  displayModel.value,
].filter(Boolean));
</script>

<template>
  <Card
    class="text-sm overflow-hidden cursor-pointer transition-colors"
    :class="cardClass"
    @click="$emit('expand')"
  >
    <CardHeader class="flex flex-row items-center gap-2 px-3 py-2 bg-foreground/5 border-b border-border/50 space-y-0">
      <IconCompass :size="18" class="text-primary shrink-0" />
      <span class="text-foreground font-medium truncate flex-1">{{ explore.description }}</span>
      <Badge variant="secondary" :class="statusBadgeClass" class="gap-1 shrink-0">
        <IconCompass :size="12" />
        <span>Explorer ({{ displayModel }})</span>
      </Badge>
    </CardHeader>

    <div
      v-if="explore.status === 'running' && explore.lastToolName"
      class="px-3 py-1.5 text-xs text-primary/80 italic truncate border-b border-border/30"
    >
      {{ explore.lastToolName }}
    </div>

    <CardContent class="px-3 py-2 flex items-center justify-between">
      <div class="flex items-center gap-1.5 text-xs text-foreground/70 leading-none">
        <IconGear :size="12" class="shrink-0" />
        <template v-for="(item, index) in metadataItems" :key="index">
          <span v-if="index > 0" class="text-foreground/40">&bull;</span>
          <span>{{ item }}</span>
        </template>
      </div>

      <div class="flex items-center">
        <LoadingSpinner v-if="explore.status === 'running'" :size="14" class="text-primary" />
        <IconCheck v-else-if="explore.status === 'completed'" :size="14" class="text-success" />
        <IconXCircle v-else-if="explore.status === 'failed'" :size="14" class="text-error" />
      </div>
    </CardContent>
  </Card>
</template>
