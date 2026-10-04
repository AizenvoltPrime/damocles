<script setup lang="ts">
import { computed } from 'vue';
import MarkdownRenderer from './MarkdownRenderer.vue';

type Kind = 'empty' | 'string' | 'scalar' | 'string-array' | 'array' | 'object';

const props = defineProps<{ value: unknown }>();

function classify(value: unknown): Kind {
  if (value === null || value === undefined || value === '') return 'empty';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number' || typeof value === 'boolean') return 'scalar';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'empty';
    return value.every(item => typeof item === 'string') ? 'string-array' : 'array';
  }
  if (typeof value === 'object') return Object.keys(value).length ? 'object' : 'empty';
  return 'empty';
}

const kind = computed(() => classify(props.value));

const stringItems = computed(() => (kind.value === 'string-array' ? (props.value as string[]) : []));
const arrayItems = computed(() => (kind.value === 'array' ? (props.value as unknown[]) : []));
const entries = computed(() =>
  kind.value === 'object'
    ? Object.entries(props.value as Record<string, unknown>).filter(([, v]) => classify(v) !== 'empty')
    : [],
);

/** camelCase / snake_case / kebab-case key → "Title Case" heading. */
function humanize(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\w/, char => char.toUpperCase());
}

/** A slash-bearing token with no whitespace reads as a file path; prose with slashes (e.g. "Creation/Deletion") keeps its spaces and renders as text. */
function looksLikePath(value: string): boolean {
  return /[\\/]/.test(value) && !/\s/.test(value) && value.length < 300;
}
</script>

<template>
  <MarkdownRenderer
    v-if="kind === 'string'"
    :content="value as string"
    class="text-12.5"
  />
  <span
    v-else-if="kind === 'scalar'"
    class="text-12.5 text-(--d-text)"
  >{{ String(value) }}</span>

  <ul
    v-else-if="kind === 'string-array'"
    class="flex flex-col gap-1 text-12.5"
  >
    <li
      v-for="(item, index) in stringItems"
      :key="index"
      class="flex gap-2"
    >
      <span
        class="mt-2 size-1.25 flex-none rounded-full bg-(--d-accent)"
        aria-hidden="true"
      />
      <code
        v-if="looksLikePath(item)"
        class="rounded-5 bg-(--d-hover) px-1.5 py-px font-mono text-11.5 break-all text-(--d-accent-text)"
      >{{ item }}</code>
      <span
        v-else
        class="leading-relaxed text-(--d-text) text-pretty"
      >{{ item }}</span>
    </li>
  </ul>

  <div
    v-else-if="kind === 'array'"
    class="flex flex-col gap-2"
  >
    <StructuredResult
      v-for="(item, index) in arrayItems"
      :key="index"
      :value="item"
    />
  </div>

  <div
    v-else-if="kind === 'object'"
    class="flex flex-col gap-2.5"
  >
    <div
      v-for="[key, val] in entries"
      :key="key"
      class="flex flex-col gap-1"
    >
      <p class="text-10.5 font-semibold tracking-[.06em] text-(--d-faint) uppercase">
        {{ humanize(key) }}
      </p>
      <div class="border-l-2 border-(--d-border2) pl-3">
        <StructuredResult :value="val" />
      </div>
    </div>
  </div>
</template>
