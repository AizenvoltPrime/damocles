import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CONTEXT_FILE_CANDIDATES,
  resolveGlobalContextFile,
  overrideGlobalContextFile,
} from '../context-files';

/**
 * Copied by hand from pi `packages/coding-agent/src/core/resource-loader.ts:70-71`
 * (`loadContextFileFromDir`) at the pinned version `^0.84.2`. It is a literal, not an import,
 * so a pi upgrade that changes the candidate order fails here instead of silently diverging.
 */
const PI_CONTEXT_FILE_CANDIDATES = [
  'AGENTS.override.md',
  'AGENTS.md',
  'AGENTS.MD',
  'CLAUDE.md',
  'CLAUDE.MD',
];

describe('context-files', () => {
  let home: string;
  let damoclesDir: string;
  let agentDir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-ctx-'));
    damoclesDir = path.join(home, '.damocles');
    // Mirrors PI_AGENT_DIR's layout so the containment check sees production-shaped paths.
    agentDir = path.join(damoclesDir, 'pi', 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  describe('CONTEXT_FILE_CANDIDATES', () => {
    it('matches pi\'s own candidate list, in pi\'s order', () => {
      expect([...CONTEXT_FILE_CANDIDATES]).toEqual(PI_CONTEXT_FILE_CANDIDATES);
    });
  });

  describe('resolveGlobalContextFile', () => {
    it('returns undefined when ~/.damocles holds no candidate file', () => {
      expect(resolveGlobalContextFile(home)).toBeUndefined();
    });

    it('returns undefined when ~/.damocles does not exist at all', () => {
      // Nested under the temp root so afterEach reclaims it even if the assertion fails.
      const bareHome = path.join(home, 'bare');
      fs.mkdirSync(bareHome);

      expect(resolveGlobalContextFile(bareHome)).toBeUndefined();
    });

    it('reads AGENTS.md from the top level of ~/.damocles', () => {
      fs.writeFileSync(path.join(damoclesDir, 'AGENTS.md'), 'global agents');

      expect(resolveGlobalContextFile(home)).toEqual({
        path: path.join(damoclesDir, 'AGENTS.md'),
        content: 'global agents',
      });
    });

    it('reads CLAUDE.md when it is the only candidate present', () => {
      fs.writeFileSync(path.join(damoclesDir, 'CLAUDE.md'), 'global claude');

      expect(resolveGlobalContextFile(home)).toEqual({
        path: path.join(damoclesDir, 'CLAUDE.md'),
        content: 'global claude',
      });
    });

    it('prefers AGENTS.md over CLAUDE.md when both exist', () => {
      fs.writeFileSync(path.join(damoclesDir, 'AGENTS.md'), 'global agents');
      fs.writeFileSync(path.join(damoclesDir, 'CLAUDE.md'), 'global claude');

      expect(resolveGlobalContextFile(home)).toEqual({
        path: path.join(damoclesDir, 'AGENTS.md'),
        content: 'global agents',
      });
    });

    it('prefers AGENTS.override.md over AGENTS.md when both exist', () => {
      fs.writeFileSync(path.join(damoclesDir, 'AGENTS.override.md'), 'override');
      fs.writeFileSync(path.join(damoclesDir, 'AGENTS.md'), 'global agents');

      expect(resolveGlobalContextFile(home)).toEqual({
        path: path.join(damoclesDir, 'AGENTS.override.md'),
        content: 'override',
      });
    });

    it('skips a directory named AGENTS.md and falls through to CLAUDE.md', () => {
      fs.mkdirSync(path.join(damoclesDir, 'AGENTS.md'));
      fs.writeFileSync(path.join(damoclesDir, 'CLAUDE.md'), 'global claude');

      expect(resolveGlobalContextFile(home)).toEqual({
        path: path.join(damoclesDir, 'CLAUDE.md'),
        content: 'global claude',
      });
    });

    // The content is re-sent in the system prompt every turn, so an oversize file is a per-turn cost
    // for the life of the window rather than a one-off.
    it('skips a candidate over the 1 MB ceiling and falls through to the next', () => {
      fs.writeFileSync(path.join(damoclesDir, 'AGENTS.md'), 'x'.repeat(1024 * 1024 + 1));
      fs.writeFileSync(path.join(damoclesDir, 'CLAUDE.md'), 'global claude');

      expect(resolveGlobalContextFile(home)).toEqual({
        path: path.join(damoclesDir, 'CLAUDE.md'),
        content: 'global claude',
      });
    });

    it('does not descend into pi/agent', () => {
      fs.writeFileSync(path.join(agentDir, 'AGENTS.md'), 'agent-dir agents');

      expect(resolveGlobalContextFile(home)).toBeUndefined();
    });
  });

  describe('overrideGlobalContextFile', () => {
    // Ancestor entries stand in for pi's project walk. They live under the temp root so the
    // paths are absolute and valid on every platform the suite runs on.
    let ancestorA: { path: string; content: string };
    let ancestorB: { path: string; content: string };
    let deep: { path: string; content: string };

    beforeEach(() => {
      const workspace = path.join(home, 'workspace');
      ancestorA = { path: path.join(workspace, 'AGENTS.md'), content: 'repo root' };
      ancestorB = { path: path.join(workspace, 'pkg', 'AGENTS.md'), content: 'package' };
      deep = { path: path.join(workspace, 'pkg', 'nested', 'AGENTS.md'), content: 'nested' };
    });

    it('prepends ~/.damocles/AGENTS.md and drops the agentDir entry', () => {
      fs.writeFileSync(path.join(damoclesDir, 'AGENTS.md'), 'global agents');
      const base = [
        { path: path.join(agentDir, 'AGENTS.md'), content: 'agent-dir agents' },
        ancestorA,
        ancestorB,
      ];

      expect(overrideGlobalContextFile(base, { agentDir, homeDir: home, trusted: true })).toEqual([
        { path: path.join(damoclesDir, 'AGENTS.md'), content: 'global agents' },
        ancestorA,
        ancestorB,
      ]);
    });

    it('prepends ~/.damocles/CLAUDE.md when it is the only global candidate', () => {
      fs.writeFileSync(path.join(damoclesDir, 'CLAUDE.md'), 'global claude');
      const base = [
        { path: path.join(agentDir, 'CLAUDE.md'), content: 'agent-dir claude' },
        ancestorA,
      ];

      expect(overrideGlobalContextFile(base, { agentDir, homeDir: home, trusted: true })).toEqual([
        { path: path.join(damoclesDir, 'CLAUDE.md'), content: 'global claude' },
        ancestorA,
      ]);
    });

    it('uses only AGENTS.md when both global candidates exist', () => {
      fs.writeFileSync(path.join(damoclesDir, 'AGENTS.md'), 'global agents');
      fs.writeFileSync(path.join(damoclesDir, 'CLAUDE.md'), 'global claude');
      const base = [
        { path: path.join(agentDir, 'AGENTS.md'), content: 'agent-dir agents' },
        ancestorA,
      ];

      expect(overrideGlobalContextFile(base, { agentDir, homeDir: home, trusted: true })).toEqual([
        { path: path.join(damoclesDir, 'AGENTS.md'), content: 'global agents' },
        ancestorA,
      ]);
    });

    it('returns base unchanged, agentDir entry included, when no global exists', () => {
      const agentEntry = { path: path.join(agentDir, 'AGENTS.md'), content: 'agent-dir agents' };
      const base = [agentEntry, ancestorA, ancestorB];

      expect(overrideGlobalContextFile(base, { agentDir, homeDir: home, trusted: true })).toEqual([
        agentEntry,
        ancestorA,
        ancestorB,
      ]);
    });

    it('does not mutate the caller\'s base array', () => {
      fs.writeFileSync(path.join(damoclesDir, 'AGENTS.md'), 'global agents');
      const agentEntry = { path: path.join(agentDir, 'AGENTS.md'), content: 'agent-dir agents' };
      const base = [agentEntry, ancestorA];

      overrideGlobalContextFile(base, { agentDir, homeDir: home, trusted: true });

      expect(base).toEqual([agentEntry, ancestorA]);
    });

    it('keeps ancestor order when a global is prepended', () => {
      fs.writeFileSync(path.join(damoclesDir, 'AGENTS.md'), 'global agents');
      const base = [
        { path: path.join(agentDir, 'AGENTS.md'), content: 'agent-dir agents' },
        ancestorA,
        ancestorB,
        deep,
      ];

      expect(overrideGlobalContextFile(base, { agentDir, homeDir: home, trusted: true })).toEqual([
        { path: path.join(damoclesDir, 'AGENTS.md'), content: 'global agents' },
        ancestorA,
        ancestorB,
        deep,
      ]);
    });

    it('keeps ancestor order when no global exists', () => {
      const base = [ancestorA, ancestorB, deep];

      expect(overrideGlobalContextFile(base, { agentDir, homeDir: home, trusted: true })).toEqual([
        ancestorA,
        ancestorB,
        deep,
      ]);
    });

    it('returns an empty list for an empty base with no global', () => {
      expect(overrideGlobalContextFile([], { agentDir, homeDir: home, trusted: true })).toEqual([]);
    });

    it('returns just the global for an empty base when one exists', () => {
      fs.writeFileSync(path.join(damoclesDir, 'AGENTS.md'), 'global agents');

      expect(overrideGlobalContextFile([], { agentDir, homeDir: home, trusted: true })).toEqual([
        { path: path.join(damoclesDir, 'AGENTS.md'), content: 'global agents' },
      ]);
    });

    it('prepends the global exactly once when base has no agentDir entry', () => {
      fs.writeFileSync(path.join(damoclesDir, 'AGENTS.md'), 'global agents');
      const base = [ancestorA, ancestorB];

      const result = overrideGlobalContextFile(base, { agentDir, homeDir: home, trusted: true });

      expect(result).toEqual([
        { path: path.join(damoclesDir, 'AGENTS.md'), content: 'global agents' },
        ancestorA,
        ancestorB,
      ]);
      expect(result.filter((e) => e.path === path.join(damoclesDir, 'AGENTS.md'))).toHaveLength(1);
    });

    it('emits the global once when pi already walked it in as an ancestor', () => {
      // A workspace at or under ~/.damocles/ puts the global on pi's ancestor walk too, and pi's own
      // seenPaths dedupe has finished before the override runs.
      fs.writeFileSync(path.join(damoclesDir, 'AGENTS.md'), 'global agents');
      const globalPath = path.join(damoclesDir, 'AGENTS.md');
      const base = [
        { path: path.join(agentDir, 'AGENTS.md'), content: 'agent-dir agents' },
        // Distinct content identifies which of the two copies of this path survived.
        { path: globalPath, content: 'ancestor-walk copy' },
        ancestorA,
        ancestorB,
      ];

      const result = overrideGlobalContextFile(base, { agentDir, homeDir: home, trusted: true });

      expect(result).toEqual([
        { path: globalPath, content: 'global agents' },
        ancestorA,
        ancestorB,
      ]);
      expect(result.filter((e) => e.path === globalPath)).toHaveLength(1);
    });

    it('keeps a sibling path that merely shares a string prefix with agentDir', () => {
      fs.writeFileSync(path.join(damoclesDir, 'AGENTS.md'), 'global agents');
      const sibling = {
        path: path.join(damoclesDir, 'pi', 'agentX', 'AGENTS.md'),
        content: 'not the agent dir',
      };
      const base = [
        { path: path.join(agentDir, 'AGENTS.md'), content: 'agent-dir agents' },
        sibling,
        ancestorA,
      ];

      expect(overrideGlobalContextFile(base, { agentDir, homeDir: home, trusted: true })).toEqual([
        { path: path.join(damoclesDir, 'AGENTS.md'), content: 'global agents' },
        sibling,
        ancestorA,
      ]);
    });

    it('drops entries nested below agentDir, not just its direct children', () => {
      fs.writeFileSync(path.join(damoclesDir, 'AGENTS.md'), 'global agents');
      const base = [
        { path: path.join(agentDir, 'nested', 'AGENTS.md'), content: 'nested agent-dir' },
        ancestorA,
      ];

      expect(overrideGlobalContextFile(base, { agentDir, homeDir: home, trusted: true })).toEqual([
        { path: path.join(damoclesDir, 'AGENTS.md'), content: 'global agents' },
        ancestorA,
      ]);
    });

    // A cloned repo's own AGENTS.md is spliced into the system prompt verbatim, which is the same
    // injection the project skill dirs are withheld for. The user's own global files are not the
    // repo's, so they load in either trust state.
    describe('untrusted workspace', () => {
      it('keeps the ~/.damocles global and drops every ancestor entry', () => {
        fs.writeFileSync(path.join(damoclesDir, 'AGENTS.md'), 'global agents');
        const base = [
          { path: path.join(agentDir, 'AGENTS.md'), content: 'agent-dir agents' },
          ancestorA,
          ancestorB,
          deep,
        ];

        expect(overrideGlobalContextFile(base, { agentDir, homeDir: home, trusted: false })).toEqual([
          { path: path.join(damoclesDir, 'AGENTS.md'), content: 'global agents' },
        ]);
      });

      it('keeps the agentDir entries and drops every ancestor entry when no global exists', () => {
        const agentEntry = { path: path.join(agentDir, 'AGENTS.md'), content: 'agent-dir agents' };
        const nestedAgentEntry = {
          path: path.join(agentDir, 'nested', 'AGENTS.md'),
          content: 'nested agent-dir',
        };
        const base = [agentEntry, nestedAgentEntry, ancestorA, ancestorB, deep];

        expect(overrideGlobalContextFile(base, { agentDir, homeDir: home, trusted: false })).toEqual([
          agentEntry,
          nestedAgentEntry,
        ]);
      });

      // The no-global branch is the one that used to return `base` untouched, so a repo file reaching
      // the prompt through it would leave nothing else to notice.
      it('returns nothing when the only entries are the ancestor walk and there is no global', () => {
        const base = [ancestorA, ancestorB, deep];

        expect(overrideGlobalContextFile(base, { agentDir, homeDir: home, trusted: false })).toEqual([]);
      });

      it('keeps a sibling of agentDir out, since it is not a user-authored source', () => {
        const sibling = {
          path: path.join(damoclesDir, 'pi', 'agentX', 'AGENTS.md'),
          content: 'not the agent dir',
        };
        const base = [{ path: path.join(agentDir, 'AGENTS.md'), content: 'agent-dir agents' }, sibling];

        expect(overrideGlobalContextFile(base, { agentDir, homeDir: home, trusted: false })).toEqual([
          { path: path.join(agentDir, 'AGENTS.md'), content: 'agent-dir agents' },
        ]);
      });

      it('emits the global once when pi already walked it in as an ancestor', () => {
        fs.writeFileSync(path.join(damoclesDir, 'AGENTS.md'), 'global agents');
        const globalPath = path.join(damoclesDir, 'AGENTS.md');
        const base = [
          { path: globalPath, content: 'ancestor-walk copy' },
          ancestorA,
        ];

        expect(overrideGlobalContextFile(base, { agentDir, homeDir: home, trusted: false })).toEqual([
          { path: globalPath, content: 'global agents' },
        ]);
      });

      it('returns an empty list for an empty base with no global', () => {
        expect(overrideGlobalContextFile([], { agentDir, homeDir: home, trusted: false })).toEqual([]);
      });

      it('does not mutate the caller\'s base array', () => {
        const agentEntry = { path: path.join(agentDir, 'AGENTS.md'), content: 'agent-dir agents' };
        const base = [agentEntry, ancestorA];

        overrideGlobalContextFile(base, { agentDir, homeDir: home, trusted: false });

        expect(base).toEqual([agentEntry, ancestorA]);
      });
    });
  });
});
