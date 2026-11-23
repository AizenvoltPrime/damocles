<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { Time } from "@internationalized/date"
import { TimeFieldInput, TimeFieldRoot, type SegmentPart, type TimeValue } from "reka-ui"
import { computed, shallowRef, watch } from "vue"
import { cn } from "@/lib/utils"

// A time of day as "HH:mm", typed one segment at a time. The value is committed when focus leaves the field or on Enter,
// never on a segment edit; an entry with an empty segment commits nothing and the field shows the value it had.
const props = defineProps<{
  modelValue: string
  hourCycle: 12 | 24
  // BCP 47: the language of the day period's words
  locale?: string
  class?: HTMLAttributes["class"]
}>()

const emits = defineEmits<{
  commit: [value: string]
}>()

function parse(text: string): Time {
  const [hour = 0, minute = 0] = text.split(":").map(Number)
  return new Time(hour, minute)
}
const text = (value: TimeValue): string => `${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`

// null while a segment is empty
const draft = shallowRef<TimeValue | null>(parse(props.modelValue))
watch(() => props.modelValue, (value) => (draft.value = parse(value)))

// reka reads a day period only as the English AM and PM, so it gets an English locale of the hour cycle and the period's
// words are written here.
const fieldLocale = computed(() => (props.hourCycle === 12 ? "en-US" : "en-GB"))
const periods = computed(() => {
  const format = new Intl.DateTimeFormat(props.locale ?? "en", { hour: "numeric", hourCycle: "h12", timeZone: "UTC" })
  const word = (hour: number): string => format.formatToParts(Date.UTC(2024, 0, 1, hour)).find((part) => part.type === "dayPeriod")?.value ?? (hour < 12 ? "AM" : "PM")
  return { AM: word(6), PM: word(18) }
})
const periodText = (value: string): string => (value === "PM" ? periods.value.PM : periods.value.AM)

interface Segment {
  readonly part: SegmentPart
  readonly value: string
}
// reka leaves the space before a day period in place on a 24-hour clock, which has none
const shownSegments = (segments: readonly Segment[]): Segment[] => segments.filter((item, index) => item.part !== "literal" || index < segments.length - 1 || item.value.trim() !== "")

function settle(): void {
  const value = draft.value
  if (value === null) {
    draft.value = parse(props.modelValue)
    return
  }
  if (text(value) !== props.modelValue) emits("commit", text(value))
}

function onFocusOut(event: FocusEvent): void {
  const root = event.currentTarget as HTMLElement
  if (!(event.relatedTarget instanceof Node) || !root.contains(event.relatedTarget)) settle()
}
</script>

<template>
  <TimeFieldRoot
    :key="hourCycle"
    v-slot="{ segments }: { segments: Segment[] }"
    :model-value="draft"
    granularity="minute"
    :locale="fieldLocale"
    :hour-cycle="hourCycle"
    data-slot="time-field"
    :class="cn('inline-flex h-9 items-center rounded-md border border-input bg-transparent px-2 text-sm tabular-nums focus-within:ring-2 focus-within:ring-ring', props.class)"
    @update:model-value="(value: TimeValue | undefined) => (draft = value ?? null)"
    @focusout="onFocusOut"
    @keydown.enter="settle"
  >
    <template
      v-for="(item, index) in shownSegments(segments)"
      :key="index"
    >
      <TimeFieldInput
        v-if="item.part === 'literal'"
        :part="item.part"
        aria-hidden="true"
        class="whitespace-pre"
      >
        {{ item.value }}
      </TimeFieldInput>
      <TimeFieldInput
        v-else-if="item.part === 'dayPeriod'"
        :part="item.part"
        :aria-valuetext="periodText(item.value)"
        class="rounded-sm px-0.5 outline-none focus:bg-accent focus:text-accent-foreground"
      >
        {{ periodText(item.value) }}
      </TimeFieldInput>
      <TimeFieldInput
        v-else
        :part="item.part"
        class="rounded-sm px-0.5 outline-none focus:bg-accent focus:text-accent-foreground"
      >
        {{ item.value }}
      </TimeFieldInput>
    </template>
  </TimeFieldRoot>
</template>
