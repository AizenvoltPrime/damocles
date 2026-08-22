<script setup lang="ts">
import type { DropdownMenuGroupProps } from "reka-ui"
import { DropdownMenuGroup } from "reka-ui"
import { definedProps } from "@/lib/definedProps"

const props = defineProps<DropdownMenuGroupProps>()
</script>

<template>
  <DropdownMenuGroup v-bind="definedProps(props)">
    <slot />
  </DropdownMenuGroup>
</template>
