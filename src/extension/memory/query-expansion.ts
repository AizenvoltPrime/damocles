import { log } from '../logger';
import { PiRuntime } from '../pi-session/pi-runtime';

const MAX_CACHE_SIZE = 50;
const TERMS_TOOL = 'submit_terms';

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

const QUERY_EXPANSION_SYSTEM =
  "Generate 3-8 keyword phrases that are synonyms, related concepts, or alternative technical terms for the user's query. Focus on terms that would appear in technical documentation or code comments. Respond by calling the submit_terms tool.";

const MEMORY_EXPANSION_SYSTEM =
  'Generate 5-10 search keywords that someone would use to find this memory. Include synonyms, related concepts, alternative technical terms, and commonly associated phrases. Focus on terms NOT already present in the content. Respond by calling the submit_terms tool.';

const cache = new Map<string, string[]>();

/** Normalize raw expansion terms (trim, lowercase, drop single chars). */
function normalizeTerms(terms: string[] | undefined): string[] {
  if (!Array.isArray(terms)) return [];
  return terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 1);
}

export function clearExpansionCache(): void {
  cache.clear();
}

/** Run an expansion via the pi small/fast structured completion. Fails soft to `[]`. */
async function expandViaPi(systemPrompt: string, userMessage: string, schema: Record<string, unknown>): Promise<string[]> {
  const result = await PiRuntime.get().runStructuredCompletion<{ terms?: string[] }>({
    systemPrompt,
    userMessage,
    outputToolName: TERMS_TOOL,
    outputToolDescription: 'Return the generated keyword phrases.',
    schema,
    timeoutMs: 8_000,
  });
  return normalizeTerms(result?.terms);
}

export async function expandQuery(userPrompt: string): Promise<string[]> {
  const cacheKey = userPrompt.trim().toLowerCase().slice(0, 200);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const terms = await expandViaPi(QUERY_EXPANSION_SYSTEM, userPrompt, EXPANSION_SCHEMA);
  if (terms.length === 0) return [];

  log('[QueryExpansion] Expanded "%s" → %O', userPrompt.slice(0, 50), terms);
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(cacheKey, terms);
  return terms;
}

export async function expandMemoryTerms(entry: {
  content: string;
  title?: string;
  tags?: string[];
  facts?: string[];
}): Promise<string[]> {
  const inputParts = [
    entry.title ? `Title: ${entry.title}` : '',
    `Content: ${entry.content.slice(0, 500)}`,
    entry.tags?.length ? `Tags: ${entry.tags.join(', ')}` : '',
    entry.facts?.length ? `Facts: ${entry.facts.join('; ')}` : '',
  ].filter(Boolean);
  const input = inputParts.join('\n');

  const terms = await expandViaPi(MEMORY_EXPANSION_SYSTEM, input, INDEX_EXPANSION_SCHEMA);
  if (terms.length > 0) {
    log('[IndexExpansion] Generated %d terms for "%s"', terms.length, (entry.title ?? entry.content).slice(0, 40));
  }
  return terms;
}
