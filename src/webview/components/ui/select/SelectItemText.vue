<script setup lang="ts">
import type { SelectItemTextProps } from "reka-ui"
import { SelectItemText } from "reka-ui"
import { definedProps } from "@/lib/definedProps"

const props = defineProps<SelectItemTextProps>()
</script>

<template>
  <SelectItemText v-bind="definedProps(props)">
    <slot />
  </SelectItemText>
</template>
