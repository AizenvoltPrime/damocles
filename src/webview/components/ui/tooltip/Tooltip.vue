<script setup lang="ts">
import type { TooltipRootEmits, TooltipRootProps } from "reka-ui"
import { TooltipProvider, TooltipRoot, useForwardPropsEmits } from "reka-ui"
import { definedProps } from "@/lib/definedProps"

// Each tooltip brings its own provider, so a view needs no provider of its own to show one.
const props = withDefaults(defineProps<TooltipRootProps>(), { delayDuration: 400 })
const emits = defineEmits<TooltipRootEmits>()

const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <TooltipProvider :delay-duration="props.delayDuration">
    <TooltipRoot v-bind="definedProps(forwarded)">
      <slot />
    </TooltipRoot>
  </TooltipProvider>
</template>
