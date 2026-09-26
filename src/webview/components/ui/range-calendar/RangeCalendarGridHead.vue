<script lang="ts" setup>
import type { RangeCalendarGridHeadProps } from "reka-ui"
import { RangeCalendarGridHead } from "reka-ui"
import { definedProps } from "@/lib/definedProps"

const props = defineProps<RangeCalendarGridHeadProps>()
</script>

<template>
  <RangeCalendarGridHead v-bind="definedProps(props)">
    <slot />
  </RangeCalendarGridHead>
</template>
