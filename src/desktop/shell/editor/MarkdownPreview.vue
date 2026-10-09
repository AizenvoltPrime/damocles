<script setup lang="ts">
import { computed, inject, onMounted, ref, shallowRef, watch } from 'vue';
import type { DamoclesShellApi, ShellEditorTab } from '../../preload/shell-channels';
import { EDITOR_STORE } from './editor-store';
import { markdownPreviewHtml, previewLink } from './markdown-html';

const props = defineProps<{ api: DamoclesShellApi; tab: ShellEditorTab }>();
const store = inject(EDITOR_STORE)!;
const root = ref<HTMLElement | null>(null);

// VS Code's markdown preview renders at most once per 300 ms while its document changes (preview.ts #delay).
const UPDATE_DELAY_MS = 300;

const content = computed(() => (props.tab.documentId === undefined ? undefined : store.contents.value.get(props.tab.documentId)));
// The buffer, while a source tab or a search has one, holds the unsaved text; main's content changes only when main replaces
// the text (a reload or a revert), never on a keystroke or a save.
const buffer = computed(() => (props.tab.documentId === undefined ? undefined : store.bufferModel(props.tab.documentId)));
const bufferText = shallowRef('');
watch(buffer, (model, _previous, onCleanup) => {
  if (!model) return;
  bufferText.value = model.getValue();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listener = model.onDidChangeContent(() => {
    timer ??= setTimeout(() => {
      timer = undefined;
      if (!model.isDisposed()) bufferText.value = model.getValue();
    }, UPDATE_DELAY_MS);
  });
  onCleanup(() => {
    clearTimeout(timer);
    listener.dispose();
  });
}, { immediate: true });
const source = computed(() => (buffer.value ? bufferText.value : content.value?.kind === 'text' ? content.value.text : ''));
// Sanitized by markdownPreviewHtml: the file's raw HTML renders only through its DOMPurify allowlist.
const html = computed(() => markdownPreviewHtml(source.value));

onMounted(() => {
  if (props.tab.documentId !== undefined) void store.load(props.tab.documentId);
});

const slug = (text: string): string => text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');

function onClick(event: MouseEvent): void {
  const anchor = (event.target as Element | null)?.closest('a');
  const href = anchor?.getAttribute('href');
  if (!anchor || href === null || href === undefined) return;
  const link = previewLink(href, props.tab.relativePath);
  // An http(s) link opens a window, which main denies and hands to the system browser.
  if (link?.kind === 'external') {
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener noreferrer');
    return;
  }
  event.preventDefault();
  if (link?.kind === 'anchor') {
    const heading = [...(root.value?.querySelectorAll('h1, h2, h3, h4, h5, h6') ?? [])].find((element) => slug(element.textContent ?? '') === link.id);
    heading?.scrollIntoView({ block: 'start' });
  } else if (link?.kind === 'file' && props.tab.projectKey !== undefined) {
    void props.api.openEditor({ projectKey: props.tab.projectKey, relativePath: link.relativePath });
  }
}
</script>

<template>
  <!-- contain: paint keeps anything the file's HTML positions inside the preview. -->
  <div
    data-testid="markdown-preview"
    class="absolute inset-0 overflow-auto bg-(--d-bg) contain-[paint]"
  >
    <!-- eslint-disable vue/no-v-html -- markdownPreviewHtml sanitizes with DOMPurify -->
    <article
      ref="root"
      class="md-preview"
      @click="onClick"
      v-html="html"
    />
    <!-- eslint-enable vue/no-v-html -->
  </div>
</template>
