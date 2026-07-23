<script setup lang="ts">
import { ref, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { IconLock } from '@/components/icons';
import { useI18n } from 'vue-i18n';
import { useFormStore } from '@/stores/useFormStore';
import { usePermissionStore } from '@/stores/usePermissionStore';
import { useQuestionStore } from '@/stores/useQuestionStore';
import type { FormFieldSchema, FormValues } from '@shared/types/forms';

defineProps<{
  visible: boolean;
}>();

const emit = defineEmits<{
  (e: 'submit', values: FormValues): void;
  (e: 'cancel'): void;
}>();

const { t } = useI18n();
const store = useFormStore();
const permissionStore = usePermissionStore();
const questionStore = useQuestionStore();

const form = computed(() => store.pendingForm?.form ?? null);
const fields = computed<FormFieldSchema[]>(() => form.value?.fields ?? []);
const submitLabel = computed(() => form.value?.submitLabel ?? t('form.submit'));

const hasAgentDescription = computed(() => !!store.pendingForm?.agentDescription);
const agentDescription = computed(() => store.pendingForm?.agentDescription ?? '');

// SECURITY: entered values live ONLY here, in component-local reactive state. They are never
// written to a store, logged, or rendered as raw text. They are emitted once via `submit` and
// cleared on submit/cancel/unmount.
const values = reactive<Record<string, string | boolean | string[]>>({});
// Tracks which required fields the user attempted to submit while empty (drives inline hints).
const showErrors = ref(false);

function defaultValueFor(field: FormFieldSchema): string | boolean {
  return field.type === 'checkbox' ? false : '';
}

function initValues() {
  clearValues();
  for (const field of fields.value) {
    values[field.id] = defaultValueFor(field);
  }
  showErrors.value = false;
}

function clearValues() {
  for (const key of Object.keys(values)) {
    delete values[key];
  }
}

function isFilled(field: FormFieldSchema): boolean {
  const v = values[field.id];
  if (field.type === 'checkbox') return v === true;
  if (Array.isArray(v)) return v.length > 0;
  return typeof v === 'string' && v.trim().length > 0;
}

function isMissing(field: FormFieldSchema): boolean {
  return !!field.required && !isFilled(field);
}

const canSubmit = computed(() => fields.value.every((f) => !isMissing(f)));

// Map the schema field type onto the native <input type> attribute.
function inputType(field: FormFieldSchema): string {
  switch (field.type) {
    case 'password':
      return 'password';
    case 'number':
      return 'number';
    case 'date':
      return 'date';
    case 'email':
      return 'email';
    case 'url':
      return 'url';
    case 'tel':
      return 'tel';
    default:
      return 'text';
  }
}

const inputFieldTypes = new Set([
  'text',
  'password',
  'number',
  'date',
  'email',
  'url',
  'tel',
]);

function stringModel(field: FormFieldSchema): string {
  const v = values[field.id];
  return typeof v === 'string' ? v : '';
}

const rootRef = ref<HTMLElement | null>(null);

function focusFirstField() {
  nextTick(() => {
    // Include [role=checkbox]: a shadcn Checkbox renders a <button role="checkbox">, not an <input>,
    // so a leading checkbox field would otherwise be skipped by the initial focus.
    rootRef.value?.querySelector<HTMLElement>('input, textarea, select, [role="checkbox"]')?.focus();
  });
}

function focusField(id: string) {
  nextTick(() => {
    const esc = CSS.escape(id);
    rootRef.value?.querySelector<HTMLElement>(`#form-field-${esc}, [name="form-field-${esc}"]`)?.focus();
  });
}

function handleSubmit() {
  showErrors.value = true;
  if (!canSubmit.value) {
    // Click-surfaces-errors model: reveal the inline errors and move focus to the first invalid field
    // so the user (and a screen reader) is told exactly what is missing.
    const firstMissing = fields.value.find((f) => isMissing(f));
    if (firstMissing) focusField(firstMissing.id);
    return;
  }
  // Build the FormValues payload keyed by field.id (contract: string for text-like/select/radio,
  // boolean for checkbox).
  const payload: FormValues = {};
  for (const field of fields.value) {
    payload[field.id] = values[field.id];
  }
  emit('submit', payload);
  clearValues();
  showErrors.value = false;
}

function handleCancel() {
  clearValues();
  showErrors.value = false;
  emit('cancel');
}

function isOverlaidByHigherPriority(): boolean {
  // A higher-priority approval overlay (permission/plan/skill) or a peer question prompt is stacked on
  // top of the form, so this form must not consume window-level keys.
  return !!(
    permissionStore.currentPermission ||
    (permissionStore.pendingPlanApproval && permissionStore.isPlanOverlayVisible) ||
    permissionStore.pendingSkillApproval ||
    questionStore.pendingQuestion
  );
}

// Keyboard is handled by a @keydown bound on the form ROOT (not window): the event bubbles from the
// focused field to the root and is handled there, before it can reach window — VS Code webviews sandbox
// native <form> submission and a window listener is beaten by any ancestor that stops propagation, so
// element-scoped handling is the reliable pattern (matches ChatInput). Enter submits (identical to
// clicking Submit); Escape cancels. A <textarea> keeps Enter for newlines; a focused <button> keeps its
// native activation; an in-progress IME composition is left alone.
function onRootKeydown(event: KeyboardEvent) {
  if (event.isComposing) return;
  if (event.key === 'Enter') {
    const tag = (event.target as HTMLElement | null)?.tagName;
    if (tag === 'TEXTAREA' || tag === 'BUTTON') return;
    event.preventDefault();
    handleSubmit();
    return;
  }
  if (event.key === 'Escape') {
    // Defer only when a higher-priority overlay is stacked on top so Escape never cancels a form hidden
    // beneath another panel.
    if (isOverlaidByHigherPriority()) return;
    event.preventDefault();
    handleCancel();
  }
}

// mounted-gated so the FIRST form's focus runs from onMounted (rootRef ready), while a queued form
// advancing (pendingForm changes on an already-mounted component) focuses via this watcher.
let mounted = false;
watch(
  () => store.pendingForm,
  () => {
    initValues();
    if (mounted) focusFirstField();
  },
  { immediate: true }
);

onMounted(() => {
  mounted = true;
  focusFirstField();
});

onBeforeUnmount(() => {
  // Defense in depth: never leave entered values in memory after the prompt is torn down.
  clearValues();
});

const nativeControlClass =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
</script>

<template>
  <div
    v-if="visible && form"
    ref="rootRef"
    class="border-t border-border bg-background"
    role="region"
    :aria-label="t('form.ariaLabel')"
    @keydown="onRootKeydown"
  >
    <!-- Header with agent badge -->
    <div v-if="hasAgentDescription" class="px-4 pt-2 flex items-center gap-2">
      <span class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs bg-primary/20 text-primary border border-border">
        <span class="text-primary">🤖</span>
        {{ agentDescription }}
      </span>
    </div>

    <!-- Title / description -->
    <div v-if="form.title || form.description" class="px-4 pt-3 pb-1">
      <div v-if="form.title" class="text-sm font-medium text-foreground">{{ form.title }}</div>
      <div v-if="form.description" class="text-xs text-muted-foreground mt-0.5">{{ form.description }}</div>
    </div>

    <!-- Fields -->
    <div class="px-4 py-3 space-y-3 max-h-[60vh] overflow-y-auto">
      <div v-for="field in fields" :key="field.id" class="flex flex-col gap-1">
        <label
          :for="field.type === 'radio' ? undefined : `form-field-${field.id}`"
          class="text-xs font-medium text-foreground/90 flex items-center gap-1.5"
        >
          <IconLock v-if="field.sensitive || field.type === 'password'" :size="12" class="text-muted-foreground shrink-0" />
          <span>{{ field.label }}</span>
          <span v-if="field.required" class="text-error" aria-hidden="true">*</span>
        </label>

        <!-- text / password / number / date / email / url / tel -->
        <Input
          v-if="inputFieldTypes.has(field.type)"
          :id="`form-field-${field.id}`"
          :type="inputType(field)"
          :model-value="stringModel(field)"
          :placeholder="field.placeholder"
          :aria-invalid="showErrors && isMissing(field)"
          autocomplete="off"
          :class="showErrors && isMissing(field) ? 'border-error focus-visible:ring-error' : ''"
          @update:model-value="(v: string | number) => (values[field.id] = String(v))"
        />

        <!-- textarea -->
        <Textarea
          v-else-if="field.type === 'textarea'"
          :id="`form-field-${field.id}`"
          :model-value="stringModel(field)"
          :placeholder="field.placeholder"
          :aria-invalid="showErrors && isMissing(field)"
          class="min-h-20 max-h-40 resize-none"
          :class="showErrors && isMissing(field) ? 'border-error focus-visible:ring-error' : ''"
          @update:model-value="(v: string) => (values[field.id] = v)"
        />

        <!-- select -->
        <select
          v-else-if="field.type === 'select'"
          :id="`form-field-${field.id}`"
          :value="stringModel(field)"
          :aria-invalid="showErrors && isMissing(field)"
          :class="[nativeControlClass, showErrors && isMissing(field) ? 'border-error focus-visible:ring-error' : '']"
          @change="(e) => (values[field.id] = (e.target as HTMLSelectElement).value)"
        >
          <option value="" disabled>{{ field.placeholder ?? t('form.selectPlaceholder') }}</option>
          <option v-for="opt in field.options ?? []" :key="opt.value" :value="opt.value">
            {{ opt.label }}
          </option>
        </select>

        <!-- checkbox -->
        <div v-else-if="field.type === 'checkbox'" class="flex items-center gap-2">
          <Checkbox
            :id="`form-field-${field.id}`"
            :checked="values[field.id] === true"
            @update:checked="(v: boolean) => (values[field.id] = v)"
          />
          <label :for="`form-field-${field.id}`" class="text-xs text-foreground/80 cursor-pointer">
            {{ field.placeholder ?? field.label }}
          </label>
        </div>

        <!-- radio group -->
        <div v-else-if="field.type === 'radio'" class="flex flex-col gap-1.5" role="radiogroup" :aria-label="field.label">
          <label
            v-for="opt in field.options ?? []"
            :key="opt.value"
            class="flex items-center gap-2 text-xs text-foreground/90 cursor-pointer"
          >
            <input
              type="radio"
              :name="`form-field-${field.id}`"
              :value="opt.value"
              :checked="values[field.id] === opt.value"
              class="accent-primary cursor-pointer"
              @change="() => (values[field.id] = opt.value)"
            />
            <span>{{ opt.label }}</span>
          </label>
        </div>

        <!-- required hint -->
        <span
          v-if="showErrors && isMissing(field)"
          class="text-xs text-error/80"
        >
          {{ t('form.requiredField') }}
        </span>
      </div>
    </div>

    <!-- Actions -->
    <div class="px-4 pb-4 flex justify-end gap-2 border-t border-border/30 pt-3">
      <Button type="button" variant="ghost" size="sm" @click="handleCancel">{{ t('form.cancel') }}</Button>
      <Button type="button" size="sm" @click="handleSubmit">{{ submitLabel }}</Button>
    </div>
  </div>
</template>
