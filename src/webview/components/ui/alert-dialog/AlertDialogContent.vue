<script setup lang="ts">
import type { AlertDialogContentEmits, AlertDialogContentProps } from "reka-ui"
import { useTemplateRef, type ComponentPublicInstance, type HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import {
  AlertDialogContent,
  AlertDialogOverlay,
  AlertDialogPortal,
  injectDialogRootContext,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@/lib/utils"
import { definedProps } from "@/lib/definedProps"
import { markClosed, useDialogLayer } from "@/composables/useOverlayEscape"

defineOptions({
  inheritAttrs: false,
})

const props = withDefaults(
  // inline: rendered in place, not teleported to body, so the leave transition of the element holding it plays its exit
  defineProps<AlertDialogContentProps & { class?: HTMLAttributes["class"]; inline?: boolean }>(),
  { inline: false },
)
const emits = defineEmits<AlertDialogContentEmits>()

const delegatedProps = reactiveOmit(props, "class", "inline")

const forwarded = useForwardPropsEmits(delegatedProps, emits)

// A layer of the overlay stack while open, so it paints above the overlay it was opened from and below one opened over it.
const zIndex = useDialogLayer(useTemplateRef<ComponentPublicInstance>("content"))
// reka's own exit keeps a closing dialog its highest dismissable layer, so the dialog beneath would not hear Escape until the
// exit ends; unmounted at once, the content leaves reka's layers and its element plays the exit in the Transition
const dialog = injectDialogRootContext()
</script>

<template>
  <AlertDialogPortal :disabled="props.inline">
    <Transition @before-leave="markClosed">
      <AlertDialogOverlay
        v-if="dialog.open.value"
        force-mount
        class="d-scrim fixed inset-0 bg-(--d-scrim) backdrop-blur-xs"
        :style="{ zIndex }"
      />
    </Transition>
    <Transition @before-leave="markClosed">
      <AlertDialogContent
        v-if="dialog.open.value"
        ref="content"
        v-bind="{ ...definedProps(forwarded), ...$attrs }"
        force-mount
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
    </Transition>
  </AlertDialogPortal>
</template>
