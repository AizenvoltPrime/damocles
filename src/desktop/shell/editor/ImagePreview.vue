<script setup lang="ts">
import { computed, inject, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ShellEditorTab } from '../../preload/shell-channels';
import { EDITOR_STORE } from './editor-store';
import { fileSize } from './file-size';

const props = defineProps<{ tab: ShellEditorTab }>();
const { t, locale } = useI18n();
const store = inject(EDITOR_STORE)!;

// Only the image data URL main built; SVG renders through <img>, which runs no script and loads nothing.
const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg|gif|webp|bmp|x-icon|svg\+xml);base64,/;

const content = computed(() => (props.tab.documentId === undefined ? undefined : store.contents.value.get(props.tab.documentId)));
const source = computed(() => (content.value?.kind === 'image' && IMAGE_DATA_URL.test(content.value.dataUrl) ? content.value.dataUrl : undefined));
const natural = ref<{ width: number; height: number } | null>(null);
const bytes = computed(() => (content.value?.kind === 'image' ? content.value.bytes : 0));

function onLoad(event: Event): void {
  const image = event.target as HTMLImageElement;
  natural.value = { width: image.naturalWidth, height: image.naturalHeight };
}

onMounted(() => {
  if (props.tab.documentId !== undefined) void store.load(props.tab.documentId);
});
</script>

<template>
  <div
    data-testid="image-preview"
    class="image-preview absolute inset-0 flex flex-col items-center justify-center gap-3 overflow-auto p-6"
  >
    <img
      v-if="source"
      :src="source"
      :alt="tab.title"
      class="d-fade-in max-h-[calc(100%-2.5rem)] max-w-full rounded-lg object-contain shadow-(--d-shadow)"
      @load="onLoad"
    >
    <p
      v-if="natural"
      class="font-mono text-11 text-(--d-faint)"
    >
      {{ t('editor.image.meta', { width: natural.width, height: natural.height, size: fileSize(bytes, locale) }) }}
    </p>
  </div>
</template>
