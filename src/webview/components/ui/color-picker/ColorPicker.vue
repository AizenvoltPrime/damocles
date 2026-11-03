<script setup lang="ts">
import type { Color, HSBColor } from "reka-ui"
import { computed, ref, watch, type PropType } from "vue"
import { useEventListener } from "@vueuse/core"
import {
  ColorAreaArea,
  ColorAreaRoot,
  ColorAreaThumb,
  ColorFieldRoot,
  ColorSwatch,
  SliderRoot,
  SliderThumb,
  SliderTrack,
  colorToString,
  convertToHsb,
  convertToRgb,
  getAreaBackgroundStyle,
  getSliderBackgroundStyle,
  normalizeColor,
} from "reka-ui"
import { canonicalHexColor, type HexColor } from "@shared/hex-color"
import ColorPickerHexInput from "./ColorPickerHexInput.vue"

// Runtime props: Vue infers Object, not String, for the branded HexColor type.
const props = defineProps({
  modelValue: { type: String as unknown as PropType<HexColor>, required: true },
  // the saturation and brightness area's group, and its thumb
  areaLabel: { type: String, required: true },
  areaThumbLabel: { type: String, required: true },
  hueLabel: { type: String, required: true },
  opacityLabel: { type: String, required: true },
  hexLabel: { type: String, required: true },
  previewLabel: { type: String, required: true },
  // full localized value texts, so a translation may reorder or reformat the numbers
  areaValueText: { type: Function as PropType<(saturation: number, brightness: number) => string>, required: true },
  hueValueText: { type: Function as PropType<(degrees: number) => string>, required: true },
  opacityValueText: { type: Function as PropType<(percent: number) => string>, required: true },
})

const emits = defineEmits<{
  "update:modelValue": [value: HexColor]
  commit: [value: HexColor]
}>()

function canonical(color: Color): HexColor {
  const hex = colorToString(color, "hex")
  const value = canonicalHexColor(hex)
  if (!value) throw new Error(`reka-ui gave a hex color outside #rrggbb[aa]: ${hex}`)
  return value
}

// The picker's own hsb is the state every part shows; reka's parts keep copies that lose the hue on a gray.
const color = ref<HSBColor>(convertToHsb(normalizeColor(props.modelValue)))
const draft = computed(() => canonical(color.value))
let committed = props.modelValue

// A gray has no hue and black no saturation, so a color given without them keeps the picker's.
function adopt(next: Color): HSBColor {
  const hsb = convertToHsb(next)
  return { ...hsb, h: hsb.s === 0 || hsb.b === 0 ? color.value.h : hsb.h, s: hsb.b === 0 ? color.value.s : hsb.s }
}

watch(() => props.modelValue, (value) => {
  if (value === draft.value) return
  color.value = adopt(normalizeColor(value))
  committed = value
})
watch(draft, (value) => emits("update:modelValue", value))

// A held key repeats; its moves commit once it is released, and a pointer drag commits at its end.
let keyHeld = false
let commitPending = false
// Escape cancels: what it leaves uncommitted, the hex text included, never commits, until the next key or pointer press.
let escaped = false

function emitCommit(): void {
  commitPending = false
  const value = draft.value
  if (escaped || value === committed) return
  committed = value
  emits("commit", value)
}

function requestCommit(): void {
  if (keyHeld) commitPending = true
  else emitCommit()
}

function release(): void {
  keyHeld = false
  if (commitPending) emitCommit()
}

function onKeyDown(event: KeyboardEvent): void {
  escaped = event.key === "Escape"
  keyHeld = !escaped
}

const root = ref<HTMLElement | null>(null)
// A keyup lost to another window would hold every later commit back.
function onFocusOut(event: FocusEvent): void {
  if (!root.value?.contains(event.relatedTarget as Node | null)) release()
}
useEventListener(window, "blur", release)

function moved(next: HSBColor): void {
  color.value = next
  if (keyHeld) commitPending = true
}

const onArea = (next: Color): void => moved({ ...convertToHsb(next), h: color.value.h })
// The area's x axis is saturation: Home and End go to its ends, as they do on the sliders.
function onAreaKey(event: KeyboardEvent): void {
  if (event.key !== "Home" && event.key !== "End") return
  event.preventDefault()
  event.stopPropagation()
  moved({ ...color.value, s: event.key === "Home" ? 0 : 100 })
}
const onHue = (value: number[] | undefined): void => {
  if (value?.[0] !== undefined) moved({ ...color.value, h: value[0] })
}
const onAlpha = (value: number[] | undefined): void => {
  if (value?.[0] !== undefined) moved({ ...color.value, alpha: value[0] / 100 })
}
function onField(next: Color): void {
  color.value = adopt(next)
  requestCommit()
}

