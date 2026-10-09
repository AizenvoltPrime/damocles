<script setup lang="ts">
import { computed } from 'vue';
import ProjectAvatar from '../../components/ProjectAvatar.vue';
import { TONE_CLASSES, type NotificationView } from '../notification-view';

// The project's initial on its colour, else the app's, with the kind's badge on its corner.
const props = defineProps<{ view: NotificationView; size: 'toast' | 'row' }>();
const tone = computed(() => TONE_CLASSES[props.view.tone]);
const large = computed(() => props.size === 'toast');
</script>

<template>
  <div
    aria-hidden="true"
    class="relative shrink-0"
    :class="large ? 'size-11' : 'size-8'"
  >
    <ProjectAvatar
      v-if="view.project"
      :name="view.project.name"
      class="size-full"
      :class="large ? 'rounded-xl text-lg' : 'rounded-9 text-13'"
    />
    <span
      v-else
      class="flex size-full items-center justify-center bg-(--d-accent-soft) font-bold text-(--d-accent-text)"
      :class="large ? 'rounded-xl text-lg' : 'rounded-9 text-13'"
    >D</span>
    <span
      class="absolute flex items-center justify-center rounded-full border-2 border-(--d-card) text-(--d-bg)"
      :class="[tone.badge, large ? '-right-1 -bottom-1 size-5.5' : '-right-0.75 -bottom-0.75 size-4']"
    >
      <component
        :is="view.icon"
        :class="large ? 'size-2.75' : 'size-2'"
        :stroke-width="2.5"
      />
    </span>
  </div>
</template>
