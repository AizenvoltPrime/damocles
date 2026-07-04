import { describe, it, expect } from 'vitest';
import { COMPASS_SYSTEM_PROMPT, COMPASS_AGENT_PROMPT } from '../system-prompt';

describe('COMPASS_SYSTEM_PROMPT — Opus 4.8 value-prop reframe', () => {
  it('includes the value-proposition lead', () => {
    expect(COMPASS_SYSTEM_PROMPT).toContain('Compass is a workspace knowledge graph');
  });

  it('keeps the decision rule and the search→read workflow', () => {
    expect(COMPASS_SYSTEM_PROMPT).toContain('Use Compass when finding where something is defined');
    expect(COMPASS_SYSTEM_PROMPT).toContain('Use Glob/Grep/Read directly when you already know the path/glob');
    expect(COMPASS_SYSTEM_PROMPT).toContain('Workflow:');
    expect(COMPASS_SYSTEM_PROMPT).toContain('Search ONE entity name per call');
  });

  it('keeps the ReviewContext/BlastRadius dedup note', () => {
    expect(COMPASS_SYSTEM_PROMPT).toContain("so don't also call CompassBlastRadius");
  });

  it('drops the mandate framing and the verbose walkthrough', () => {
    expect(COMPASS_SYSTEM_PROMPT).not.toContain('**Mandatory first step:**');
    expect(COMPASS_SYSTEM_PROMPT).not.toContain('**Fast-path for code targeting:**');
    expect(COMPASS_SYSTEM_PROMPT).not.toContain('**How to use Compass:**');
    expect(COMPASS_SYSTEM_PROMPT).not.toContain('**Search tips:**');
  });

  it('replaces the Grep-forbidding anti-pattern with empty-result interpretation guidance', () => {
    expect(COMPASS_SYSTEM_PROMPT).not.toContain("Don't fall through to Grep");
    expect(COMPASS_SYSTEM_PROMPT).toContain('Empty results:');
    expect(COMPASS_SYSTEM_PROMPT).toContain('one Grep');
    expect(COMPASS_SYSTEM_PROMPT).toContain('resolved');
  });

  it('preserves the <compass> XML wrapper', () => {
    expect(COMPASS_SYSTEM_PROMPT.startsWith('<compass>')).toBe(true);
    expect(COMPASS_SYSTEM_PROMPT.endsWith('</compass>')).toBe(true);
  });

  it('matches snapshot', () => {
    expect(COMPASS_SYSTEM_PROMPT).toMatchInlineSnapshot(`
      "<compass>
      Compass is a workspace knowledge graph of every function, class, type, and file and how they connect (calls, imports, inheritance, references).

      Use Compass when finding where something is defined, who calls/imports it, assessing change impact, or understanding architecture. Use Glob/Grep/Read directly when you already know the path/glob, need a known config file, or need a literal text search.

      Workflow: CompassSearch/CompassQuery to build a read list (1-3 calls), then Read the source — Compass tells you WHERE, the code tells you WHAT. For review, CompassReviewContext returns blast radius + risk + source in one call, so don't also call CompassBlastRadius.

      Search ONE entity name per call — CompassSearch "AuthManager", not "AuthManager validateToken".

      Empty results: CompassSearch returns nothing → the symbol likely doesn't exist by that name (it indexes symbols, not text); try a related name. CompassQuery "none" → read the first line for what the target resolved to; if it's the right entity but you expected results, verify with one Grep, since relationship coverage isn't guaranteed.
      </compass>"
    `);
  });
});

describe('COMPASS_AGENT_PROMPT — softened tone', () => {
  it('uses the softer "start with Compass" framing', () => {
    expect(COMPASS_AGENT_PROMPT).toContain('**Otherwise, start with Compass:**');
    expect(COMPASS_AGENT_PROMPT).not.toContain('your first tool call must be Compass');
  });

  it('retains the CompassBuild safety-critical negative', () => {
    expect(COMPASS_AGENT_PROMPT).toContain('Do not call `CompassBuild`');
  });

  it('preserves the <compass> XML wrapper', () => {
    expect(COMPASS_AGENT_PROMPT.startsWith('<compass>')).toBe(true);
    expect(COMPASS_AGENT_PROMPT.endsWith('</compass>')).toBe(true);
  });

  it('matches snapshot', () => {
    expect(COMPASS_AGENT_PROMPT).toMatchInlineSnapshot(`
      "<compass>
      You have Compass MCP tools for this workspace's knowledge graph. A single \`CompassSearch\` replaces multiple Glob/Grep rounds, saving significant context tokens.

      **If your prompt already includes specific file paths and line numbers from a prior Compass call:** skip Compass tools — go straight to reading those files.

      **Otherwise, start with Compass:**
      1. \`CompassSearch "keyword"\` → entity names + file paths + line numbers
      2. Read those source files for implementation details
      3. For change review: \`CompassReviewContext changed_files=[...] include_source=true\`

      If \`CompassQuery\` returns "none", check its first line (what the target resolved to); verify surprising "none" results with one Grep.

      Budget: 1-2 Compass calls, then file Reads. Do not call \`CompassBuild\`.
      </compass>"
    `);
  });
});
