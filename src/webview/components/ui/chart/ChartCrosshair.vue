<script setup lang="ts">
import type { BulletLegendItemInterface } from "@unovis/ts"
import type { Component } from "vue"
import { omit } from "@unovis/ts"
import { VisCrosshair, VisTooltip } from "@unovis/vue"
import { createApp } from "vue"
import { ChartTooltip } from "."

const props = withDefaults(defineProps<{
  colors: string[]
  index: string
  items: BulletLegendItemInterface[]
  customTooltip?: Component
  /** Anything the tooltip renders that is not in the datum, such as a billing flag; a change re-renders every cached tooltip. */
  tooltipKey?: string
}>(), {
  colors: () => [],
})

type Datum = Record<string, unknown>

// Unovis takes the tooltip as an HTML string, so each datum's markup is rendered once and cached.
const wm = new WeakMap<Datum, { key: string | undefined, html: string }>()
function template(d: Datum): string {
  const cached = wm.get(d)
  if (cached !== undefined && cached.key === props.tooltipKey) return cached.html
  const componentDiv = document.createElement("div")
  const omittedData = Object.entries(omit(d, [props.index])).map(([key, value]) => {
    const legendReference = props.items.find(i => i.name === key)
    return { ...legendReference, value }
  })
  const app = createApp(props.customTooltip ?? ChartTooltip, { title: String(d[props.index]), data: omittedData })
  app.mount(componentDiv)
  const html = componentDiv.innerHTML
  app.unmount()
  wm.set(d, { key: props.tooltipKey, html })
  return html
}

function color(_d: unknown, i: number): string {
  return props.colors[i] ?? "transparent"
}
</script>

<template>
  <VisTooltip :horizontal-shift="20" :vertical-shift="20" />
  <VisCrosshair :template="template" :color="color" />
</template>
