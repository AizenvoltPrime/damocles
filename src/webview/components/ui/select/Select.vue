<script setup lang="ts">
import type { SelectRootEmits, SelectRootProps } from "reka-ui"
import { SelectRoot, useForwardPropsEmits } from "reka-ui"
import { definedProps } from "@/lib/definedProps"

// Every SelectItem in this app is string-valued, so the root is instantiated at `string` instead of
// reka-ui's default AcceptableValue. Call sites then bind a plain `(value: string)` handler.
const props = defineProps<SelectRootProps<string>>()
const emits = defineEmits<SelectRootEmits<string>>()

const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <SelectRoot v-bind="definedProps(forwarded)">
    <slot />
  </SelectRoot>
</template>
