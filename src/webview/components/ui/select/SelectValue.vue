<script setup lang="ts">
import type { SelectValueProps } from "reka-ui"
import { SelectValue } from "reka-ui"
import { definedProps } from "@/lib/definedProps"

const props = defineProps<SelectValueProps>()
</script>

<template>
  <SelectValue v-bind="definedProps(props)">
    <slot />
  </SelectValue>
</template>
