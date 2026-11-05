<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <ol :class="cn('flex flex-wrap items-center gap-1.5 wrap-break-word text-xs text-(--d-faint-text)', props.class)">
    <slot />
  </ol>
</template>
