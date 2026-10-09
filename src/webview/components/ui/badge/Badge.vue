<script setup lang="ts">
import type { PrimitiveProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import type { BadgeVariants } from "."
import { Primitive } from "reka-ui"
import { cn } from "@/lib/utils"
import { definedProps } from "@/lib/definedProps"
import { badgeVariants } from "."

interface Props extends PrimitiveProps {
  variant?: BadgeVariants["variant"]
  class?: HTMLAttributes["class"]
}

// Primitive renders a div when no `as` is given.
const props = defineProps<Props>()
</script>

<template>
  <Primitive
    v-bind="definedProps({ as, asChild })"
    :class="cn(badgeVariants({ variant }), props.class)"
  >
    <slot />
  </Primitive>
</template>
