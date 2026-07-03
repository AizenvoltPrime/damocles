<script setup lang="ts">
import { computed, ref, watch } from 'vue';

const props = defineProps<{
  src: string;
  alt?: string;
  title?: string;
}>();

const loaded = ref(false);

// If Vue reuses this instance for a different image, re-gate it — else the new src auto-loads unopted.
watch(() => props.src, () => { loaded.value = false; });

// Display-only: a malformed src still shows a sensible label instead of throwing.
const host = computed(() => {
  try {
    return new URL(props.src).host;
  } catch {
    return 'remote host';
  }
});
</script>

<template>
  <!-- The <img> is absent from the DOM until clicked → zero network request until opt-in. -->
  <button
    v-if="!loaded"
    type="button"
    class="remote-image-placeholder"
    :title="title"
    @click="loaded = true"
  >
    🖼️ image from {{ host }} — click to load
  </button>
  <img
    v-else
    :src="src"
    :alt="alt"
    :title="title"
    class="markdown-image"
  >
</template>

<style scoped>
.remote-image-placeholder {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  font-size: 0.85em;
  color: var(--vscode-foreground);
  background: var(--vscode-editorWidget-background, var(--vscode-textCodeBlock-background));
  border: 1px dashed var(--vscode-panel-border, var(--vscode-widget-border));
  border-radius: 4px;
  cursor: pointer;
}

.remote-image-placeholder:hover {
  background: var(--vscode-list-hoverBackground);
}

.markdown-image {
  max-width: 100%;
  border-radius: 4px;
}
</style>
