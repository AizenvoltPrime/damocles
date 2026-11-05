<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { Ellipsis } from "lucide-vue-next"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<!-- Decorative: the control that wraps it, such as a menu or tooltip trigger, carries the accessible name. -->
<template>
  <span
    role="presentation"
    aria-hidden="true"
    :class="cn('flex size-9 items-center justify-center', props.class)"
  >
    <slot>
      <Ellipsis class="size-4" />
    </slot>
  </span>
</template>
