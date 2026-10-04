<script setup lang="ts">
import type { DropdownMenuContentEmits, DropdownMenuContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  DropdownMenuContent,
  DropdownMenuPortal,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@/lib/utils"
import { definedProps } from "@/lib/definedProps"
import { usePopperZIndex } from "@/composables/useOverlayEscape"
import { remPx } from "@/composables/useRemPx"

defineOptions({
  inheritAttrs: false,
})

const props = defineProps<DropdownMenuContentProps & { class?: HTMLAttributes["class"] }>()
const emits = defineEmits<DropdownMenuContentEmits>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)

const popperZIndex = usePopperZIndex()
</script>

<template>
  <DropdownMenuPortal>
    <DropdownMenuContent
      v-bind="{ ...definedProps(forwarded), ...$attrs }"
      :side-offset="props.sideOffset ?? remPx(0.25)"
      :style="popperZIndex === undefined ? undefined : { zIndex: popperZIndex }"
      :class="cn(popperZIndex === undefined && 'z-50', 'min-w-32 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md d-popper', props.class)"
    >
      <slot />
    </DropdownMenuContent>
  </DropdownMenuPortal>
</template>
