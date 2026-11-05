<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <!-- no crumb is a link, so the current one is not announced as a disabled one -->
  <span
    aria-current="page"
    :class="cn('font-normal text-(--d-text)', props.class)"
  >
    <slot />
  </span>
</template>
