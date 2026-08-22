<script setup lang="ts">
import type { DialogCloseProps } from "reka-ui"
import { DialogClose } from "reka-ui"
import { definedProps } from "@/lib/definedProps"

const props = defineProps<DialogCloseProps>()
</script>

<template>
  <DialogClose v-bind="definedProps(props)">
    <slot />
  </DialogClose>
</template>
