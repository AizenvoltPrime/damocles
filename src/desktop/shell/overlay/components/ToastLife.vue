<script setup lang="ts">
// The 2px life bar along a toast's bottom edge. Its start and length are read once, when the toast mounts: the bar then
// runs on its own, and the toast pauses it while held (animation-play-state), as main pauses the toast's timer.
const props = defineProps<{ lifeMs: number; remainingMs: number; fillClass: string }>();
const style = {
  '--life-from': String(Math.min(1, Math.max(0, props.remainingMs / Math.max(1, props.lifeMs)))),
  animationDuration: `${Math.max(0, props.remainingMs)}ms`,
};
</script>

<template>
  <div
    aria-hidden="true"
    data-testid="overlay-toast-life"
    class="toast-life"
    :class="fillClass"
    :style="style"
  />
</template>
