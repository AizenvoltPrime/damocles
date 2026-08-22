<script setup lang="ts">
import { computed } from 'vue';
import { IconImage } from '@/components/icons';

const props = defineProps<{
  filename?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  title?: string | undefined;
  thumbnailUrl?: string | undefined;
}>();

const emit = defineEmits<{
  (e: 'click'): void;
}>();

const displayName = computed(() => props.filename || 'image.png');
const hasDimensions = computed(
  () => typeof props.width === 'number' && typeof props.height === 'number' && props.width > 0 && props.height > 0,
);

function handleClick(): void {
  emit('click');
}
</script>

<template>
  <button
    type="button"
    class="inline-flex items-center gap-2 h-8 rounded-md border border-border bg-muted/50 pl-1 pr-2 text-xs text-foreground hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 motion-safe:transition-colors cursor-pointer"
    :title="title"
    @click="handleClick"
  >
    <img
      v-if="thumbnailUrl"
      :src="thumbnailUrl"
      alt=""
      class="h-6 w-6 rounded object-cover shrink-0"
    />
    <IconImage v-else :size="14" class="shrink-0 opacity-70 ml-1" />
    <span class="truncate max-w-[20ch]">{{ displayName }}</span>
    <span v-if="hasDimensions" class="text-muted-foreground tabular-nums shrink-0">{{ width }}×{{ height }}</span>
    <slot />
  </button>
</template>
