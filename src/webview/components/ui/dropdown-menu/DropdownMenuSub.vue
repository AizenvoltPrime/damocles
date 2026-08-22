<script setup lang="ts">
import type { DropdownMenuSubEmits, DropdownMenuSubProps } from "reka-ui"
import { definedProps } from "@/lib/definedProps"
import {
  DropdownMenuSub,
  useForwardPropsEmits,
} from "reka-ui"

const props = defineProps<DropdownMenuSubProps>()
const emits = defineEmits<DropdownMenuSubEmits>()

const forwarded = useForwardPropsEmits(props, emits)
</script>

<template>
  <DropdownMenuSub v-bind="definedProps(forwarded)">
    <slot />
  </DropdownMenuSub>
</template>
