<script setup lang="ts">
import { ref } from 'vue';
import { ListboxContent } from 'reka-ui';
import { useDockPromptOptionsFocus } from '@/composables/useDockPrompt';

const content = ref<InstanceType<typeof ListboxContent> | null>(null);
useDockPromptOptionsFocus(() => content.value?.$el as HTMLElement | undefined);
</script>

<template>
  <ListboxContent ref="content">
    <slot />
  </ListboxContent>
</template>
