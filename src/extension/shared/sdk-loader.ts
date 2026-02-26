import { log } from '../logger';

export type SdkQuery = typeof import('@anthropic-ai/claude-agent-sdk').query;

let cachedSdkQuery: SdkQuery | null = null;

export function loadSdkQuery(): SdkQuery | null {
  if (cachedSdkQuery) return cachedSdkQuery;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sdk = require('@anthropic-ai/claude-agent-sdk') as typeof import('@anthropic-ai/claude-agent-sdk');
    cachedSdkQuery = sdk.query;
    return cachedSdkQuery;
  } catch (err) {
    log('[SdkLoader] Failed to load SDK module: %O', err);
    return null;
  }
}
