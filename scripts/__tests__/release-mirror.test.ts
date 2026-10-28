import { describe, expect, it } from 'vitest';
import { decodedPath } from '../../e2e/remote/support/release-mirror';

describe('the release mirror\'s request paths', () => {
  // decodeURIComponent throws on a malformed escape, which inside the request handler would crash the Playwright worker
  it('decodes escapes, and answers a malformed one with undefined instead of throwing', () => {
    expect(decodedPath('/download/v3.7.0/damocles-server-3.7.0-linux-x64.tar.gz')).toBe('/download/v3.7.0/damocles-server-3.7.0-linux-x64.tar.gz');
    expect(decodedPath('/download/v3.7.0/a%20b')).toBe('/download/v3.7.0/a b');
    expect(decodedPath('/download/%E0%A4%A')).toBeUndefined();
    expect(decodedPath('/%')).toBeUndefined();
  });
});
