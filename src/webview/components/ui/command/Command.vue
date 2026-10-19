<script setup lang="ts">
import type { AcceptableValue, ListboxRootEmits, ListboxRootProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { ListboxRoot, useFilter, useForwardPropsEmits } from "reka-ui"
import { reactive, ref, watch } from "vue"
import { cn } from "@/lib/utils"
import { provideCommandContext } from "."
import { definedProps } from "@/lib/definedProps"

const props = withDefaults(defineProps<ListboxRootProps & {
  class?: HTMLAttributes["class"]
  /** Keeps the highlighted item when the pointer leaves, as VS Code's quick pick keeps its active item. */
  keepHighlight?: boolean
}>(), {
  modelValue: "",
})

const emits = defineEmits<ListboxRootEmits>()

const delegatedProps = reactiveOmit(props, "class", "keepHighlight")

interface ListboxRootInstance {
  highlightedElement: HTMLElement | null
  highlightItem: (value: AcceptableValue) => void
  highlightFirstItem: () => void
  getItems: () => Array<{ ref: HTMLElement }>
}
const listbox = ref<ListboxRootInstance | null>(null)
let highlighted: HTMLElement | null = null

function onHighlight(payload: { ref: HTMLElement } | undefined) {
  highlighted = payload?.ref ?? null
}

// reka drops the highlight on pointerleave; restoring it without changeHighlight keeps the scroll where the user left it.
function onLeave(event: Event) {
  if (props.keepHighlight && event.type === "pointerleave" && highlighted?.isConnected && listbox.value)
    listbox.value.highlightedElement = highlighted
}

defineExpose({
  /** Highlights the item with this value and scrolls it into view. */
  highlightItem: (value: AcceptableValue) => listbox.value?.highlightItem(value),
  highlightFirstItem: () => listbox.value?.highlightFirstItem(),
  hasHighlight: () => listbox.value?.highlightedElement?.isConnected === true,
})

const forwarded = useForwardPropsEmits(delegatedProps, emits)

const allItems = ref<Map<string, string>>(new Map())
const allGroups = ref<Map<string, Set<string>>>(new Map())

const { contains } = useFilter({ sensitivity: "base" })
const filterState = reactive({
  search: "",
  filtered: {
    /** The count of all visible items. */
    count: 0,
    /** Map from visible item id to its search score. */
    items: new Map() as Map<string, number>,
    /** Set of groups with at least one visible item. */
    groups: new Set() as Set<string>,
  },
})

function filterItems() {
  if (!filterState.search) {
    filterState.filtered.count = allItems.value.size
    // Do nothing, each item will know to show itself because search is empty
    return
  }

  // Reset the groups
  filterState.filtered.groups = new Set()
  let itemCount = 0

  // Check which items should be included
  for (const [id, value] of allItems.value) {
    const score = contains(value, filterState.search)
    filterState.filtered.items.set(id, score ? 1 : 0)
    if (score)
      itemCount++
  }

  // Check which groups have at least 1 item shown
  for (const [groupId, group] of allGroups.value) {
    for (const itemId of group) {
      if (filterState.filtered.items.get(itemId)! > 0) {
        filterState.filtered.groups.add(groupId)
        break
      }
    }
  }

  filterState.filtered.count = itemCount
}

watch(() => filterState.search, () => {
  filterItems()
})

provideCommandContext({
  allItems,
  allGroups,
  filterState,
  rows: () => listbox.value?.getItems().map(item => item.ref) ?? [],
})
</script>

<template>
  <ListboxRoot
    ref="listbox"
    v-bind="definedProps(forwarded)"
    :class="cn('flex size-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground', props.class)"
    @highlight="onHighlight"
    @leave="onLeave"
  >
    <slot />
  </ListboxRoot>
</template>
