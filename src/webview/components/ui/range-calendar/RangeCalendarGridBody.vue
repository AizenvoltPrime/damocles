<script lang="ts" setup>
import type { RangeCalendarGridBodyProps } from "reka-ui"
import { RangeCalendarGridBody } from "reka-ui"
import { definedProps } from "@/lib/definedProps"

const props = defineProps<RangeCalendarGridBodyProps>()
</script>

<template>
  <RangeCalendarGridBody v-bind="definedProps(props)">
    <slot />
  </RangeCalendarGridBody>
</template>
