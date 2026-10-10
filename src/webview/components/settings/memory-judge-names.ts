import { useI18n } from 'vue-i18n';
import { forcedClassifierOf } from '@shared/memory-judge';
import { DEFAULT_MODELS } from '@shared/types/constants';
import type { ClassifierProvider, MemoryJudge } from '@shared/types/settings';

export interface MemoryJudgeNames {
  classifierName: (provider: ClassifierProvider) => string;
  /** A `damocles.memory.judge` value: a classifier's or catalog model's name, else the value as stored. */
  choiceName: (choice: string) => string;
  /** The judge in the words that follow "Memory judge:". */
  judgeText: (judge: MemoryJudge) => string;
}

/** One set of names for the Memory judge select and its status lines, so a choice reads the same in both. */
export function useMemoryJudgeNames(): MemoryJudgeNames {
  const { t } = useI18n();

  const classifierName = (provider: ClassifierProvider): string => t(`settings.memoryJudge.classifier.${provider}`);

  function choiceName(choice: string): string {
    const classifier = forcedClassifierOf(choice);
    if (classifier) return classifierName(classifier);
    return DEFAULT_MODELS.find((model) => model.value === choice)?.displayName ?? choice;
  }

  // `<provider>/<id>`; catalog ids are unique, so the id alone names the model whether OpenAI serves it by key or ChatGPT.
  function judgeModelName(model: string): string {
    const id = model.slice(model.indexOf('/') + 1);
    return DEFAULT_MODELS.find((candidate) => (candidate.openaiModelId ?? candidate.value) === id)?.displayName ?? model;
  }

  function judgeText(judge: MemoryJudge): string {
    if (judge.kind === 'classifier') return classifierName(judge.via);
    if (judge.kind === 'model') return judgeModelName(judge.model);
    if (judge.kind === 'unknown') return t('typesafe.memoryJudge.unknown');
    if (judge.forced) {
      return t('typesafe.memoryJudge.forcedNone', {
        choice: choiceName(judge.forced.choice),
        reason: t(`typesafe.memoryJudge.unavailable.${judge.forced.reason}`),
      });
    }
    return t('typesafe.memoryJudge.none');
  }

  return { classifierName, choiceName, judgeText };
}
