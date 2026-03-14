import type { StructuredTurn } from '../../types';

export interface MockReplResponse {
  text: string;
}

export interface MockIntentResponse {
  intent: string;
  secondaryIntent: string | null;
  keyEntities: string[];
}

export function createReplMockSdkQuery(
  responses: MockReplResponse[],
): (params: unknown) => AsyncGenerator<unknown> {
  let callIndex = 0;

  return function mockSdkQuery() {
    const response = responses[callIndex] ?? responses[responses.length - 1]!;
    callIndex++;

    return (async function* () {
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: response.text }],
        },
      };
    })();
  };
}

export function createFullMockSdkQuery(config: {
  intentResponse?: MockIntentResponse;
  replResponses: MockReplResponse[];
}): (params: unknown) => AsyncGenerator<unknown> {
  let replCallIndex = 0;

  return function mockSdkQuery(params: unknown) {
    const p = params as Record<string, unknown>;
    const options = p['options'] as Record<string, unknown> | undefined;
    const hasOutputFormat = !!options?.['outputFormat'];

    if (hasOutputFormat && config.intentResponse) {
      return (async function* () {
        yield {
          type: 'result',
          subtype: 'success',
          structured_output: config.intentResponse,
        };
      })();
    }

    const response = config.replResponses[replCallIndex] ?? config.replResponses[config.replResponses.length - 1]!;
    replCallIndex++;

    return (async function* () {
      yield {
        type: 'assistant',
        message: { content: [{ type: 'text', text: response.text }] },
      };
    })();
  };
}

export interface RetrievalScore {
  precision: number;
  recall: number;
  f1: number;
  retrievedIndices: number[];
}

export function scoreRetrieval(
  retrieved: string,
  expectedIndices: number[],
  history: StructuredTurn[],
): RetrievalScore {
  const retrievedIndices: number[] = [];
  for (const turn of history) {
    const promptTag = `[Prompt ${turn.promptIndex}]`;
    if (retrieved.includes(promptTag)) {
      retrievedIndices.push(turn.promptIndex);
    }
  }

  const expectedSet = new Set(expectedIndices);
  const truePositives = retrievedIndices.filter(i => expectedSet.has(i)).length;
  const precision = retrievedIndices.length > 0 ? truePositives / retrievedIndices.length : 0;
  const recall = expectedSet.size > 0 ? truePositives / expectedSet.size : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  return { precision, recall, f1, retrievedIndices };
}
