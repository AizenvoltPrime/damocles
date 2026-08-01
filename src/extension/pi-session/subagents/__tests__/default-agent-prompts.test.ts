import { describe, it, expect } from 'vitest';
import { DEFAULT_AGENTS } from '../default-agents';

/**
 * The Explore/Plan capability sentence must point at `ToolSearch`, never at the groups it can load.
 * The deferred group list is dynamic (web, browser, compass, one per configured MCP server), so a
 * static enumeration goes stale group by group — it already cost a simultaneous edit across five
 * prompts when `web` was deferred. `ToolSearch`'s own description is the single live inventory.
 *
 * The bound is deliberately the capability sentence, not the whole prompt: the Tool Usage bullets DO
 * name their tools, adjacent to their own `ToolSearch({tools:[...]})` load step, which is the
 * never-name-a-deferred-tool-without-a-load-step invariant working as intended.
 */
describe('default agent prompts — ToolSearch is described by mechanism, not by contents', () => {
  /** The `can load … with \`ToolSearch\`` clause only — not the whole sentence, which legitimately
   *  mentions the web elsewhere ("when web tools are available, online sources"). */
  const loadClause = (agent: string): string => {
    const prompt = DEFAULT_AGENTS.get(agent)?.systemPrompt ?? '';
    const match = prompt.match(/can load [^;.]*`ToolSearch`[^;.]*/);
    expect(match, `${agent} prompt must state how to load more tools`).toBeTruthy();
    return match![0];
  };

  for (const agent of ['Explore', 'Plan']) {
    it(`${agent} names the mechanism and no group`, () => {
      const clause = loadClause(agent);
      expect(clause).toBe('can load additional tool groups with `ToolSearch`');
      for (const group of ['web', 'browser', 'compass', 'mcp']) {
        expect(clause.toLowerCase()).not.toContain(group);
      }
    });

    it(`${agent} keeps the capability list honest — the clause survives in the Role paragraph`, () => {
      const roleParagraph = (DEFAULT_AGENTS.get(agent)?.systemPrompt ?? '').split('\n')[1] ?? '';
      expect(roleParagraph).toContain('`ToolSearch`');
      expect(roleParagraph).toContain('cannot edit files');
    });
  }
});
