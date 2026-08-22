<script setup lang="ts">
import type { DropdownMenuRadioGroupEmits, DropdownMenuRadioGroupProps } from "reka-ui"
import { definedProps } from "@/lib/definedProps"
import {
  DropdownMenuRadioGroup,
  useForwardPropsEmits,
} from "reka-ui"

const props = defineProps<DropdownMenuRadioGroupProps>()
const emits = defineEmits<DropdownMenuRadioGroupEmits>()

const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <DropdownMenuRadioGroup v-bind="definedProps(forwarded)">
    <slot />
  </DropdownMenuRadioGroup>
</template>
