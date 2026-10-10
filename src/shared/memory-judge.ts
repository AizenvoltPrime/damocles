import type { ClassifierProvider } from './types/settings';
import { DEFAULT_MODELS } from './types/constants';

export const MEMORY_JUDGE_SETTING = 'damocles.memory.judge';
export const MEMORY_JUDGE_EFFORT_SETTING = 'damocles.memory.judgeEffort';

/**
 * The classifier choices of `damocles.memory.judge`, in Automatic's order. Each value must differ from every
 * `DEFAULT_MODELS` value, which shares the setting's enum (`gpt-6-luna` is the chat model).
 */
export const MEMORY_JUDGE_CLASSIFIERS: readonly { choice: string; provider: ClassifierProvider }[] = [
  { choice: 'jev-typesafe', provider: 'typesafe' },
  { choice: 'jev-openrouter', provider: 'openrouter' },
  { choice: 'gpt-6-luna-classifier', provider: 'openai' },
];

/** The classifier provider a `damocles.memory.judge` value forces, or undefined for Automatic or a model. */
export function forcedClassifierOf(choice: string): ClassifierProvider | undefined {
  return MEMORY_JUDGE_CLASSIFIERS.find((entry) => entry.choice === choice)?.provider;
}

/** Whether `choice` is a `damocles.memory.judge` value: Automatic (''), a classifier choice or a catalog model. */
export function isKnownMemoryJudgeChoice(choice: string): boolean {
  return choice === '' || forcedClassifierOf(choice) !== undefined || DEFAULT_MODELS.some((model) => model.value === choice);
}
