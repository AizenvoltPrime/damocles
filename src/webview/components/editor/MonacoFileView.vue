<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { baseEditorOptions, useMonaco } from './useMonaco';

const props = defineProps<{
  document: { content: string; languageId: string };
  line?: number | undefined;
  untitled: boolean;
}>();

const monaco = useMonaco();
const container = shallowRef<HTMLElement | null>(null);
const ready = ref(false);
const revealedLine = ref<number | null>(null);
const disposables: { dispose(): void }[] = [];

onMounted(() => {
  if (!container.value) throw new Error('MonacoFileView mounted without its container');
  const model = monaco.editor.createModel(props.document.content, props.document.languageId);
  const editor = monaco.editor.create(container.value, { ...baseEditorOptions(), model });
  disposables.push(editor, model);
  if (props.line !== undefined) {
    const line = Math.min(Math.max(1, Math.trunc(props.line)), model.getLineCount());
    editor.createDecorationsCollection([
      { range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className: 'damocles-editor-highlight-line' } },
    ]);
    editor.setPosition({ lineNumber: line, column: 1 });
    editor.revealLineInCenter(line);
    revealedLine.value = line;
  }
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
    data-testid="editor-file-view"
    :data-monaco-ready="ready ? 'true' : undefined"
    :data-revealed-line="revealedLine ?? undefined"
    :data-untitled="untitled ? 'true' : undefined"
    class="absolute inset-0"
  />
</template>

<style>
/* Monaco renders this decoration's element itself, so a Tailwind class cannot reach it. */
.damocles-editor-highlight-line {
  background-color: color-mix(in srgb, var(--d-accent) 25%, transparent);
}
</style>
