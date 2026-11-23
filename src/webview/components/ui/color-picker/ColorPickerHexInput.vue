<script setup lang="ts">
import { colorToString, injectColorFieldRootContext } from "reka-ui"
import { canonicalHexColor } from "@shared/hex-color"
import { Input } from "@/components/ui/input"

// escaped: the picker is cancelling, so a blur as it closes commits nothing
// opaque: only #rrggbb commits
const props = defineProps<{ label: string; escaped: () => boolean; opaque?: boolean }>()

const field = injectColorFieldRootContext()

// Only #rrggbb or #rrggbbaa commits: reka's parser also takes #rgb and rgb()/hsl() text, and its ColorFieldInput takes
// Home, End and the arrow keys from the caret. Unchanged text commits nothing, so tabbing through keeps a gray's hue.
function commit(): void {
  if (props.escaped()) return
  const text = field.inputValue.value.trim()
  const typed = text.startsWith("#") ? text : `#${text}`
  const value = props.opaque && typed.length !== 7 ? undefined : canonicalHexColor(typed)
  const current = colorToString(field.color.value, "hex")
  if (!value || value === canonicalHexColor(current)) {
    field.updateValue(current)
    return
  }
  field.updateValue(value)
  field.commit()
}
</script>

<template>
  <Input
    :model-value="field.inputValue.value"
    :aria-label="label"
    dir="ltr"
    spellcheck="false"
    autocomplete="off"
    :maxlength="opaque ? 7 : 9"
    class="h-7 min-w-0 flex-1 px-2 py-0 font-mono text-12"
    @update:model-value="(value: string | number) => field.updateValue(String(value))"
    @blur="commit"
    @keydown.enter.prevent="commit"
  />
</template>
