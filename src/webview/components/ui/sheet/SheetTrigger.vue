<script setup lang="ts">
import type { DialogTriggerProps } from "reka-ui"
import { DialogTrigger } from "reka-ui"
import { definedProps } from "@/lib/definedProps"

const props = defineProps<DialogTriggerProps>()
</script>

<template>
  <DialogTrigger v-bind="definedProps(props)">
    <slot />
  </DialogTrigger>
</template>
