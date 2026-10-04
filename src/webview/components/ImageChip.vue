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
    class="inline-flex h-8 items-center gap-2 rounded-8 border border-(--d-border2) bg-(--d-card) ps-1 pe-2 text-xs text-(--d-text) transition-colors hover:border-(--d-accent)"
    :title="title"
    @click="handleClick"
  >
    <img
      v-if="thumbnailUrl"
      :src="thumbnailUrl"
      alt=""
      class="size-6 shrink-0 rounded-5 object-cover"
    />
    <IconImage v-else class="size-3.5 ms-1 shrink-0 text-(--d-muted)" />
    <span class="truncate max-w-[20ch]">{{ displayName }}</span>
    <span v-if="hasDimensions" class="shrink-0 font-mono text-11 tabular-nums text-(--d-muted)">{{ width }}×{{ height }}</span>
    <slot />
  </button>
</template>
