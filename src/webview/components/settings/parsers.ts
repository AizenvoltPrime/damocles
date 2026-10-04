import type { InputParse } from './controls/SettingInput.vue';

type Translate = (key: string, named?: Record<string, unknown>) => string;

const MIN_THINKING_TOKENS = 1000;
const MAX_THINKING_TOKENS = 63999;

function integerIn(raw: string, min: number, max: number): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return value >= min && value <= max ? value : null;
}

export function parseThinkingTokens(raw: string, t: Translate): ReturnType<InputParse<number>> {
  const value = integerIn(raw, MIN_THINKING_TOKENS, MAX_THINKING_TOKENS);
  return value === null
    ? { ok: false, error: t('settingsModal.invalid.integerRange', { min: MIN_THINKING_TOKENS, max: MAX_THINKING_TOKENS }) }
    : { ok: true, value };
}

/** Empty means no limit. */
export function parseBudgetUsd(raw: string, t: Translate): ReturnType<InputParse<number | null>> {
  const text = raw.trim();
  if (text === '') return { ok: true, value: null };
  if (!/^\d+(\.\d{1,2})?$/.test(text) || Number(text) <= 0) return { ok: false, error: t('settingsModal.invalid.amount') };
  return { ok: true, value: Number(text) };
}

/** Empty means no task budget. */
export function parseTaskBudget(raw: string, t: Translate): ReturnType<InputParse<number | null>> {
  const text = raw.trim();
  if (text === '') return { ok: true, value: null };
  const value = integerIn(text, 1, Number.MAX_SAFE_INTEGER);
  return value === null ? { ok: false, error: t('settingsModal.invalid.positiveInteger') } : { ok: true, value };
}

/** 0 keeps checkpoints forever. */
export function parseRetentionDays(raw: string, t: Translate): ReturnType<InputParse<number>> {
  const value = integerIn(raw, 0, 3650);
  return value === null ? { ok: false, error: t('settingsModal.invalid.integerRange', { min: 0, max: 3650 }) } : { ok: true, value };
}

export function parseNonEmpty(raw: string, t: Translate): ReturnType<InputParse<string>> {
  const text = raw.trim();
  return text === '' ? { ok: false, error: t('settingsModal.invalid.required') } : { ok: true, value: text };
}
