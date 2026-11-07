<script setup lang="ts">
import type { RadioGroupItemProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { Circle } from "lucide-vue-next"
import { RadioGroupIndicator, RadioGroupItem, useForwardProps } from "reka-ui"
import { cn } from "@/lib/utils"
import { definedProps } from "@/lib/definedProps"

const props = defineProps<RadioGroupItemProps & { class?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class")

const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <RadioGroupItem
    v-bind="definedProps(forwardedProps)"
    :class="cn(
      'peer aspect-square size-4 shrink-0 cursor-pointer rounded-full border border-(--d-border2) text-(--d-accent) transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--d-accent) disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-(--d-accent)',
      props.class,
    )"
  >
    <RadioGroupIndicator class="flex items-center justify-center">
      <Circle class="size-2 fill-current text-current" />
    </RadioGroupIndicator>
  </RadioGroupItem>
</template>
