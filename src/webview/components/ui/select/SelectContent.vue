<script setup lang="ts">
import type { SelectContentEmits, SelectContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  SelectContent,
  SelectPortal,
  SelectViewport,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@/lib/utils"
import { SelectScrollDownButton, SelectScrollUpButton } from "."
import { definedProps } from "@/lib/definedProps"
import { usePopperZIndex } from "@/composables/useOverlayEscape"

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(
  defineProps<SelectContentProps & { class?: HTMLAttributes["class"] }>(),
  {
    position: "popper",
  },
)
const emits = defineEmits<SelectContentEmits>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)

const popperZIndex = usePopperZIndex()
</script>

<template>
  <SelectPortal>
    <SelectContent
      v-bind="{ ...definedProps(forwarded), ...$attrs }"
      :style="popperZIndex === undefined ? undefined : { zIndex: popperZIndex }"
      :class="cn(
        popperZIndex === undefined && 'z-50',
        'relative max-h-96 min-w-32 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md d-popper',
        position === 'popper'
          && 'data-[side=bottom]:translate-y-1 data-[side=left]:-translate-x-1 data-[side=right]:translate-x-1 data-[side=top]:-translate-y-1',
        props.class,
      )
      "
    >
      <SelectScrollUpButton />
      <SelectViewport :class="cn('p-1', position === 'popper' && 'h-[--reka-select-trigger-height] w-full min-w-[--reka-select-trigger-width]')">
        <slot />
      </SelectViewport>
      <SelectScrollDownButton />
    </SelectContent>
  </SelectPortal>
</template>
