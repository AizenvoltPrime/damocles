<script setup lang="ts">
import type { TooltipTriggerProps } from "reka-ui"
import { TooltipTrigger } from "reka-ui"
import { definedProps } from "@/lib/definedProps"

const props = defineProps<TooltipTriggerProps>()
</script>

<template>
  <TooltipTrigger v-bind="definedProps(props)">
    <slot />
  </TooltipTrigger>
</template>
