import { describe, it, expect } from 'vitest';
import { COMPASS_SYSTEM_PROMPT, COMPASS_AGENT_PROMPT } from '../system-prompt';

describe('COMPASS_SYSTEM_PROMPT — Opus 4.7 value-prop reframe', () => {
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

  it('preserves the <compass> XML wrapper', () => {
    expect(COMPASS_SYSTEM_PROMPT.startsWith('<compass>')).toBe(true);
    expect(COMPASS_SYSTEM_PROMPT.endsWith('</compass>')).toBe(true);
  });

  it('matches snapshot', () => {
    expect(COMPASS_SYSTEM_PROMPT).toMatchInlineSnapshot(`
      "<compass>
      You have a workspace knowledge graph (Compass). It knows every function, class, type, and file in this codebase and how they connect (calls, imports, inheritance, references).

      **Fast-path for code targeting:** a single \`compass_search\` call returns exact file paths + line numbers, replacing 3-5 rounds of Glob/Grep guessing. Prefer Compass first when your task involves finding, understanding, or reviewing code — including plan-mode exploration. It saves significant tokens and lands you on the right file immediately.

      **Decision rule — use Compass when:**
      - You need to find where something is defined or who calls/imports it
      - You need to understand what a change will affect (blast radius)
      - You need to review changes or assess risk
      - You need to understand the architecture or how systems connect

      **Use Glob/Grep/Read directly when:**
      - You already know the exact file path or glob pattern (e.g., \`**/*.test.ts\`, config files)
      - You need to search for a literal string inside file contents

      **How to use Compass:**

      1. **Find entities:** \`compass_search "UserService"\` → file paths + qualified names (one call replaces multiple Globs)
      2. **Find relationships:** \`compass_query pattern="callers_of" target="AuthManager::validateToken"\` → who calls it, who imports it
      3. **Assess impact:** \`compass_review_context changed_files=["src/auth.ts"] include_source=true\` → blast radius + risk + source
      4. **Read the code:** Use the file paths Compass returned → Read those files for implementation details

      **Search tips:** Search for ONE entity name per call — \`compass_search "AuthManager"\` not \`"AuthManager validateToken"\`. To find a method, search its class first then use \`compass_query pattern="children_of"\`. Multi-word queries match entities containing ANY of the terms.

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

  it('retains the compass_build safety-critical negative', () => {
    expect(COMPASS_AGENT_PROMPT).toContain('Do not call `compass_build`');
  });

  it('preserves the <compass> XML wrapper', () => {
    expect(COMPASS_AGENT_PROMPT.startsWith('<compass>')).toBe(true);
    expect(COMPASS_AGENT_PROMPT.endsWith('</compass>')).toBe(true);
  });

  it('matches snapshot', () => {
    expect(COMPASS_AGENT_PROMPT).toMatchInlineSnapshot(`
      "<compass>
      You have Compass MCP tools for this workspace's knowledge graph. A single \`compass_search\` replaces multiple Glob/Grep rounds, saving significant context tokens.

      **If your prompt already includes specific file paths and line numbers from a prior Compass call:** skip Compass tools — go straight to reading those files.

      **Otherwise, start with Compass:**
      1. \`compass_search "keyword"\` → entity names + file paths + line numbers
      2. Read those source files for implementation details
      3. For change review: \`compass_review_context changed_files=[...] include_source=true\`

      Budget: 1-2 Compass calls, then file Reads. Do not call \`compass_build\`.
      </compass>"
    `);
  });
});
