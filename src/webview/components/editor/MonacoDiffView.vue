<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { baseEditorOptions, useMonaco } from './useMonaco';

interface TextSide {
  content: string;
  languageId: string;
}

const props = defineProps<{ original: TextSide; modified: TextSide }>();

const monaco = useMonaco();
const container = shallowRef<HTMLElement | null>(null);
const ready = ref(false);
const disposables: { dispose(): void }[] = [];

onMounted(() => {
  if (!container.value) throw new Error('MonacoDiffView mounted without its container');
  const original = monaco.editor.createModel(props.original.content, props.original.languageId);
  const modified = monaco.editor.createModel(props.modified.content, props.modified.languageId);
  const editor = monaco.editor.createDiffEditor(container.value, {
    ...baseEditorOptions(),
    originalEditable: false,
    renderSideBySide: true,
  });
  // The editor is disposed first: the diff editor throws when a model it still shows is disposed.
  disposables.push(editor, original, modified);
  editor.setModel({ original, modified });
  ready.value = true;
});

onBeforeUnmount(() => {
  for (const d of disposables) d.dispose();
  disposables.length = 0;
});
</script>

<template>
  <div
    ref="container"
    data-testid="editor-diff-view"
    :data-monaco-ready="ready ? 'true' : undefined"
    class="absolute inset-0"
  />
</template>
