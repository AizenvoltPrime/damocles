<script setup lang="ts">
import type { PopoverAnchorProps } from "reka-ui"
import { PopoverAnchor } from "reka-ui"
import { definedProps } from "@/lib/definedProps"

const props = defineProps<PopoverAnchorProps>()
</script>

<template>
  <PopoverAnchor v-bind="definedProps(props)">
    <slot />
  </PopoverAnchor>
</template>
