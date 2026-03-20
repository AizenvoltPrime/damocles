import { log } from '../logger';
import { haikuStructuredQuery } from './haiku-query';
import type { StructuredTurn } from './types';

export interface TurnIndexData {
  summary: string;
  keywords: string[];
}

const TURN_INDEX_SCHEMA = {
  type: 'object',
  properties: {
    summary: {
      type: 'string',
      description: 'One sentence summarizing what happened in this conversation turn',
    },
    keywords: {
      type: 'array',
      items: { type: 'string' },
      minItems: 3,
      maxItems: 10,
      description: 'Domain-specific keywords: file paths, technical terms, component names, error types, concepts',
    },
  },
  required: ['summary', 'keywords'],
  additionalProperties: false,
};

const TURN_INDEX_SYSTEM_PROMPT =
  'Summarize this conversation turn in one sentence and extract 3-10 domain-specific keyword tags. ' +
  'Keywords must be: file paths, technical terms, component names, error types, API names, concepts. ' +
  'Do NOT include generic words like "fix", "update", "help", "code", "file", "implement". ' +
  'Focus on words someone would search for to find this specific conversation.';

export async function indexTurn(
  turn: StructuredTurn,
  cwd: string,
  abortSignal?: AbortSignal,
): Promise<TurnIndexData | null> {
  const userSlice = turn.userMessage.slice(0, 500);
  const assistantSlice = turn.assistantResponse.slice(0, 1000);
  const files = turn.filesTouched.join(', ');
  const tools = turn.toolCalls.map(tc => tc.name).join(', ');

  const userMessage = [
    `User: ${userSlice}`,
    `Assistant: ${assistantSlice}`,
    files ? `Files touched: ${files}` : '',
    tools ? `Tools used: ${tools}` : '',
  ].filter(Boolean).join('\n');

  try {
    return await haikuStructuredQuery<TurnIndexData>({
      systemPrompt: TURN_INDEX_SYSTEM_PROMPT,
      userMessage,
      schema: TURN_INDEX_SCHEMA,
      cwd,
      abortSignal,
    });
  } catch (err) {
    log('[TurnIndexer] Failed for prompt %d: %O', turn.promptIndex, err);
    return null;
  }
}
