<script setup lang="ts">
import type { AlertDialogContentEmits, AlertDialogContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  AlertDialogContent,
  AlertDialogOverlay,
  AlertDialogPortal,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@/lib/utils"
import { definedProps } from "@/lib/definedProps"
import { usePopperZIndex } from "@/composables/useOverlayEscape"

defineOptions({
  inheritAttrs: false,
})

const props = defineProps<AlertDialogContentProps & { class?: HTMLAttributes["class"] }>()
const emits = defineEmits<AlertDialogContentEmits>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)

// Portalled to `body`, so a confirmation opened from an overlay must paint above it, as popper content does.
const popperZIndex = usePopperZIndex()
</script>

<template>
  <AlertDialogPortal>
    <AlertDialogOverlay
      class="d-scrim fixed inset-0 bg-(--d-scrim) backdrop-blur-xs"
      :class="popperZIndex === undefined && 'z-50'"
      :style="popperZIndex === undefined ? undefined : { zIndex: popperZIndex }"
    />
    <AlertDialogContent
      v-bind="{ ...definedProps(forwarded), ...$attrs }"
      :style="popperZIndex === undefined ? undefined : { zIndex: popperZIndex }"
      :class="
        cn(
          popperZIndex === undefined && 'z-50',
          'd-dialog fixed left-1/2 top-1/2 grid w-full max-w-lg -translate-1/2 gap-4 rounded-2xl border border-(--d-border2) bg-(--d-card) p-6 text-(--d-text) shadow-(--d-shadow)',
          props.class,
        )
      "
    >
      <slot />
    </AlertDialogContent>
  </AlertDialogPortal>
</template>
