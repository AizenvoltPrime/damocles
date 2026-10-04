<script setup lang="ts">
import type { PopoverContentEmits, PopoverContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  PopoverContent,
  PopoverPortal,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@/lib/utils"
import { definedProps } from "@/lib/definedProps"
import { usePopperZIndex } from "@/composables/useOverlayEscape"
import { remPx } from "@/composables/useRemPx"

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(
  defineProps<PopoverContentProps & { class?: HTMLAttributes["class"] }>(),
  {
    align: "center",
  },
)
const emits = defineEmits<PopoverContentEmits>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)

const popperZIndex = usePopperZIndex()
</script>

<template>
  <PopoverPortal>
    <PopoverContent
      v-bind="{ ...definedProps(forwarded), ...$attrs }"
      :side-offset="props.sideOffset ?? remPx(0.25)"
      :style="popperZIndex === undefined ? undefined : { zIndex: popperZIndex }"
      :class="
        cn(
          popperZIndex === undefined && 'z-50',
          'w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none d-popper',
          props.class,
        )
      "
    >
      <slot />
    </PopoverContent>
  </PopoverPortal>
</template>
