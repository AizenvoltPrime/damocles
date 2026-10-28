<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { NameCheck } from '../../../preload/overlay-channels';

// A host name typed in place (the new-host form, Rename on the host card and the Projects group header): checked through
// main's one validator, the refusal shown inline, and a refused submit shakes the field.
const props = defineProps<{
  label: string;
  // main's validator for the typed text, asked as the user types and on submit; undefined when the dialog is closing. Without
  // it the field submits the text as typed and its parent refuses through refuse() with main's answer.
  check?: (name: string) => Promise<NameCheck | undefined>;
  class?: string;
}>();
const emit = defineEmits<{ submit: [name: string]; cancel: [] }>();
const model = defineModel<string>({ required: true });
const { t } = useI18n();

const errorId = useId();
const input = ref<InstanceType<typeof Input> | null>(null);
const refusal = ref<Extract<NameCheck, { ok: false }> | undefined>();
// check: main could not check the name, so the field says so rather than accepting it; save: the parent's save failed
const failed = ref<'check' | 'save' | undefined>();
// Answers arrive out of order while the user types; only the newest counts.
let asked = 0;

// text: what the field holds now; the model round-trips through the parent after the input event. Returns main's answer
// for that text, which the field shows only while no newer text was asked about.
async function validate(text: string): Promise<NameCheck | undefined> {
  const ticket = ++asked;
  if (!props.check) {
    // the refusal and a failed save named the text before this edit
    refusal.value = undefined;
    failed.value = undefined;
    return undefined;
  }
  let result: NameCheck | undefined;
  try {
    result = await props.check(text);
  } catch {
    if (ticket === asked) failed.value = 'check';
    return undefined;
  }
  if (ticket === asked && result) {
    failed.value = undefined;
    refusal.value = result.ok ? undefined : result;
  }
  return result;
}

const message = computed(() => {
  if (failed.value) return t(failed.value === 'check' ? 'remote.name.checkFailed' : 'remote.name.saveFailed');
  const current = refusal.value;
  if (!current) return undefined;
  return current.reason === 'taken' ? t('remote.name.taken', { name: current.clashWith ?? model.value.trim() }) : t(`remote.name.${current.reason}`);
});

function element(): HTMLInputElement | undefined {
  return (input.value?.$el as HTMLInputElement | undefined) ?? undefined;
}

// The class comes off and goes back on, so a second refusal plays the shake again.
function shake(): void {
  const field = element();
  if (!field) return;
  field.classList.remove('d-shake');
  void field.offsetWidth;
  field.classList.add('d-shake');
}

// After the render the refusal causes, which rewrites the field's class list.
async function refuse(check: Extract<NameCheck, { ok: false }>): Promise<void> {
  refusal.value = check;
  await nextTick();
  shake();
}

async function submit(): Promise<void> {
  const text = element()?.value ?? model.value;
  if (!props.check) {
    emit('submit', text);
    return;
  }
  const result = await validate(text);
  if (!result) return;
  if (result.ok) emit('submit', result.name);
  else await refuse(result);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    void submit();
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    emit('cancel');
  }
}

// The field stays open with what the user typed, so Enter tries again.
function saveFailed(): void {
  refusal.value = undefined;
  failed.value = 'save';
}

defineExpose({ submit, refuse, saveFailed, focus: () => element()?.focus(), select: () => element()?.select() });
</script>

<template>
  <span class="flex min-w-0 flex-col gap-1.5">
    <Input
      ref="input"
      v-model="model"
      data-testid="host-name-input"
      autocomplete="off"
      spellcheck="false"
      :aria-label="label"
      :aria-invalid="refusal ? 'true' : undefined"
      :aria-describedby="message ? errorId : undefined"
      :class="cn(
        'h-8 rounded-lg border-(--d-border2) bg-(--d-input) px-2.5 text-13 font-semibold text-(--d-text) transition-[border-color,box-shadow] focus-visible:border-(--d-accent) focus-visible:ring-3 focus-visible:ring-(--d-accent-soft) focus-visible:ring-offset-0',
        refusal && 'border-(--d-danger) ring-3 ring-(--d-danger)/22 focus-visible:border-(--d-danger) focus-visible:ring-(--d-danger)/22',
        props.class,
      )"
      @input="validate(($event.target as HTMLInputElement).value)"
      @keydown="onKeydown"
      @animationend="element()?.classList.remove('d-shake')"
    />
    <Transition name="t-tuck">
      <span
        v-if="message"
        :id="errorId"
        role="alert"
        data-testid="host-name-error"
        class="self-start rounded-6 bg-(--d-danger) px-2 py-1 text-11 font-semibold text-(--d-on-danger)"
      >{{ message }}</span>
    </Transition>
  </span>
</template>
