<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ToolCall } from '@shared/types/session';
import type { FormFieldSchema, FormResult } from '@shared/types/forms';

import { Card, CardHeader, CardContent } from '@/components/ui/card';
import {
  IconPencilSquare,
  IconGear,
  IconCheckCircle,
  IconXCircle,
  IconBan,
  IconLock,
} from '@/components/icons';
import LoadingSpinner from './LoadingSpinner.vue';

const props = defineProps<{
  toolCall: ToolCall;
}>();

const { t } = useI18n();

// The persisted tool INPUT is the FormSchema (labels/types/selectors) — never any values.
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
// own per-field `masked` flag (set from `sensitive` in buildRedactedResult) plus the password type —
// never keyed by label, so two fields sharing a label can't over- or under-mask each other.
const fieldRows = computed<FieldRow[]>(() => {
  const res = result.value;

  if (res) {
    return res.fields.map((f) => ({
      label: f.label,
      type: f.type,
      ok: f.ok,
      reason: f.reason,
      masked: f.masked === true || f.type === 'password',
      skipped: f.skipped === true,
    }));
  }

  // No result yet (pending/awaiting) — render the proposed schema.
  return schema.value.fields.map((f) => ({
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

const isPending = computed(() => props.toolCall.status === 'pending');
const isRunning = computed(() => props.toolCall.status === 'running');
const isAwaitingApproval = computed(() => props.toolCall.status === 'awaiting_approval');
const isCompleted = computed(() => props.toolCall.status === 'completed');
const isFailed = computed(() => props.toolCall.status === 'failed');
const isDenied = computed(() => props.toolCall.status === 'denied');
const isAbandoned = computed(() => props.toolCall.status === 'abandoned');

const statusIcon = computed(() => {
  if (isPending.value || isRunning.value || isAwaitingApproval.value) return null;
  if (isCompleted.value) return IconCheckCircle;
  if (isFailed.value || isDenied.value) return IconXCircle;
  if (isAbandoned.value) return IconBan;
  return IconGear;
});

const statusClass = computed(() => {
  if (isRunning.value || isAwaitingApproval.value) return 'text-primary';
  if (isCompleted.value) return 'text-success';
  if (isFailed.value || isDenied.value) return 'text-error';
  if (isAbandoned.value) return 'text-muted-foreground';
  return 'text-muted-foreground';
});

const cardClass = computed(() => {
  if (isAwaitingApproval.value) return 'border-primary/50 bg-primary/5';
  if (isFailed.value || isDenied.value) return 'border-error/50';
  if (isAbandoned.value) return 'border-muted/50 opacity-60';
  if (isCompleted.value) return 'border-success/30';
  return 'border-border';
});

const headerText = computed(() => {
  const title = schema.value.title;
  if (title) return title;
  const n = totalCount.value;
  return n === 1 ? t('formTool.headerOne') : t('formTool.headerOther', { n });
});
</script>

<template>
  <Card class="text-sm overflow-hidden" :class="cardClass">
    <CardHeader class="flex flex-row items-center gap-2 px-3 py-2 bg-primary/10 border-b border-border/50 space-y-0">
      <IconPencilSquare :size="18" class="text-primary shrink-0" />
      <span class="text-foreground font-medium flex-1">{{ headerText }}</span>

      <LoadingSpinner v-if="isPending || isRunning || isAwaitingApproval" :size="16" :class="statusClass" class="shrink-0" />
      <component v-else-if="statusIcon" :is="statusIcon" :size="16" :class="statusClass" class="shrink-0" />
    </CardHeader>

    <CardContent class="p-0">
      <!-- Per-field list -->
      <div class="divide-y divide-border/30">
        <div
          v-for="(field, idx) in fieldRows"
          :key="idx"
          class="px-3 py-2 flex items-center gap-2"
        >
          <!-- Field state icon -->
          <span class="shrink-0 w-4 flex items-center justify-center">
            <span v-if="field.skipped" class="w-1.5 h-1.5 rounded-full bg-muted-foreground/40" />
            <IconCheckCircle v-else-if="field.ok === true" :size="12" class="text-success" />
            <IconXCircle v-else-if="field.ok === false" :size="12" class="text-error" />
            <span v-else class="w-1.5 h-1.5 rounded-full bg-muted-foreground/50" />
          </span>

          <!-- Label + type -->
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-1.5">
              <IconLock v-if="field.masked" :size="11" class="text-muted-foreground shrink-0" />
              <span class="text-xs text-foreground/90 truncate">{{ field.label }}</span>
              <span class="inline-flex items-center px-1 py-0.5 rounded text-[10px] bg-muted text-muted-foreground shrink-0">
                {{ field.type }}
              </span>
            </div>
            <!-- Value slot: masked fields render dots; there are never raw values to show. -->
            <div v-if="field.masked && !field.skipped" class="text-xs text-muted-foreground tracking-widest mt-0.5">••••</div>
            <!-- Optional field the user intentionally left blank. -->
            <div v-if="field.skipped" class="text-xs text-muted-foreground/70 mt-0.5">{{ t('formTool.skipped') }}</div>
            <!-- Value-free failure reason (safe by contract). -->
            <div v-if="field.ok === false && field.reason" class="text-xs text-error/80 mt-0.5">
              {{ field.reason }}
            </div>
          </div>
        </div>
      </div>

      <!-- Result footer -->
      <div v-if="result" class="px-3 py-2 border-t border-border/30 flex items-center gap-3 text-xs text-muted-foreground">
        <span>{{ t('formTool.filled', { filled: filledCount, total: totalCount }) }}</span>
        <span v-if="hasSubmitSelector" class="flex items-center gap-1">
          <IconCheckCircle v-if="submitted" :size="12" class="text-success" />
          <IconBan v-else :size="12" class="text-muted-foreground" />
          {{ submitted ? t('formTool.submitted') : t('formTool.notSubmitted') }}
        </span>
      </div>

      <!-- Status messages -->
      <div v-if="isAwaitingApproval" class="px-3 py-2 bg-primary/10 border-t border-primary/20">
        <div class="flex items-center gap-2 text-xs text-primary">
          <span class="inline-block w-2 h-2 rounded-full bg-primary animate-pulse" />
          <span>{{ t('formTool.waiting') }}</span>
        </div>
      </div>

      <div v-else-if="isDenied" class="px-3 py-2 bg-error/10 border-t border-error/20">
        <div class="flex items-center gap-2 text-xs text-error/80">
          <IconXCircle :size="12" />
          <span>{{ t('formTool.cancelled') }}</span>
        </div>
      </div>

      <div v-else-if="isFailed" class="px-3 py-2 bg-error/10 border-t border-error/20">
        <div class="flex items-center gap-2 text-xs text-error/80">
          <IconXCircle :size="12" />
          <span>{{ t('formTool.failed') }}</span>
        </div>
      </div>

      <div v-else-if="isAbandoned" class="px-3 py-2 bg-muted/30 border-t border-border/30">
        <div class="flex items-center gap-2 text-xs text-muted-foreground">
          <IconBan :size="12" />
          <span>{{ t('formTool.movedOn') }}</span>
        </div>
      </div>
    </CardContent>
  </Card>
</template>
