<script setup lang="ts">
import { ref, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { IconLock } from '@/components/icons';
import { useI18n } from 'vue-i18n';
import { Bot, FormInput, SendHorizontal } from 'lucide-vue-next';
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
    payload[field.id] = values[field.id] ?? defaultValueFor(field);
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
  'flex h-8.5 w-full rounded-[0.625rem] border border-(--d-border2) bg-(--d-input) px-2.75 text-12.5 text-(--d-text) placeholder:text-(--d-faint) focus-visible:border-(--d-accent) focus-visible:outline-none disabled:cursor-default disabled:opacity-50';
</script>

<template>
  <div
    v-if="visible && form"
    ref="rootRef"
    class="overflow-hidden rounded-[0.875rem] border border-[color-mix(in_srgb,var(--d-accent)_45%,var(--d-border))] bg-(--d-card) text-(--d-text) shadow-(--d-shadow)"
    role="region"
    :aria-label="t('form.ariaLabel')"
    data-dock-prompt
    data-testid="form-card"
    @keydown="onRootKeydown"
  >
    <header class="flex items-center gap-2.5 border-b border-(--d-border) bg-linear-to-b from-[color-mix(in_srgb,var(--d-accent)_10%,transparent)] to-transparent px-3 py-2">
      <span
        class="d-ring flex size-6.5 flex-none items-center justify-center rounded-lg bg-(--d-accent-soft) text-(--d-accent)"
        aria-hidden="true"
      >
        <FormInput class="size-3.5" />
      </span>
      <div class="min-w-0 flex-1">
        <div class="truncate font-semibold">
          {{ form.title || t('form.ariaLabel') }}
        </div>
        <div
          v-if="form.description"
          class="text-xs text-pretty text-(--d-muted)"
        >
          {{ form.description }}
        </div>
      </div>
      <span
        v-if="hasAgentDescription"
        class="flex min-w-0 items-center gap-1.5 truncate rounded-full bg-(--d-accent-soft) px-2 py-0.5 text-11 font-medium text-(--d-accent-text)"
      >
        <Bot
          class="size-3 flex-none"
          aria-hidden="true"
        />
        <span class="truncate">{{ agentDescription }}</span>
      </span>
    </header>

    <div class="max-h-[60vh] space-y-3 overflow-y-auto px-3.5 py-3">
      <div v-for="field in fields" :key="field.id" class="flex flex-col gap-1">
        <label
          :for="field.type === 'radio' ? undefined : `form-field-${field.id}`"
          class="flex items-center gap-1.5 text-xs font-medium text-(--d-muted)"
        >
          <IconLock v-if="field.sensitive || field.type === 'password'" class="size-3 shrink-0 text-(--d-faint)" />
          <span>{{ field.label }}</span>
          <span v-if="field.required" class="text-(--d-danger)" aria-hidden="true">*</span>
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
          :class="showErrors && isMissing(field) ? 'border-(--d-danger) focus-visible:ring-(--d-danger)' : ''"
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
          :class="showErrors && isMissing(field) ? 'border-(--d-danger) focus-visible:ring-(--d-danger)' : ''"
          @update:model-value="(v) => (values[field.id] = String(v))"
        />

        <!-- select -->
        <select
          v-else-if="field.type === 'select'"
          :id="`form-field-${field.id}`"
          :value="stringModel(field)"
          :aria-invalid="showErrors && isMissing(field)"
          :class="[nativeControlClass, showErrors && isMissing(field) ? 'border-(--d-danger) focus-visible:ring-(--d-danger)' : '']"
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
          <label :for="`form-field-${field.id}`" class="text-xs text-(--d-text) cursor-pointer">
            {{ field.placeholder ?? field.label }}
          </label>
        </div>

        <!-- radio group -->
        <div v-else-if="field.type === 'radio'" class="flex flex-col gap-1.5" role="radiogroup" :aria-label="field.label">
          <label
            v-for="opt in field.options ?? []"
            :key="opt.value"
            class="flex items-center gap-2 text-xs text-(--d-text) cursor-pointer"
          >
            <input
              type="radio"
              :name="`form-field-${field.id}`"
              :value="opt.value"
              :checked="values[field.id] === opt.value"
              class="cursor-pointer accent-(--d-accent)"
              @change="() => (values[field.id] = opt.value)"
            />
            <span>{{ opt.label }}</span>
          </label>
        </div>

        <!-- required hint -->
        <span
          v-if="showErrors && isMissing(field)"
          class="text-xs text-(--d-danger)"
        >
          {{ t('form.requiredField') }}
        </span>
      </div>
    </div>

    <div class="flex justify-end gap-2 border-t border-(--d-border) bg-(--d-panel) px-3.5 py-2.5">
      <button
        type="button"
        class="d-press flex h-7.5 items-center rounded-9 border border-(--d-border2) px-3 text-12.5 transition-colors hover:bg-(--d-hover)"
        @click="handleCancel"
      >
        {{ t('form.cancel') }}
      </button>
      <button
        type="button"
        class="d-press flex h-7.5 items-center gap-1.5 rounded-9 bg-(--d-accent) px-3.5 text-12.5 font-semibold text-(--d-on-accent) transition-[filter] hover:brightness-110"
        @click="handleSubmit"
      >
        <SendHorizontal
          class="size-3.25"
          aria-hidden="true"
        />
        {{ submitLabel }}
      </button>
    </div>
  </div>
</template>
