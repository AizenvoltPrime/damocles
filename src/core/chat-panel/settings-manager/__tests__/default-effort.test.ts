import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { clampThinkingLevel, type Api, type Model } from '@earendil-works/pi-ai';
import { DEFAULT_MODELS } from '../../../../shared/types/constants';
import { effortToPiThinking } from '../../../pi-session/pi-models';
import { defaultEffortForModel } from '../utils';

/** A chat model from a catalog file pi-ai ships, keyed `<api>` then `chat:<id>`. */
function catalogModel(file: string, api: string, id: string): Model<Api> {
  const url = new URL(`../../../../../node_modules/@earendil-works/pi-ai/dist/providers/data/${file}`, import.meta.url);
  const catalog = JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as Record<string, Record<string, Model<Api>>>;
  const model = catalog[api]?.[`chat:${id}`];
  if (!model) throw new Error(`${id} is not in pi-ai's ${file}`);
  return model;
}

const PI_CATALOG: Record<string, [file: string, api: string]> = {
  'claude-fable-5-1': ['anthropic.json', 'anthropic-messages'],
  'claude-haiku-5-5': ['anthropic.json', 'anthropic-messages'],
  'gpt-6-astra': ['openai.json', 'openai-responses'],
  'gpt-6.1-sol': ['openai.json', 'openai-responses'],
  'gpt-6-luna': ['openai.json', 'openai-responses'],
  'deepseek-v4-pro': ['deepseek.json', 'openai-completions'],
  'deepseek-flash': ['deepseek.json', 'openai-completions'],
};

// The composer labels a chat with no stored effort by this value, so it must be the level pi runs: an unset effort is sent as medium.
describe('defaultEffortForModel', () => {
  // Damocles registers Step 5 Preview itself, so pi-ai ships no catalog entry for it.
  const SELF_REGISTERED = 'step-5-preview';
  const withoutCatalogDefault = DEFAULT_MODELS.filter((m) => (m.supportedEffortLevels?.length ?? 0) > 0 && !m.defaultEffort && m.value !== SELF_REGISTERED);

  it.each(withoutCatalogDefault.map((m) => m.value))('%s shows the level pi clamps medium to', (value) => {
    const [file, api] = PI_CATALOG[value]!;
    const effort = defaultEffortForModel(value);
    expect(effort && effortToPiThinking(effort)).toBe(clampThinkingLevel(catalogModel(file, api, value), 'medium'));
  });

  it('covers every catalog model without a default that pi ships, and Step 5 Preview runs medium', () => {
    expect(withoutCatalogDefault.map((m) => m.value).sort()).toEqual(Object.keys(PI_CATALOG).sort());
    expect(defaultEffortForModel(SELF_REGISTERED)).toBe('medium');
  });

  it('keeps the catalog default, and has none for a model without effort levels', () => {
    expect(defaultEffortForModel('claude-opus-5-5')).toBe('high');
    expect(defaultEffortForModel('unknown-model')).toBeNull();
  });
});
