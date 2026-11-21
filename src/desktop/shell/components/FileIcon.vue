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
    <img
      v-if="'src' in look"
      :src="look.src"
      alt=""
      draggable="false"
      class="size-full"
    >
    <component
      :is="look.icon"
      v-else
      aria-hidden="true"
      class="size-full"
      :style="{ color: look.color }"
    />
    <!-- Hides the icon's corner in the row's colour: its --row-bg, which may be translucent, over the panel the row sits on. -->
    <span
      aria-hidden="true"
      class="absolute -bottom-0.5 -left-0.5 flex size-2.25 items-center justify-center rounded-xs bg-(--d-panel) bg-[linear-gradient(var(--row-bg),var(--row-bg))]"
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
