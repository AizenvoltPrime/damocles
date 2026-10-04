<script setup lang="ts">
import type { DropdownMenuTriggerProps } from "reka-ui"
import { DropdownMenuTrigger, useForwardProps } from "reka-ui"
import { definedProps } from "@/lib/definedProps"

const props = defineProps<DropdownMenuTriggerProps>()

const forwardedProps = useForwardProps(props)
</script>

<template>
  <DropdownMenuTrigger v-bind="definedProps(forwardedProps)">
    <slot />
  </DropdownMenuTrigger>
</template>
