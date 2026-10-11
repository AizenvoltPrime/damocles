import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
// @ts-expect-error -- plain .mjs helper, no types
import { renderAgentProfiles, OUTPUT_FILE } from '../generate-agent-profiles.mjs';

const ROOT = join(__dirname, '..', '..');
const render = renderAgentProfiles as (root: string) => { text: string };

// A `$` escaped by an odd run of backslashes, where a template literal needs only `${` escaped.
const NEEDLESS_DOLLAR_ESCAPE = /(?<!\\)(?:\\\\)*\\\$(?!\{)/;

describe('agent profile catalog', () => {
  let tempRoot: string | undefined;
  afterEach(() => {
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  });

  it('the committed file is what the generator produces from agent-profiles/', () => {
    const committed = readFileSync(OUTPUT_FILE as string, 'utf8').replace(/\r\n/g, '\n');
    const { text } = render(ROOT);
    expect(committed, 'agent-profiles/ changed without a regenerate. Run: npm run generate:profiles').toBe(text);
  });

  it('escapes `${` only, so a lone `$` is not a useless escape', () => {
    expect(render(ROOT).text).not.toMatch(NEEDLESS_DOLLAR_ESCAPE);
  });

  it.each([
    ['a trailing `$`', 'Costs $x, renders ${y}, quotes `z`, keeps \\$ and \\${w}, ends in $'],
    ['a trailing backslash', 'Costs $x, renders ${y}, quotes `z`, keeps \\$ and \\${w}, ends in \\'],
  ])('round-trips `$`, `${`, backticks and backslashes, with %s, through the rendered template literal', (_edge, identity) => {
    tempRoot = mkdtempSync(join(tmpdir(), 'agent-profiles-'));
    const dir = join(tempRoot, 'agent-profiles', 'engineering');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'engineering-dollar.md'),
      `---\nname: Dollar\ndescription: d\n---\n\n## Identity\n${identity}\n\n## Core Mission\nm\n\n## Critical Rules\nr\n`,
    );

    const { text } = render(tempRoot);
    expect(text).not.toMatch(NEEDLESS_DOLLAR_ESCAPE);
    const literal = /^ {4}identity: (`(?:\\[\s\S]|[^\\`])*`),$/m.exec(text)?.[1];
    expect(literal).toBeDefined();
    expect(new Function(`return ${literal};`)()).toBe(identity);
  });
});
