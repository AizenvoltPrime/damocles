import { describe, it, expect, afterEach } from 'vitest';
import { effectScope } from 'vue';
import { usePhraseCycler } from '../usePhraseCycler';
import { WITTY_PHRASES, WITTY_PHRASES_EL } from '../../data/wittyPhrases';
import { i18n } from '@/i18n';

function phraseWhileActive(): string {
  const scope = effectScope();
  const phrase = scope.run(() => usePhraseCycler(() => true).currentPhrase.value)!;
  scope.stop();
  return phrase;
}

afterEach(() => { i18n.global.locale.value = 'en'; });

describe('usePhraseCycler', () => {
  it('draws the thinking phrase from the set of the current locale', () => {
    expect(WITTY_PHRASES).toContain(phraseWhileActive());
    i18n.global.locale.value = 'el';
    expect(WITTY_PHRASES_EL).toContain(phraseWhileActive());
  });

  it('writes the Greek set in Greek', () => {
    for (const phrase of WITTY_PHRASES_EL) expect(phrase).toMatch(/[\u0370-\u03ff\u1f00-\u1fff]/);
  });
});