const saturation = computed(() => Math.round(color.value.s))
const brightness = computed(() => Math.round(color.value.b))
const opacity = computed(() => Math.round(color.value.alpha * 100))
const areaStyle = computed(() => getAreaBackgroundStyle({ space: "hsb", h: color.value.h, s: 100, b: 100, alpha: 1 }, "saturation", "brightness", "hsb"))
const opaqueRgb = computed(() => {
  const { r, g, b } = convertToRgb(color.value)
  return `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`
})

const HUE_TRACK = getSliderBackgroundStyle({ space: "hsb", h: 0, s: 100, b: 100, alpha: 1 }, "hue", "hsb")
// The thumb sits on any picked color, so its ring is white in both themes, not a theme token. The ring paints over the
// shadow, so the dark edge spreads 3px to show 1px outside the 2px ring.
const THUMB = "block size-4 rounded-full ring-2 ring-white shadow-[0_0_0_3px_var(--d-scrim),0_1px_3px_var(--d-scrim)] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--d-accent)"
const SLIDER = "relative flex h-4 w-full touch-none items-center select-none"
const CHECKERBOARD = "bg-[repeating-conic-gradient(var(--d-border2)_0_25%,var(--d-panel)_0_50%)] bg-size-[0.5rem_0.5rem]"
</script>

<template>
  <div
    ref="root"
    class="flex flex-col gap-3"
    @keydown.capture="onKeyDown"
    @keyup.capture="release"
    @pointerdown.capture="escaped = false"
    @focusout="onFocusOut"
  >
    <ColorAreaRoot
      :model-value="color"
      color-space="hsb"
      x-channel="saturation"
      y-channel="brightness"
      as-child
      @update:color="onArea"
      @change-end="requestCommit"
    >
      <div :aria-label="areaLabel">
        <ColorAreaArea
          :style="areaStyle"
          :role="undefined"
          :aria-roledescription="undefined"
          data-color-area
          class="relative aspect-square w-full rounded-md"
        >
          <ColorAreaThumb
            :class="THUMB"
            :aria-label="areaThumbLabel"
            :aria-valuetext="areaValueText(saturation, brightness)"
            :aria-roledescription="undefined"
            @keydown="onAreaKey"
          />
        </ColorAreaArea>
      </div>
    </ColorAreaRoot>
    <SliderRoot
      :model-value="[color.h]"
      :min="0"
      :max="360"
      :class="SLIDER"
      @update:model-value="onHue"
      @value-commit="requestCommit"
    >
      <SliderTrack
        class="relative h-3 w-full grow rounded-full"
        :style="HUE_TRACK"
      />
      <SliderThumb
        :class="THUMB"
        :aria-label="hueLabel"
        :aria-valuetext="hueValueText(Math.round(color.h))"
      />
    </SliderRoot>
    <SliderRoot
      :model-value="[color.alpha * 100]"
      :min="0"
      :max="100"
      :class="SLIDER"
      @update:model-value="onAlpha"
      @value-commit="requestCommit"
    >
      <SliderTrack :class="['relative h-3 w-full grow overflow-hidden rounded-full', CHECKERBOARD]">
        <span
          class="absolute inset-0"
          :style="{ background: `linear-gradient(to right, transparent, ${opaqueRgb})` }"
        />
      </SliderTrack>
      <SliderThumb
        :class="THUMB"
        :aria-label="opacityLabel"
        :aria-valuetext="opacityValueText(opacity)"
      />
    </SliderRoot>
    <div class="flex items-center gap-2">
      <ColorSwatch
        :color="draft"
        :label="previewLabel"
        :aria-roledescription="undefined"
        :class="['size-7 shrink-0 overflow-hidden rounded-md border', CHECKERBOARD]"
      >
        <span class="block size-full bg-(--reka-color-swatch-color)" />
      </ColorSwatch>
      <ColorFieldRoot
        :model-value="color"
        class="flex min-w-0 flex-1"
        @update:color="onField"
      >
        <ColorPickerHexInput
          :label="hexLabel"
          :escaped="() => escaped"
        />
      </ColorFieldRoot>
      <span
        aria-hidden="true"
        class="w-9 shrink-0 text-right text-12 text-(--d-muted) tabular-nums"
      >{{ opacity }}%</span>
    </div>
  </div>
</template>
