<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ToolCall } from '@shared/types/session';
import type { FormFieldSchema, FormResult } from '@shared/types/forms';

import { Ban, CircleCheck, CircleX, Lock, SquarePen } from 'lucide-vue-next';
import ToolCardFrame from './ToolCardFrame.vue';
import ToolCardNote from './ToolCardNote.vue';

const props = defineProps<{
  toolCall: ToolCall;
}>();

const { t } = useI18n();

// The persisted tool INPUT is the FormSchema of labels, types and selectors. It never holds values.
const schema = computed(() => {
  const input = props.toolCall.input as { title?: string; fields?: unknown };
  const fields = Array.isArray(input?.fields) ? (input.fields as FormFieldSchema[]) : [];
  return { title: typeof input?.title === 'string' ? input.title : undefined, fields };
});

// The persisted tool RESULT is the REDACTED FormResult (no values, by construction).
const result = computed<FormResult | null>(() => {
  if (!props.toolCall.result) return null;
  try {
    const parsed = JSON.parse(props.toolCall.result);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.fields)) {
      return parsed as FormResult;
    }
    return null;
  } catch {
    return null;
  }
});

interface FieldRow {
  label: string;
  type: string;
  ok: boolean | null;
  reason?: string;
  masked: boolean;
  skipped?: boolean;
}

// Merge schema (labels/types) with the redacted per-field result state. Masking comes from the result's
// own per-field `masked` flag (set from `sensitive` in buildRedactedResult) plus the password type,
// never keyed by label, so two fields sharing a label can't over- or under-mask each other.
const fieldRows = computed<FieldRow[]>(() => {
  const res = result.value;

  if (res) {
    return res.fields.map((f): FieldRow => ({
      label: f.label,
      type: f.type,
      ok: f.ok,
      ...(f.reason !== undefined && { reason: f.reason }),
      masked: f.masked === true || f.type === 'password',
      skipped: f.skipped === true,
    }));
  }

  // No result yet, so the proposed schema is what renders.
  return schema.value.fields.map((f): FieldRow => ({
    label: f.label,
    type: f.type,
    ok: null,
    masked: f.sensitive === true || f.type === 'password',
  }));
});

const filledCount = computed(() => result.value?.filled ?? 0);
const totalCount = computed(() => fieldRows.value.length);
const submitted = computed(() => result.value?.submitted === true);

// The submit-status line is only meaningful when the request asked the page's form to be submitted
// (a submitSelector). Without one, the tool's job was purely to inject values, so a "Not submitted"
// badge would be misleading noise.
const hasSubmitSelector = computed(() => {
  const input = props.toolCall.input as { submitSelector?: unknown };
  return typeof input?.submitSelector === 'string' && input.submitSelector.length > 0;
});

const isAwaitingApproval = computed(() => props.toolCall.status === 'awaiting_approval');
const isFailed = computed(() => props.toolCall.status === 'failed');
const isDenied = computed(() => props.toolCall.status === 'denied');
const isAbandoned = computed(() => props.toolCall.status === 'abandoned');

const headerText = computed(() => {
  const title = schema.value.title;
  if (title) return title;
  const n = totalCount.value;
  return n === 1 ? t('formTool.headerOne') : t('formTool.headerOther', { n });
});
</script>

<template>
  <ToolCardFrame
    :icon="SquarePen"
    :name="headerText"
    :status="toolCall.status"
    data-testid="form-tool-card"
  >
    <div
      v-for="(field, idx) in fieldRows"
      :key="idx"
      class="flex items-start gap-2 border-t border-(--d-border) px-3 py-2"
    >
      <span class="flex h-4.5 w-4 flex-none items-center justify-center">
        <CircleCheck
          v-if="field.ok === true && !field.skipped"
          class="size-3 text-(--d-success)"
          aria-hidden="true"
        />
        <CircleX
          v-else-if="field.ok === false"
          class="size-3 text-(--d-danger)"
          aria-hidden="true"
        />
        <span
          v-else
          class="size-1.5 rounded-full bg-(--d-faint)"
          aria-hidden="true"
        />
      </span>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1.5">
          <Lock
            v-if="field.masked"
            class="size-2.75 flex-none text-(--d-faint)"
            aria-hidden="true"
          />
          <span class="truncate text-12.5">{{ field.label }}</span>
          <span class="flex-none rounded-5 bg-(--d-hover) px-1.5 font-mono text-10.5 text-(--d-muted)">{{ field.type }}</span>
        </div>
        <!-- Value slot: masked fields render dots; there are never raw values to show. -->
        <div
          v-if="field.masked && !field.skipped"
          class="mt-0.5 text-xs tracking-widest text-(--d-faint)"
        >
          ••••
        </div>
        <div
          v-if="field.skipped"
          class="mt-0.5 text-xs text-(--d-faint)"
        >
          {{ t('formTool.skipped') }}
        </div>
        <div
          v-if="field.ok === false && field.reason"
          class="mt-0.5 text-xs text-(--d-danger)"
        >
          {{ field.reason }}
        </div>
      </div>
    </div>

    <div
      v-if="result"
      class="flex items-center gap-3 border-t border-(--d-border) px-3 py-1.5 font-mono text-11 text-(--d-faint)"
    >
      <span>{{ t('formTool.filled', { filled: filledCount, total: totalCount }) }}</span>
      <span
        v-if="hasSubmitSelector"
        class="flex items-center gap-1"
      >
        <component
          :is="submitted ? CircleCheck : Ban"
          class="size-3"
          :class="submitted ? 'text-(--d-success)' : 'text-(--d-faint)'"
          aria-hidden="true"
        />
        {{ submitted ? t('formTool.submitted') : t('formTool.notSubmitted') }}
      </span>
    </div>

    <ToolCardNote
      v-if="isAwaitingApproval"
      tone="text-(--d-warning)"
      waiting
      :text="t('formTool.waiting')"
    />
    <ToolCardNote
      v-else-if="isDenied"
      tone="text-(--d-danger)"
      :icon="CircleX"
      :text="t('formTool.cancelled')"
    />
    <ToolCardNote
      v-else-if="isFailed"
      tone="text-(--d-danger)"
      :icon="CircleX"
      :text="t('formTool.failed')"
    />
    <ToolCardNote
      v-else-if="isAbandoned"
      tone="text-(--d-muted)"
      :icon="Ban"
      :text="t('formTool.movedOn')"
    />
  </ToolCardFrame>
</template>
