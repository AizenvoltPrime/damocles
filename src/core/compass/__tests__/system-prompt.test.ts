import { describe, it, expect } from 'vitest';
import { COMPASS_SYSTEM_PROMPT, COMPASS_AGENT_PROMPT } from '../system-prompt';

/**
 * Count occurrences so the ordering cases can insist the load step appears EXACTLY once — a stray second
 * copy would let a mis-ordered prompt still satisfy `loadStep < prescription`.
 */
const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

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

  // A prompt must never name a tool outside the active set without saying how to obtain it. Compass is a
  // DEFERRED group, and this prompt is emitted exactly when `compassEnabled` makes its tools eligible AND
  // therefore deferred. These pin the load step against a future edit that regenerates the snapshot. The
  // literal ToolSearch call is verbatim because that string is what the model copies.
  it('tells the model HOW to load the deferred Compass tools', () => {
    expect(COMPASS_SYSTEM_PROMPT).toContain('ToolSearch({tools:["compass"]})');
    expect(COMPASS_SYSTEM_PROMPT).toContain('NOT loaded at the start of your turn');
    expect(COMPASS_SYSTEM_PROMPT).toContain('callable from your next step');
  });

  it('places the load step BEFORE the Workflow: paragraph it gates', () => {
    const loadStep = COMPASS_SYSTEM_PROMPT.indexOf('NOT loaded at the start of your turn');
    const workflow = COMPASS_SYSTEM_PROMPT.indexOf('Workflow:');
    // Exactly one of each, so the `indexOf` comparison below cannot be satisfied by a stray earlier
    // copy of the load step while the operative one sits after the workflow.
    expect(occurrences(COMPASS_SYSTEM_PROMPT, 'NOT loaded at the start of your turn')).toBe(1);
    expect(occurrences(COMPASS_SYSTEM_PROMPT, 'Workflow:')).toBe(1);
    // Placement is the requirement, not mere presence: a load step the model reads only after it has
    // already been told to run the workflow does not stop the first call from erroring.
    expect(loadStep).toBeLessThan(workflow);
  });

  it('matches snapshot', () => {
    expect(COMPASS_SYSTEM_PROMPT).toMatchInlineSnapshot(`
      "<compass>
      Compass is a workspace knowledge graph of every function, class, type, and file and how they connect (calls, imports, inheritance, references).

      Use Compass when finding where something is defined, who calls/imports it, assessing change impact, or understanding architecture. Use Glob/Grep/Read directly when you already know the path/glob, need a known config file, or need a literal text search.

      The Compass tools are NOT loaded at the start of your turn — call ToolSearch({tools:["compass"]}) first; they are callable from your next step.

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

  // Same Slice 2 invariant as above. This constant reaches a subagent whose RESOLVED toolset actually
  // contains the Compass tools — `AgentManager` tests that membership and passes the block through the
  // `PromptExtras` seam, so a `tools: *` agent that inherited Compass from the parent panel gets it and
  // Explore/Plan (whose allowlist excludes Compass) do not. For those recipients it is the severe case:
  // it prescribes an OPENING workflow ("start with Compass") against a DEFERRED group, so without the
  // load step the subagent's very first tool call hits an unknown-tool error. Asserted separately from
  // the snapshot so the requirement survives a snapshot regeneration. The literal call string is pinned
  // because that is the text the model copies.
  it('tells the model HOW to load the deferred Compass tools', () => {
    expect(COMPASS_AGENT_PROMPT).toContain('ToolSearch({tools:["compass"]})');
    expect(COMPASS_AGENT_PROMPT).toContain('NOT loaded at the start of your turn');
    expect(COMPASS_AGENT_PROMPT).toContain('callable from your next step');
  });

  it('places the load step BEFORE the "start with Compass" block it gates', () => {
    const loadStep = COMPASS_AGENT_PROMPT.indexOf('NOT loaded at the start of your turn');
    const startWith = COMPASS_AGENT_PROMPT.indexOf('**Otherwise, start with Compass:**');
    // Exactly one of each — see the note on `occurrences`.
    expect(occurrences(COMPASS_AGENT_PROMPT, 'NOT loaded at the start of your turn')).toBe(1);
    expect(occurrences(COMPASS_AGENT_PROMPT, '**Otherwise, start with Compass:**')).toBe(1);
    // A load step buried after the numbered workflow the model has already started is not a fix.
    expect(loadStep).toBeLessThan(startWith);
  });

  it('matches snapshot', () => {
    expect(COMPASS_AGENT_PROMPT).toMatchInlineSnapshot(`
      "<compass>
      You have Compass MCP tools for this workspace's knowledge graph. A single \`CompassSearch\` replaces multiple Glob/Grep rounds, saving significant context tokens.

      **If your prompt already includes specific file paths and line numbers from a prior Compass call:** skip Compass tools — go straight to reading those files.

      The Compass tools are NOT loaded at the start of your turn — call \`ToolSearch({tools:["compass"]})\` first; they are callable from your next step.

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
