import { describe, it, expect } from 'vitest';
import { COMPASS_SYSTEM_PROMPT, COMPASS_AGENT_PROMPT } from '../system-prompt';

describe('COMPASS_SYSTEM_PROMPT — Opus 4.8 value-prop reframe', () => {
  it('includes the new value-proposition lead', () => {
    expect(COMPASS_SYSTEM_PROMPT).toContain('**Fast-path for code targeting:**');
  });

  it('preserves the plan-mode trigger in the new wording', () => {
    expect(COMPASS_SYSTEM_PROMPT).toContain('including plan-mode exploration');
  });

  it('preserves the decision-rule and how-to-use sections verbatim', () => {
    expect(COMPASS_SYSTEM_PROMPT).toContain('**Decision rule — use Compass when:**');
    expect(COMPASS_SYSTEM_PROMPT).toContain('**Use Glob/Grep/Read directly when:**');
    expect(COMPASS_SYSTEM_PROMPT).toContain('**How to use Compass:**');
    expect(COMPASS_SYSTEM_PROMPT).toContain('**Search tips:**');
  });

  it('drops the mandate framing', () => {
    expect(COMPASS_SYSTEM_PROMPT).not.toContain('**Mandatory first step:**');
    expect(COMPASS_SYSTEM_PROMPT).not.toContain('your FIRST tool call must be a Compass tool');
  });

  it('replaces the Grep-forbidding anti-pattern with empty-result interpretation guidance', () => {
    expect(COMPASS_SYSTEM_PROMPT).not.toContain("Don't fall through to Grep");
    expect(COMPASS_SYSTEM_PROMPT).toContain('Interpreting empty results');
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
      You have a workspace knowledge graph (Compass). It knows every function, class, type, and file in this codebase and how they connect (calls, imports, inheritance, references).

      **Fast-path for code targeting:** prefer Compass first when finding, understanding, or reviewing code — including plan-mode exploration. The tool descriptions explain the mechanics; this section explains when each applies.

      **Decision rule — use Compass when:**
      - You need to find where something is defined or who calls/imports it (\`CompassSearch\`, \`CompassQuery\`)
      - You need to assess change impact or review for risk (\`CompassReviewContext\` for full review with risk + flows + optional source; \`CompassBlastRadius\` for impact-only when you don't need risk data — review_context already includes blast-radius output, so don't call both)
      - You need to understand the architecture or how systems connect

      **Use Glob/Grep/Read directly when:**
      - You already know the exact file path or glob pattern (e.g., \`**/*.test.ts\`)
      - You need to read a known config file (e.g., \`package.json\`, \`tsconfig.json\`, \`.env*\`)
      - You need a literal text search inside file contents (error strings, log lines, comment text)

      **How to use Compass:**

      1. **Find entities:** \`CompassSearch "UserService"\` → file paths + qualified names
      2. **Find relationships:** \`CompassQuery pattern="callers_of" target="AuthManager::validateToken"\` → who calls it, who imports it
      3. **Assess impact:** \`CompassReviewContext changed_files=["src/auth.ts"] include_source=true\` → blast radius + risk + source
      4. **Read the code:** Use the file paths Compass returned → Read those files for implementation details

      **Search tips:** Search for ONE entity name per call — \`CompassSearch "AuthManager"\` not \`"AuthManager validateToken"\`. To find a method, search its class first then use \`CompassQuery pattern="children_of"\`. Multi-word queries match entities containing ANY of the terms. For \`CompassQuery\` targets: \`importers_of\`/\`imports_of\` want a file name with extension (\`ErrorPopup.vue\`) or a path-qualified name; bare symbol names are fine for \`callers_of\`/\`children_of\`. Direction: \`references_of\` lists what X references (outgoing); \`referencers_of\` lists who references X (incoming).

      **Interpreting empty results:** If \`CompassSearch\` returns nothing, the symbol probably doesn't exist by that name — Compass searches symbols, Grep searches text — so try a related name first. If \`CompassQuery\` returns "none", read the first line: it shows what the target actually resolved to (name, kind, path). Wrong entity → retry with a more specific target. Right entity but you expected results — especially for \`referencers_of\` or \`tests_for\` — treat "none" as a hypothesis and verify with one Grep; relationship coverage is never guaranteed.

      Budget: 1-3 Compass calls to build your read list, then Read the source files. Compass tells you WHERE to look — the code tells you WHAT it does.
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
