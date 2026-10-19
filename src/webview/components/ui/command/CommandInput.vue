<script setup lang="ts">
import type { ListboxFilterProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { Search } from "lucide-vue-next"
import { injectListboxRootContext, ListboxFilter, useForwardProps } from "reka-ui"
import { computed } from "vue"
import { cn } from "@/lib/utils"
import { isListEdgeChord, isListPageKey, useCommand } from "."
import { pageRow } from "./page"
import { definedProps } from "@/lib/definedProps"

defineOptions({
  inheritAttrs: false,
})

const props = defineProps<ListboxFilterProps & {
  class?: HTMLAttributes["class"]
  wrapperClass?: HTMLAttributes["class"]
}>()

const emits = defineEmits<{ "update:modelValue": [value: string] }>()

const delegatedProps = reactiveOmit(props, "class", "wrapperClass", "modelValue")

const forwardedProps = useForwardProps(delegatedProps)

const { filterState, rows } = useCommand()
const listbox = injectListboxRootContext()

// A bound v-model hands filtering to the caller, so the list's own text filter stays off.
const search = computed({
  get: () => props.modelValue ?? filterState.search,
  set: (value: string) => {
    if (props.modelValue === undefined) filterState.search = value
    else emits("update:modelValue", value)
  },
})

function onKeydown(event: KeyboardEvent) {
  // An editable combobox's Home and End move the caret (WAI-ARIA APG); reka's filter would take them for the list.
  if ((event.key === "Home" || event.key === "End") && !isListEdgeChord(event)) {
    event.stopPropagation()
  }
  else if (isListPageKey(event)) {
    event.preventDefault()
    const row = pageRow(rows(), listbox.highlightedElement.value, event.key === "PageDown")
    if (row) listbox.changeHighlight(row)
  }
}
</script>

<template>
  <div
    :class="cn('flex items-center border-b px-3', props.wrapperClass)"
    cmdk-input-wrapper
    @keydown.capture="onKeydown"
  >
    <Search class="mr-2 size-4 shrink-0 opacity-50" />
    <ListboxFilter
      v-bind="{ ...definedProps(forwardedProps), ...$attrs }"
      v-model="search"
      auto-focus
      :class="cn('flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50', props.class)"
    />
  </div>
</template>
