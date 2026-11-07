<script setup lang="ts">
// Why a blocked tool call did not run, at the foot of its card.
defineProps<{ reason: string }>();
</script>

<template>
  <p class="pe-3 pb-2.5 ps-10 text-xs text-pretty wrap-anywhere text-(--d-muted)">
    {{ reason }}
  </p>
</template>
