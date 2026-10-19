import type { Ref } from "vue"
import { createContext } from "reka-ui"
import { isMac } from "@/composables/usePlatformKey"

export { default as Command } from "./Command.vue"
export { default as CommandDialog } from "./CommandDialog.vue"
export { default as CommandEmpty } from "./CommandEmpty.vue"
export { default as CommandGroup } from "./CommandGroup.vue"
export { default as CommandInput } from "./CommandInput.vue"
export { default as CommandItem } from "./CommandItem.vue"
export { default as CommandList } from "./CommandList.vue"
export { default as CommandSeparator } from "./CommandSeparator.vue"
export { default as CommandShortcut } from "./CommandShortcut.vue"

export const [useCommand, provideCommandContext] = createContext<{
  allItems: Ref<Map<string, string>>
  allGroups: Ref<Map<string, Set<string>>>
  filterState: {
    search: string
    filtered: { count: number, items: Map<string, number>, groups: Set<string> }
  }
  /** The rows the keys move between, in list order, disabled ones left out. */
  rows: () => HTMLElement[]
}>("Command")

export const [useCommandGroup, provideCommandGroupContext] = createContext<{
  id?: string
}>("CommandGroup")

/**
 * VS Code's quickInput.first and quickInput.last chords (quickInputActions.ts): Ctrl+Home and Ctrl+End, also with Alt,
 * and with Cmd on macOS.
 */
export function isListEdgeChord(event: KeyboardEvent): boolean {
  return (event.key === "Home" || event.key === "End") && event.ctrlKey && !event.shiftKey && (isMac || !event.metaKey)
}

/**
 * VS Code's quickInput.pageNext and quickInput.pagePrevious keys (quickInputActions.ts): PageDown and PageUp, also with Ctrl
 * or Alt, and with Cmd on macOS.
 */
export function isListPageKey(event: KeyboardEvent): boolean {
  return (event.key === "PageDown" || event.key === "PageUp") && !event.shiftKey && (isMac || !event.metaKey)
}
