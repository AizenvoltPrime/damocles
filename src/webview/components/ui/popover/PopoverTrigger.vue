<script setup lang="ts">
import type { PopoverTriggerProps } from "reka-ui"
import { PopoverTrigger } from "reka-ui"
import { definedProps } from "@/lib/definedProps"

const props = defineProps<PopoverTriggerProps>()
</script>

<template>
  <PopoverTrigger v-bind="definedProps(props)">
    <slot />
  </PopoverTrigger>
</template>
