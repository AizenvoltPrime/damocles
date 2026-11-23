<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { RotateCcw } from 'lucide-vue-next';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { ContrastIssue } from '@shared/themes/contrast';
import { isValidTokenValue, SHADOW_TOKEN, type LookKind, type ThemePalette, type TokenName } from '@shared/themes/tokens';
import { issueBackdrop, TOKEN_GROUPS } from './colors';
import { useEditorFormat } from './format';

// Every overridable token of the look: its derived value, its override and what an override breaks, which is listed, never
// blocked: a pair that fails contrast, under its text and under each surface behind it, and a color that must be opaque.
const props = defineProps<{
  derived: ThemePalette;
  shown: ThemePalette;
  overrides: Readonly<Partial<Record<TokenName, string>>>;
  issues: readonly ContrastIssue[];
  kind: LookKind;
  readOnly: boolean;
}>();

const emit = defineEmits<{
  (e: 'set', token: TokenName, value: string | undefined): void;
}>();

const { t } = useI18n();
const format = useEditorFormat();

const inputId = (token: TokenName): string => `theme-token-${token.slice(2)}`;
// The first failure each overridden token takes part in: as the text, or as a surface behind it.
const warningOf = computed(() => {
  const out = new Map<TokenName, string>();
  const note = (token: TokenName, text: string): void => {
    if (props.overrides[token] !== undefined && !out.has(token)) out.set(token, text);
  };
  for (const issue of props.issues) {
    if (issue.rule === 'format') {
      note(issue.fg, t('themeEditor.tokens.format', { token: issue.fg }));
      continue;
    }
    const text = t('themeEditor.tokens.warning', { token: issue.fg, surface: issue.bg, ratio: format.ratio(issue.ratio), need: format.need(issue.min) });
    for (const token of [issue.fg, ...issueBackdrop(issue, props.kind)]) note(token, text);
  }
  return out;
});

// A value typed that is no value of its token: said under the field, which takes its stored value back when it is left.
const invalid = ref<Partial<Record<TokenName, boolean>>>({});
watch([() => props.overrides, () => props.kind], () => {
  invalid.value = {};
});
const describedBy = (token: TokenName): string | undefined => (invalid.value[token] ? `${inputId(token)}-invalid` : warningOf.value.has(token) ? `${inputId(token)}-warning` : undefined);

function change(token: TokenName, raw: string): void {
  const value = raw.trim().toLowerCase();
  if (value === '') {
    invalid.value = { ...invalid.value, [token]: false };
    emit('set', token, undefined);
    return;
  }
  const hex = token === SHADOW_TOKEN || value.startsWith('#') ? value : `#${value}`;
  const valid = isValidTokenValue(token, hex);
  invalid.value = { ...invalid.value, [token]: !valid };
  if (valid) emit('set', token, hex);
}
function typing(token: TokenName): void {
  if (invalid.value[token]) invalid.value = { ...invalid.value, [token]: false };
}
function leave(token: TokenName, field: HTMLInputElement): void {
  if (invalid.value[token]) field.value = props.overrides[token] ?? '';
}
</script>

<template>
  <Table
    class="text-11.5"
    data-testid="theme-token-table"
  >
    <TableCaption class="sr-only">
      {{ t('themeEditor.tokens.caption') }}
    </TableCaption>
    <TableHeader>
      <TableRow class="border-(--d-border)">
        <TableHead class="h-7 px-1.5 text-(--d-muted)">
          {{ t('themeEditor.tokens.token') }}
        </TableHead>
        <TableHead class="h-7 w-6 px-0">
          <span class="sr-only">{{ t('themeEditor.tokens.value') }}</span>
        </TableHead>
        <TableHead class="h-7 px-1.5 text-(--d-muted)">
          {{ t('themeEditor.tokens.override') }}
        </TableHead>
        <TableHead class="size-7 px-0">
          <span class="sr-only">{{ t('themeEditor.tokens.reset') }}</span>
        </TableHead>
      </TableRow>
    </TableHeader>
    <TableBody
      v-for="[group, tokens] in TOKEN_GROUPS"
      :key="group"
    >
      <TableRow class="border-(--d-border) hover:bg-transparent">
        <TableHead
          scope="colgroup"
          colspan="4"
          class="h-7 px-1.5 text-10.5 font-semibold tracking-wide text-(--d-faint-text) uppercase"
        >
          {{ t(`themeEditor.tokens.groups.${group}`) }}
        </TableHead>
      </TableRow>
      <template
        v-for="token in tokens"
        :key="token"
      >
        <TableRow class="border-(--d-border)">
          <TableHead
            scope="row"
            class="h-auto px-1.5 py-1 font-mono text-11 font-normal text-(--d-text)"
          >
            {{ token }}
            <span
              v-if="overrides[token] !== undefined"
              class="block text-10.5 text-(--d-faint-text)"
            >{{ t('themeEditor.tokens.derived', { value: derived[token] ?? '' }) }}</span>
          </TableHead>
          <TableCell class="px-0 py-1">
            <span
              v-if="token !== SHADOW_TOKEN"
              class="block size-4 rounded-5 border border-(--d-border2)"
              :style="{ backgroundColor: shown[token] }"
              :title="shown[token]"
            />
          </TableCell>
          <TableCell class="px-1.5 py-1">
            <label
              class="sr-only"
              :for="inputId(token)"
            >{{ t('themeEditor.tokens.overrideLabel', { token }) }}</label>
            <Input
              :id="inputId(token)"
              :model-value="overrides[token] ?? ''"
              class="h-6.5 px-1.5 font-mono text-11"
              spellcheck="false"
              autocomplete="off"
              :placeholder="(derived[token] ?? '').slice(0, token === SHADOW_TOKEN ? 40 : 7)"
              :readonly="readOnly"
              :aria-invalid="invalid[token] ? 'true' : undefined"
              :aria-describedby="describedBy(token)"
              @input="typing(token)"
              @change="(event: Event) => change(token, (event.target as HTMLInputElement).value)"
              @blur="(event: FocusEvent) => leave(token, event.target as HTMLInputElement)"
            />
          </TableCell>
          <TableCell class="px-0 py-1">
            <button
              type="button"
              class="inline-flex size-6 items-center justify-center rounded-6 text-(--d-muted) hover:bg-(--d-hover) disabled:opacity-(--d-opacity-disabled)"
              :aria-label="t('themeEditor.tokens.resetLabel', { token })"
              :disabled="readOnly || overrides[token] === undefined"
              @click="emit('set', token, undefined)"
            >
              <RotateCcw
                class="size-3"
                aria-hidden="true"
              />
            </button>
          </TableCell>
        </TableRow>
        <TableRow
          v-if="invalid[token]"
          class="border-(--d-border) hover:bg-transparent"
        >
          <TableCell
            :id="`${inputId(token)}-invalid`"
            colspan="4"
            class="px-1.5 py-1 text-11 text-(--d-danger-text)"
            role="alert"
          >
            {{ t(token === SHADOW_TOKEN ? 'themeEditor.tokens.invalidShadow' : 'themeEditor.tokens.invalidColor', { token }) }}
          </TableCell>
        </TableRow>
        <TableRow
          v-else-if="warningOf.has(token)"
          class="border-(--d-border) hover:bg-transparent"
        >
          <TableCell
            :id="`${inputId(token)}-warning`"
            colspan="4"
            class="px-1.5 py-1 text-11 text-(--d-warning-text)"
          >
            {{ warningOf.get(token) }}
          </TableCell>
        </TableRow>
      </template>
    </TableBody>
  </Table>
</template>
