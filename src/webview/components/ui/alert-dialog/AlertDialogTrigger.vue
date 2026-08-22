<script setup lang="ts">
import type { AlertDialogTriggerProps } from "reka-ui"
import { AlertDialogTrigger } from "reka-ui"
import { definedProps } from "@/lib/definedProps"

const props = defineProps<AlertDialogTriggerProps>()
</script>

<template>
  <AlertDialogTrigger v-bind="definedProps(props)">
    <slot />
  </AlertDialogTrigger>
</template>
