<script setup lang="ts">
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

interface TooltipItem {
  name: string
  color: string
  value: string | number
}

defineProps<{
  title?: string
  data: TooltipItem[]
}>()

defineSlots<{
  icon?: (props: { item: TooltipItem, index: number }) => unknown
}>()
</script>

<template>
  <Card class="rounded-md text-xs shadow-md">
    <CardHeader v-if="title" class="border-b px-2.5 py-1.5">
      <CardTitle class="text-xs font-medium">
        {{ title }}
      </CardTitle>
    </CardHeader>
    <CardContent class="flex min-w-40 flex-col gap-1 px-2.5 py-1.5">
      <div v-for="(item, index) in data" :key="index" class="flex justify-between gap-4">
        <div class="flex min-w-0 items-center gap-1.5">
          <span class="size-2.5 shrink-0 rounded-sm" :style="{ backgroundColor: item.color }" />
          <slot name="icon" :item="item" :index="index" />
          <span class="truncate">{{ item.name }}</span>
        </div>
        <span class="font-semibold tabular-nums">{{ item.value }}</span>
      </div>
    </CardContent>
  </Card>
</template>
