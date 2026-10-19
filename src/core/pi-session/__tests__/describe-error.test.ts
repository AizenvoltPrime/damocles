import { describe, expect, it } from 'vitest';
import { describeCatalogError } from '../describe-error';

describe('describeCatalogError', () => {
  it.each([
    ['pi.dev catalog (remote-catalog-provider.js:173)', 'Model catalog request failed for openrouter: 503', 'Error (HTTP 503)'],
    ["OpenRouter's /models/user (openrouter.js:32)", 'OpenRouter model list request failed: 500', 'Error (HTTP 500)'],
  ])("reads the status from pi's %s failure", (_source, message, described) => {
    expect(describeCatalogError(new Error(message))).toBe(described);
  });

  it('reads no status from a message that only ends in three digits', () => {
    expect(describeCatalogError(new TypeError('connect ECONNREFUSED 127.0.0.1 port 443'))).toBe('TypeError');
  });
});
