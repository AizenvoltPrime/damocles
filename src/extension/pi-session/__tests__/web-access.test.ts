import { describe, it, expect } from 'vitest';
import { WEB_ACCESS_SOURCE, isWebSearchEnabled } from '../web-access';

describe('web-access', () => {
  it('pins pi-web-access via the npm source form pi parses (npm:<pkg>@<version>)', () => {
    expect(WEB_ACCESS_SOURCE).toMatch(/^npm:pi-web-access@\d+\.\d+\.\d+$/);
  });

  it('is opt-in: web search is off unless the damocles setting is explicitly true', () => {
    expect(isWebSearchEnabled()).toBe(false);
  });
});
