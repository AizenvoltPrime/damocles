<script setup lang="ts">
import type { CollapsibleTriggerProps } from "reka-ui"
import { CollapsibleTrigger } from "reka-ui"
import { definedProps } from "@/lib/definedProps"

const props = defineProps<CollapsibleTriggerProps>()
</script>

<template>
  <CollapsibleTrigger v-bind="definedProps(props)">
    <slot />
  </CollapsibleTrigger>
</template>
