import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
// @ts-expect-error -- plain .mjs helper, no types
import { renderAgentProfiles, OUTPUT_FILE } from '../generate-agent-profiles.mjs';

const ROOT = join(__dirname, '..', '..');

describe('agent profile catalog', () => {
  it('the committed file is what the generator produces from agent-profiles/', () => {
    const committed = readFileSync(OUTPUT_FILE as string, 'utf8').replace(/\r\n/g, '\n');
    const { text } = (renderAgentProfiles as (root: string) => { text: string })(ROOT);
    expect(committed, 'agent-profiles/ changed without a regenerate. Run: npm run generate:profiles').toBe(text);
  });
});
