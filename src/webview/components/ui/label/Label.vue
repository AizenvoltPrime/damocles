<script setup lang="ts">
import type { LabelProps } from "reka-ui"
import { computed, type HTMLAttributes } from "vue"
import { Label } from "reka-ui"
import { cn } from "@/lib/utils"
import { definedProps } from "@/lib/definedProps"

const props = defineProps<LabelProps & { class?: HTMLAttributes["class"] }>()

const labelProps = computed(() => definedProps({ for: props.for, as: props.as, asChild: props.asChild }))
</script>

<template>
  <Label
    data-slot="label"
    v-bind="labelProps"
    :class="cn('flex items-center gap-2 text-sm leading-none font-medium select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50', props.class)"
  >
    <slot />
  </Label>
</template>
