<script setup lang="ts">
import { computed, toRef } from 'vue';
import MarkdownRenderer from './MarkdownRenderer.vue';
import { useTextStreaming } from '@/composables/useTextStreaming';

const props = defineProps<{
  content: string;
  isStreaming: boolean;
  isThinkingPhase: boolean;
}>();

const contentRef = toRef(props, 'content');
const isActiveRef = computed(() => props.isStreaming && !props.isThinkingPhase);

const { displayedContent } = useTextStreaming(contentRef, isActiveRef);

const renderedContent = computed(() =>
  props.isStreaming ? displayedContent.value : props.content
);
</script>

<template>
  <MarkdownRenderer
    class="text-13.5 leading-[1.65]"
    :content="renderedContent"
  />
</template>
