<script setup lang="ts">
import type { TooltipContentEmits, TooltipContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { TooltipContent, TooltipPortal, useForwardPropsEmits } from "reka-ui"
import { cn } from "@/lib/utils"
import { definedProps } from "@/lib/definedProps"
import { usePopperZIndex } from "@/composables/useOverlayEscape"
import { remPx } from "@/composables/useRemPx"

defineOptions({
  inheritAttrs: false,
})

const props = defineProps<TooltipContentProps & { class?: HTMLAttributes["class"] }>()
const emits = defineEmits<TooltipContentEmits>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)

const popperZIndex = usePopperZIndex()
</script>

<template>
  <TooltipPortal>
    <TooltipContent
      v-bind="{ ...definedProps(forwarded), ...$attrs }"
      :side-offset="props.sideOffset ?? remPx(0.25)"
      :style="popperZIndex === undefined ? undefined : { zIndex: popperZIndex }"
      :class="
        cn(
          popperZIndex === undefined && 'z-50',
          'max-w-65 rounded-md border border-(--d-border2) bg-(--d-card) px-2.5 py-1.5 text-xs text-(--d-text) shadow-(--d-shadow) d-popper',
          props.class,
        )
      "
    >
      <slot />
    </TooltipContent>
  </TooltipPortal>
</template>
