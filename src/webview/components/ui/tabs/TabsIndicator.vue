<script setup lang="ts">
import type { TabsIndicatorProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { TabsIndicator } from "reka-ui"
import { cn } from "@/lib/utils"
import { definedProps } from "@/lib/definedProps"

const props = defineProps<TabsIndicatorProps & { class?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class")
</script>

<template>
  <TabsIndicator
    v-bind="definedProps(delegatedProps)"
    :class="cn('absolute left-0 w-(--reka-tabs-indicator-size) translate-x-(--reka-tabs-indicator-position)', props.class)"
  >
    <slot />
  </TabsIndicator>
</template>
