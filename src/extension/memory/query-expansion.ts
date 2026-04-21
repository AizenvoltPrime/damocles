import { log } from '../logger';
import { loadSdkQuery } from '../shared/sdk-loader';
import { buildSdkEnv } from '../auth/sdk-env';

const EXPANSION_MODEL = 'claude-haiku-4-5-20251001';
const MAX_CACHE_SIZE = 50;
const INDEX_EXPANSION_SCHEMA = {
  type: 'object',
  properties: {
    terms: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 10,
    },
  },
  required: ['terms'],
  additionalProperties: false,
};

const EXPANSION_SCHEMA = {
  type: 'object',
  properties: {
    terms: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 8,
    },
  },
  required: ['terms'],
  additionalProperties: false,
};

const cache = new Map<string, string[]>();

function extractTermsFromResult(event: {
  structured_output?: { terms: string[] };
  result?: string;
}): { terms: string[] } | null {
  if (event.structured_output?.terms) return event.structured_output;

  if (event.result) {
    try {
      const parsed = JSON.parse(event.result);
      if (Array.isArray(parsed?.terms)) return { terms: parsed.terms };
    } catch { /* not valid JSON */ }
  }

  return null;
}

export function clearExpansionCache(): void {
  cache.clear();
}

export async function expandQuery(userPrompt: string): Promise<string[]> {
  const cacheKey = userPrompt.trim().toLowerCase().slice(0, 200);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const sdkQuery = loadSdkQuery();
  if (!sdkQuery) return [];

  try {
    const options = {
      model: EXPANSION_MODEL,
      systemPrompt: 'Generate 3-8 keyword phrases that are synonyms, related concepts, or alternative technical terms for the user\'s query. Focus on terms that would appear in technical documentation or code comments.',
      tools: [] as string[],
      persistSession: false,
      outputFormat: { type: 'json_schema' as const, schema: EXPANSION_SCHEMA },
      env: buildSdkEnv(),
    };

    const generator = sdkQuery({ prompt: userPrompt, options } as Parameters<typeof sdkQuery>[0]);
    let structuredOutput: { terms: string[] } | null = null;

    for await (const event of generator) {
      const msg = event as {
        type: string;
        subtype?: string;
        structured_output?: { terms: string[] };
        result?: string;
      };

      if (msg.type === 'result') {
        if (msg.subtype === 'error_max_structured_output_retries') {
          log('[QueryExpansion] Structured output retries exhausted');
          return [];
        }
        structuredOutput = extractTermsFromResult(msg);
      }
    }

    if (!structuredOutput?.terms || structuredOutput.terms.length === 0) return [];

    const terms = structuredOutput.terms
      .map(t => t.trim().toLowerCase())
      .filter(t => t.length > 1);

    log('[QueryExpansion] Expanded "%s" → %O', userPrompt.slice(0, 50), terms);

    if (cache.size >= MAX_CACHE_SIZE) {
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    cache.set(cacheKey, terms);

    return terms;
  } catch (err) {
    log('[QueryExpansion] Failed: %O', err);
    return [];
  }
}

export async function expandMemoryTerms(entry: {
  content: string;
  title?: string;
  tags?: string[];
  facts?: string[];
}): Promise<string[]> {
  const sdkQuery = loadSdkQuery();
  if (!sdkQuery) return [];

  const inputParts = [
    entry.title ? `Title: ${entry.title}` : '',
    `Content: ${entry.content.slice(0, 500)}`,
    entry.tags?.length ? `Tags: ${entry.tags.join(', ')}` : '',
    entry.facts?.length ? `Facts: ${entry.facts.join('; ')}` : '',
  ].filter(Boolean);

  try {
    const options = {
      model: EXPANSION_MODEL,
      systemPrompt: 'Generate 5-10 search keywords that someone would use to find this memory. Include synonyms, related concepts, alternative technical terms, and commonly associated phrases. Focus on terms NOT already present in the content.',
      tools: [] as string[],
      persistSession: false,
      outputFormat: { type: 'json_schema' as const, schema: INDEX_EXPANSION_SCHEMA },
      env: buildSdkEnv(),
    };

    const generator = sdkQuery({ prompt: inputParts.join('\n'), options } as Parameters<typeof sdkQuery>[0]);
    let structuredOutput: { terms: string[] } | null = null;

    for await (const event of generator) {
      const msg = event as {
        type: string;
        subtype?: string;
        structured_output?: { terms: string[] };
        result?: string;
      };

      if (msg.type === 'result') {
        if (msg.subtype === 'error_max_structured_output_retries') {
          log('[IndexExpansion] Structured output retries exhausted');
          return [];
        }
        structuredOutput = extractTermsFromResult(msg);
      }
    }

    if (!structuredOutput?.terms || structuredOutput.terms.length === 0) return [];

    const terms = structuredOutput.terms
      .map(t => t.trim().toLowerCase())
      .filter(t => t.length > 1);

    log('[IndexExpansion] Generated %d terms for "%s"', terms.length, (entry.title ?? entry.content).slice(0, 40));
    return terms;
  } catch (err) {
    log('[IndexExpansion] Failed: %O', err);
    return [];
  }
}
