<script setup lang="ts">
import type { DialogContentEmits, DialogContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { X } from "lucide-vue-next"
import { useI18n } from "vue-i18n"
import {
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  useForwardPropsEmits,
} from "reka-ui"
import { cn } from "@/lib/utils"
import { definedProps } from "@/lib/definedProps"
import { usePopperZIndex } from "@/composables/useOverlayEscape"

const props = withDefaults(
  defineProps<DialogContentProps & { class?: HTMLAttributes["class"]; showClose?: boolean }>(),
  { showClose: true },
)
const emits = defineEmits<DialogContentEmits>()

const delegatedProps = reactiveOmit(props, "class", "showClose")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
const { t } = useI18n()

// Portalled to `body`, so a dialog opened from an overlay must paint above it, as popper content does.
const popperZIndex = usePopperZIndex()
</script>

<template>
  <DialogPortal>
    <DialogOverlay
      class="d-scrim fixed inset-0 bg-(--d-scrim) backdrop-blur-xs"
      :class="popperZIndex === undefined && 'z-50'"
      :style="popperZIndex === undefined ? undefined : { zIndex: popperZIndex }"
    />
    <DialogContent
      v-bind="definedProps(forwarded)"
      :style="popperZIndex === undefined ? undefined : { zIndex: popperZIndex }"
      :class="
        cn(
          popperZIndex === undefined && 'z-50',
          'd-dialog fixed left-1/2 top-1/2 grid w-full max-w-lg -translate-1/2 gap-4 rounded-2xl border border-(--d-border2) bg-(--d-card) p-6 text-(--d-text) shadow-(--d-shadow)',
          props.class,
        )"
    >
      <slot />

      <DialogClose
        v-if="props.showClose"
        class="absolute right-3.5 top-3.5 flex size-7.5 items-center justify-center rounded-9 text-(--d-muted) transition-colors hover:bg-(--d-hover) hover:text-(--d-text) focus-visible:outline-2 focus-visible:outline-(--d-accent) disabled:pointer-events-none"
      >
        <X
          class="size-4"
          aria-hidden="true"
        />
        <span class="sr-only">{{ t("overlay.close") }}</span>
      </DialogClose>
    </DialogContent>
  </DialogPortal>
</template>
