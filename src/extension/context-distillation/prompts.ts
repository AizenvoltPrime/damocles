import type { ContextEntryRow } from './types';

export const STRUCTURED_ANNOTATION_SYSTEM_PROMPT = `You are a context indexer for a coding session.
Given entries from the latest prompt and historical entries from prior prompts,
produce a JSON object with annotations, cross-prompt links, and a prompt summary.

For each current entry:
- description: 1-2 sentence summary of what this activity accomplished
- tags: comma-separated keywords for FTS search (file names, concepts, actions)
- related_files: array of other file paths related to this entry
- low_relevance: true only for trivial actions (checking existence, failed reads, empty results)
- confidence: 0.0-1.0 for how well you understand the entry's purpose
- semantic_group: short label grouping logically related entries (e.g. "auth-refactor", "test-setup")

Discussion entries represent text-only responses with no tool calls. Use the assistant_activity to write their description and tags.

If retry_entries are provided, these are entries from earlier prompts that previously failed annotation.
Annotate them the same way as current entries using their original context.

For links, connect current entries to historical entries when semantically related:
- depends_on: this entry's work relies on a previous entry
- extends: this entry continues or builds upon previous work
- reverts: this entry undoes or replaces a previous entry's changes
- related: general semantic connection

Output ONLY valid JSON matching the expected schema. No markdown fencing, no explanation.`;

export const ANNOTATION_OUTPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    annotations: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          entry_id: { type: 'number' as const },
          description: { type: 'string' as const },
          tags: { type: 'string' as const },
          related_files: { type: 'array' as const, items: { type: 'string' as const } },
          low_relevance: { type: 'boolean' as const },
          confidence: { type: 'number' as const },
          semantic_group: { type: 'string' as const },
        },
        required: ['entry_id', 'description', 'tags', 'related_files', 'low_relevance', 'confidence', 'semantic_group'] as const,
        additionalProperties: false,
      },
    },
    links: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          source_entry_id: { type: 'number' as const },
          target_entry_id: { type: 'number' as const },
          link_type: { type: 'string' as const, enum: ['depends_on', 'extends', 'reverts', 'related'] as const },
        },
        required: ['source_entry_id', 'target_entry_id', 'link_type'] as const,
        additionalProperties: false,
      },
    },
    prompt_summary: {
      type: 'object' as const,
      properties: {
        summary: { type: 'string' as const },
        tags: { type: 'string' as const },
      },
      required: ['summary', 'tags'] as const,
      additionalProperties: false,
    },
  },
  required: ['annotations', 'links', 'prompt_summary'] as const,
  additionalProperties: false,
};

export const DECOMPOSITION_SYSTEM_PROMPT = `You are a search query decomposer for a coding session history database. Given a user's coding prompt, extract 1-4 distinct search facets. Each facet is a short keyword-rich phrase (3-8 words) targeting a different topic or intent in the prompt. Use file names, function names, module names, and technical terms. Omit filler words. If the prompt has only one topic, return one facet.`;

export const DECOMPOSITION_SCHEMA = {
  type: 'object' as const,
  properties: {
    facets: {
      type: 'array' as const,
      items: { type: 'string' as const },
      minItems: 1,
      maxItems: 4,
    },
  },
  required: ['facets'] as const,
  additionalProperties: false,
};

export const RERANKING_SCHEMA = {
  type: 'object' as const,
  properties: {
    rankings: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          id: { type: 'number' as const },
          relevance: { type: 'number' as const },
        },
        required: ['id', 'relevance'] as const,
        additionalProperties: false,
      },
    },
  },
  required: ['rankings'] as const,
  additionalProperties: false,
};

interface HistoricalEntry {
  id: number;
  prompt_index: number;
  file_path: string | null;
  description: string | null;
  tags: string | null;
  semantic_group: string | null;
}

export function buildAnnotationPrompt(
  userPrompt: string,
  assistantSummary: string,
  currentEntries: ContextEntryRow[],
  historicalEntries: HistoricalEntry[],
  failedEntries?: ContextEntryRow[],
): string {
  const current = currentEntries.map(e => ({
    id: e.id,
    file_path: e.file_path,
    entry_type: e.entry_type,
    tool_calls: JSON.parse(e.tool_calls as string),
  }));

  const historical = historicalEntries.map(e => ({
    id: e.id,
    prompt_index: e.prompt_index,
    file_path: e.file_path,
    description: e.description,
    tags: e.tags,
    semantic_group: e.semantic_group,
  }));

  const retry = failedEntries && failedEntries.length > 0
    ? failedEntries.map(e => ({
        id: e.id,
        prompt_index: e.prompt_index,
        file_path: e.file_path,
        entry_type: e.entry_type,
        tool_calls: JSON.parse(e.tool_calls as string),
      }))
    : null;

  const hasRetry = retry !== null;

  return [
    `<user_prompt>${userPrompt}</user_prompt>`,
    `<assistant_activity>\n${assistantSummary}\n</assistant_activity>`,
    `<current_entries>\n${JSON.stringify(current, null, 2)}\n</current_entries>`,
    historical.length > 0
      ? `<historical_entries>\n${JSON.stringify(historical, null, 2)}\n</historical_entries>`
      : '',
    hasRetry
      ? `<retry_entries>\n${JSON.stringify(retry, null, 2)}\n</retry_entries>`
      : '',
    hasRetry
      ? 'Annotate all current entries and any retry entries. Output only the JSON object.'
      : 'Annotate all current entries. Output only the JSON object.',
  ].filter(Boolean).join('\n\n');
}
