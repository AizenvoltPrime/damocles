<script setup lang="ts">
import type { AlertDialogContentEmits, AlertDialogContentProps } from "reka-ui"
import { useTemplateRef, type ComponentPublicInstance, type HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  AlertDialogContent,
  AlertDialogOverlay,
  AlertDialogPortal,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@/lib/utils"
import { definedProps } from "@/lib/definedProps"
import { useDialogLayer } from "@/composables/useOverlayEscape"

defineOptions({
  inheritAttrs: false,
})

const props = defineProps<AlertDialogContentProps & { class?: HTMLAttributes["class"] }>()
const emits = defineEmits<AlertDialogContentEmits>()

const delegatedProps = reactiveOmit(props, "class")

const forwarded = useForwardPropsEmits(delegatedProps, emits)

// A layer of the overlay stack while open, so it paints above the overlay it was opened from and below one opened over it.
const zIndex = useDialogLayer(useTemplateRef<ComponentPublicInstance>("content"))
</script>

<template>
  <AlertDialogPortal>
    <AlertDialogOverlay
      class="d-scrim fixed inset-0 bg-(--d-scrim) backdrop-blur-xs"
      :style="{ zIndex }"
    />
    <AlertDialogContent
      ref="content"
      v-bind="{ ...definedProps(forwarded), ...$attrs }"
      :style="{ zIndex }"
      :class="
        cn(
          'd-dialog fixed left-1/2 top-1/2 grid w-full max-w-lg -translate-1/2 gap-4 rounded-2xl border border-(--d-border2) bg-(--d-card) p-6 text-(--d-text) shadow-(--d-shadow)',
          props.class,
        )
      "
    >
      <slot />
    </AlertDialogContent>
  </AlertDialogPortal>
</template>
