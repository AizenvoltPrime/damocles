<script setup lang="ts">
import type { CollapsibleContentProps } from "reka-ui"
import { CollapsibleContent } from "reka-ui"
import { definedProps } from "@/lib/definedProps"

const props = defineProps<CollapsibleContentProps>()
</script>

<template>
  <CollapsibleContent v-bind="definedProps(props)" class="d-collapsible overflow-hidden transition-all">
    <slot />
  </CollapsibleContent>
</template>
