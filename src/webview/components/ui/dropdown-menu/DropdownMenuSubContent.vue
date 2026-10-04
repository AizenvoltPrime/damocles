<script setup lang="ts">
import type { DropdownMenuSubContentEmits, DropdownMenuSubContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  DropdownMenuSubContent,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@/lib/utils"
import { definedProps } from "@/lib/definedProps"
import { usePopperZIndex } from "@/composables/useOverlayEscape"

const props = defineProps<DropdownMenuSubContentProps & { class?: HTMLAttributes["class"] }>()
const emits = defineEmits<DropdownMenuSubContentEmits>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)

const popperZIndex = usePopperZIndex()
</script>

<template>
  <DropdownMenuSubContent
    v-bind="definedProps(forwarded)"
    :style="popperZIndex === undefined ? undefined : { zIndex: popperZIndex }"
    :class="cn(popperZIndex === undefined && 'z-50', 'min-w-32 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-lg d-popper', props.class)"
  >
    <slot />
  </DropdownMenuSubContent>
</template>
