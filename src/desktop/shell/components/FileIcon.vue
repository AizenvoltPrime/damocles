<script setup lang="ts">
import { computed } from 'vue';
import { ArrowUpRight } from 'lucide-vue-next';
import { fileIconLook } from '../file-icons';

// link: the entry is a link, drawn with an arrow in the icon's corner; 'broken' when what it points to is not there
const props = withDefaults(defineProps<{ path: string; directory?: boolean; open?: boolean; link?: boolean | 'broken' }>(), { directory: false, open: false, link: false });
// Rendered as one <img> across icon changes (expand, rename, theme kind): a new src keeps painting the current image until
// the next has loaded, where a new element paints nothing for a frame.
const look = computed(() => fileIconLook(props.path, props.directory, props.open));
</script>

<template>
  <span
    v-if="link"
    class="relative inline-flex"
    data-testid="file-icon-link"
    :data-broken="link === 'broken' || undefined"
  >
    <!-- The icon's corner under the badge is masked out, so whatever is behind the row shows there: a tint, a theme's wallpaper. -->
    <img
      v-if="'src' in look"
      :src="look.src"
      alt=""
      draggable="false"
      class="size-full mask-[linear-gradient(black,black),linear-gradient(black,black)] mask-position-[0_0,0_100%] mask-[100%_100%,--spacing(2)_--spacing(2)] mask-exclude mask-no-repeat"
    >
    <component
      :is="look.icon"
      v-else
      aria-hidden="true"
      class="size-full mask-[linear-gradient(black,black),linear-gradient(black,black)] mask-position-[0_0,0_100%] mask-[100%_100%,--spacing(2)_--spacing(2)] mask-exclude mask-no-repeat"
      :style="{ color: look.color }"
    />
    <span
      aria-hidden="true"
      class="absolute -bottom-0.5 -left-0.5 flex size-2.25 items-center justify-center"
      :class="link === 'broken' ? 'text-(--d-danger-text)' : 'text-(--d-text)'"
    >
      <ArrowUpRight
        class="size-2"
        :stroke-width="3"
      />
    </span>
  </span>
  <img
    v-else-if="'src' in look"
    :src="look.src"
    alt=""
    draggable="false"
  >
  <component
    :is="look.icon"
    v-else
    aria-hidden="true"
    :style="{ color: look.color }"
  />
</template>
