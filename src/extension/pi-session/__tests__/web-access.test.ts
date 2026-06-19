import { describe, it, expect } from 'vitest';
import { isWebSearchEnabled } from '../web-access';

describe('web-access', () => {
  it('is opt-in: web search is off unless the damocles setting is explicitly true', () => {
    expect(isWebSearchEnabled()).toBe(false);
  });
});
