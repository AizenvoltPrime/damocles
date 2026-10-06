<script setup lang="ts">
import { ref } from 'vue';
import { ListboxContent } from 'reka-ui';
import { useDockPromptOptionsExplicitFocus, useDockPromptOptionsFocus } from '@/composables/useDockPrompt';

const content = ref<InstanceType<typeof ListboxContent> | null>(null);
const list = (): HTMLElement | undefined => content.value?.$el as HTMLElement | undefined;
useDockPromptOptionsFocus(list);
useDockPromptOptionsExplicitFocus(list);
</script>

<template>
  <ListboxContent ref="content">
    <slot />
  </ListboxContent>
</template>
