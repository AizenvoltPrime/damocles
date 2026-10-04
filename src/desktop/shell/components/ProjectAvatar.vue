<script setup lang="ts">
import { computed } from 'vue';
import { avatarHue, avatarInitial } from '../project-avatar';

const props = defineProps<{ name: string }>();
const style = computed(() => ({ '--avatar-hue': String(avatarHue(props.name)) }));
</script>

<template>
  <span
    aria-hidden="true"
    class="project-avatar flex shrink-0 items-center justify-center font-bold"
    :style="style"
  >{{ avatarInitial(name) }}</span>
</template>
