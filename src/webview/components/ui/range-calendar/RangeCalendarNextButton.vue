<script lang="ts" setup>
import type { RangeCalendarNextProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { ChevronRight } from "lucide-vue-next"
import { RangeCalendarNext, useForwardProps } from "reka-ui"
import { cn } from "@/lib/utils"
import { definedProps } from "@/lib/definedProps"
import { buttonVariants } from '@/components/ui/button'

const props = defineProps<RangeCalendarNextProps & { class?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class")

const forwardedProps = useForwardProps(delegatedProps)
</script>

<template>
  <RangeCalendarNext
    :class="cn(
      buttonVariants({ variant: 'outline' }),
      'size-7 bg-transparent p-0 opacity-50 hover:opacity-100',
      props.class,
    )"
    v-bind="definedProps(forwardedProps)"
  >
    <slot>
      <ChevronRight class="size-4" />
    </slot>
  </RangeCalendarNext>
</template>
