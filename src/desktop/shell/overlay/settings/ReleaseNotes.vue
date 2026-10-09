<script setup lang="ts">
import { computed } from 'vue';
import { releaseNotesHtml } from './release-notes-html';

const props = defineProps<{ source: string }>();

const html = computed(() => releaseNotesHtml(props.source));
</script>

<template>
  <!-- eslint-disable vue/no-v-html -- releaseNotesHtml sanitizes with DOMPurify -->
  <div
    class="release-notes"
    data-testid="release-notes"
    v-html="html"
  />
  <!-- eslint-enable vue/no-v-html -->
</template>
