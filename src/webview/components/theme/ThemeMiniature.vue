<script setup lang="ts">
import { computed, h, useId, watchEffect, type VNode } from 'vue';
import type { ThemeFile } from '@shared/themes/schema';
import { declareBundledFonts } from './font-faces';
import { miniatureNodes, type MiniatureMode, type MiniNode, type MiniThumbs } from './theme-view';

// A theme drawn from its own data (theme-view.ts): the host is one image named by `label`, such as "Bleach, dark and light
// looks"; nothing in it moves, and no custom CSS or page token reaches it.
const props = defineProps<{
  theme: ThemeFile;
  mode: MiniatureMode;
  label: string;
  // the wallpaper thumbnails the page holds by asset key, '' for one it lacks; absent: the installed theme's cache
  thumbs?: MiniThumbs;
}>();

const id = useId();
const nodes = computed(() => miniatureNodes(props.theme, props.mode, id, props.thumbs));
watchEffect(() => declareBundledFonts(props.theme));

const draw = (n: MiniNode): VNode => h(n.tag, n.attrs, n.text ?? n.children?.map(draw));
const Drawing = (): VNode => h('svg', { viewBox: '0 0 320 200', 'aria-hidden': 'true', focusable: 'false', preserveAspectRatio: 'xMidYMid slice', class: 'block size-full' }, nodes.value.map(draw));
</script>

<template>
  <div
    role="img"
    :aria-label="label"
    class="@container/mini relative block aspect-16/10 w-full overflow-hidden rounded-8"
    data-testid="theme-miniature"
  >
    <Drawing />
  </div>
</template>
