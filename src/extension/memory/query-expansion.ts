import { log } from '../logger';
import { loadSdkQuery } from '../shared/sdk-loader';
import { getSmallFastModel, requireAuthFor } from '../auth/sdk-env';
import { buildSubCallEnv, getSmallFastModelForBackend, type SubCallBridgeCtx } from '../auth/sub-call-env';
import { getEffectiveHarness } from '../pi-session/harness';
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

/** Normalize raw expansion terms (trim, lowercase, drop single chars). */
function normalizeTerms(terms: string[] | undefined): string[] {
  if (!Array.isArray(terms)) return [];
  return terms.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 1);
}

export function clearExpansionCache(): void {
  cache.clear();
}

/** Run an expansion on the pi harness via the small/fast structured completion (US-006b). Fails soft. */
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

/** Run query expansion through the SDK fallback path (Node < 22). Fails soft to `[]`. */
async function expandQueryViaSdk(userPrompt: string, bridgeCtx: SubCallBridgeCtx | null): Promise<string[]> {
  const sdkQuery = loadSdkQuery();
  if (!sdkQuery) return [];

  const backend = bridgeCtx ? 'openai' : 'anthropic';
  const expansionModel = backend === 'openai' ? getSmallFastModelForBackend('openai') : getSmallFastModel();
  const auth = await requireAuthFor({ modelValue: expansionModel, featureName: 'memory.expandQuery' });
  if (!auth.ok) return [];

  const subCallEnv = await buildSubCallEnv(expansionModel, bridgeCtx);
  if (!subCallEnv) return [];

  try {
    const generator = sdkQuery({
      prompt: userPrompt,
      options: {
        model: subCallEnv.resolvedModel,
        systemPrompt: QUERY_EXPANSION_SYSTEM,
        tools: [] as string[],
        persistSession: false,
        outputFormat: { type: 'json_schema' as const, schema: EXPANSION_SCHEMA },
        env: subCallEnv.env,
      },
    } as Parameters<typeof sdkQuery>[0]);

    let structuredOutput: { terms: string[] } | null = null;
    for await (const event of generator) {
      const msg = event as { type: string; subtype?: string; structured_output?: { terms: string[] }; result?: string };
      if (msg.type === 'result') {
        if (msg.subtype === 'error_max_structured_output_retries') {
          log('[QueryExpansion] Structured output retries exhausted');
          return [];
        }
        structuredOutput = extractTermsFromResult(msg);
      }
    }
    return normalizeTerms(structuredOutput?.terms);
  } catch (err) {
    log('[QueryExpansion] Failed: %O', err);
    return [];
  }
}

/** Run memory-term expansion through the SDK fallback path (Node < 22). Fails soft to `[]`. */
async function expandMemoryTermsViaSdk(input: string, bridgeCtx: SubCallBridgeCtx | null): Promise<string[]> {
  const sdkQuery = loadSdkQuery();
  if (!sdkQuery) return [];

  const backend = bridgeCtx ? 'openai' : 'anthropic';
  const expansionModel = backend === 'openai' ? getSmallFastModelForBackend('openai') : getSmallFastModel();
  const auth = await requireAuthFor({ modelValue: expansionModel, featureName: 'memory.expandMemoryTerms' });
  if (!auth.ok) return [];

  const subCallEnv = await buildSubCallEnv(expansionModel, bridgeCtx);
  if (!subCallEnv) return [];

  try {
    const generator = sdkQuery({
      prompt: input,
      options: {
        model: subCallEnv.resolvedModel,
        systemPrompt: MEMORY_EXPANSION_SYSTEM,
        tools: [] as string[],
        persistSession: false,
        outputFormat: { type: 'json_schema' as const, schema: INDEX_EXPANSION_SCHEMA },
        env: subCallEnv.env,
      },
    } as Parameters<typeof sdkQuery>[0]);

    let structuredOutput: { terms: string[] } | null = null;
    for await (const event of generator) {
      const msg = event as { type: string; subtype?: string; structured_output?: { terms: string[] }; result?: string };
      if (msg.type === 'result') {
        if (msg.subtype === 'error_max_structured_output_retries') {
          log('[IndexExpansion] Structured output retries exhausted');
          return [];
        }
        structuredOutput = extractTermsFromResult(msg);
      }
    }
    return normalizeTerms(structuredOutput?.terms);
  } catch (err) {
    log('[IndexExpansion] Failed: %O', err);
    return [];
  }
}

export async function expandQuery(
  userPrompt: string,
  bridgeCtx: SubCallBridgeCtx | null = null,
): Promise<string[]> {
  const cacheKey = userPrompt.trim().toLowerCase().slice(0, 200);
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const terms =
    getEffectiveHarness() === 'pi'
      ? await expandViaPi(QUERY_EXPANSION_SYSTEM, userPrompt, EXPANSION_SCHEMA)
      : await expandQueryViaSdk(userPrompt, bridgeCtx);

  if (terms.length === 0) return [];

  log('[QueryExpansion] Expanded "%s" → %O', userPrompt.slice(0, 50), terms);
  if (cache.size >= MAX_CACHE_SIZE) {
    const firstKey = cache.keys().next().value;
    if (firstKey !== undefined) cache.delete(firstKey);
  }
  cache.set(cacheKey, terms);
  return terms;
}

export async function expandMemoryTerms(
  entry: {
    content: string;
    title?: string;
    tags?: string[];
    facts?: string[];
  },
  bridgeCtx: SubCallBridgeCtx | null = null,
): Promise<string[]> {
  const inputParts = [
    entry.title ? `Title: ${entry.title}` : '',
    `Content: ${entry.content.slice(0, 500)}`,
    entry.tags?.length ? `Tags: ${entry.tags.join(', ')}` : '',
    entry.facts?.length ? `Facts: ${entry.facts.join('; ')}` : '',
  ].filter(Boolean);
  const input = inputParts.join('\n');

  const terms =
    getEffectiveHarness() === 'pi'
      ? await expandViaPi(MEMORY_EXPANSION_SYSTEM, input, INDEX_EXPANSION_SCHEMA)
      : await expandMemoryTermsViaSdk(input, bridgeCtx);

  if (terms.length > 0) {
    log('[IndexExpansion] Generated %d terms for "%s"', terms.length, (entry.title ?? entry.content).slice(0, 40));
  }
  return terms;
}
