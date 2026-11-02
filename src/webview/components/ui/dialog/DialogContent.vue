<script setup lang="ts">
import type { DialogContentEmits, DialogContentProps } from "reka-ui"
import { useTemplateRef, type ComponentPublicInstance, type HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { X } from "lucide-vue-next"
import { useI18n } from "vue-i18n"
import {
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
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
  // inline: rendered in place, not teleported to body, so the leave transition of the element holding it plays its exit;
  // scrim false: no dimmed layer behind it, for a panel hung from what opened it
  defineProps<DialogContentProps & { class?: HTMLAttributes["class"]; showClose?: boolean; inline?: boolean; scrim?: boolean }>(),
  { showClose: true, inline: false, scrim: true },
)
const emits = defineEmits<DialogContentEmits>()

const delegatedProps = reactiveOmit(props, "class", "showClose", "inline", "scrim")

const forwarded = useForwardPropsEmits(delegatedProps, emits)
const { t } = useI18n()

// A layer of the overlay stack while open, so it paints above the overlay it was opened from and below one opened over it.
const zIndex = useDialogLayer(useTemplateRef<ComponentPublicInstance>("content"))
// reka's own exit keeps a closing dialog its highest dismissable layer, so the dialog beneath would not hear Escape until the
// exit ends; unmounted at once, the content leaves reka's layers and its element plays the exit in the Transition
const dialog = injectDialogRootContext()
</script>

<template>
  <DialogPortal :disabled="props.inline">
    <Transition @before-leave="markClosed">
      <DialogOverlay
        v-if="dialog.open.value && props.scrim"
        force-mount
        class="d-scrim fixed inset-0 bg-(--d-scrim) backdrop-blur-xs"
        :style="{ zIndex }"
      />
    </Transition>
    <Transition @before-leave="markClosed">
      <DialogContent
        v-if="dialog.open.value"
        ref="content"
        v-bind="{ ...definedProps(forwarded), ...$attrs }"
        force-mount
        :style="{ zIndex }"
        :class="
          cn(
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
    </Transition>
  </DialogPortal>
</template>
