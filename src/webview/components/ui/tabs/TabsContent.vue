<script setup lang="ts">
import type { TabsContentProps } from "reka-ui"
import type { HTMLAttributes } from "vue"
import { reactiveOmit } from "@vueuse/core"
import { TabsContent } from "reka-ui"
import { cn } from "@/lib/utils"
import { definedProps } from "@/lib/definedProps"

const props = defineProps<TabsContentProps & { class?: HTMLAttributes["class"] }>()

const delegatedProps = reactiveOmit(props, "class")
</script>

<template>
  <TabsContent v-bind="definedProps(delegatedProps)" :value="props.value" :class="cn('flex-1 outline-none', props.class)">
    <slot />
  </TabsContent>
</template>
