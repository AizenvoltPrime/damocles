<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';

const props = defineProps<{
  src: string;
  alt?: string;
  title?: string;
}>();

const { t } = useI18n();
const loaded = ref(false);

// If Vue reuses this instance for a different image, re-gate it — else the new src auto-loads unopted.
watch(() => props.src, () => { loaded.value = false; });

// Display-only: a malformed src still shows a sensible label instead of throwing.
const host = computed(() => {
  try {
    return new URL(props.src).host;
  } catch {
    return t('remoteImage.unknownHost');
  }
});
</script>

<template>
  <!-- The <img> is absent from the DOM until clicked → zero network request until opt-in. -->
  <button
    v-if="!loaded"
    type="button"
    class="inline-flex cursor-pointer items-center gap-1 rounded-md border border-dashed border-(--d-border) bg-(--d-card) px-2 py-1 text-[0.85em] text-(--d-text) hover:bg-(--d-hover)"
    :title="title"
    @click="loaded = true"
  >
    {{ t('remoteImage.label', { host }) }}
  </button>
  <img
    v-else
    :src="src"
    :alt="alt"
    :title="title"
    class="markdown-image max-w-full rounded-md"
  >
</template>
