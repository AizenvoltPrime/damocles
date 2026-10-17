import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { overrideGlobalContextFile } from '../context-files';

/** Slice 12a rule 21: a chat worktree's instruction files read as if it sat where its project does. */
let base: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-ctx-')));
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

function file(p: string, text: string): { path: string; content: string } {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return { path: p, content: text };
}

describe('the instruction-file walk of a chat worktree', () => {
  it('reads the project repository\'s ancestors and the worktree, never ~/.damocles as an ancestor', () => {
    const home = path.join(base, 'home');
    const agentDir = path.join(home, '.damocles', 'pi', 'agent');
    const above = file(path.join(base, 'work', 'AGENTS.md'), 'above the repository');
    const repository = path.join(base, 'work', 'repo');
    fs.mkdirSync(repository, { recursive: true });
    const worktreeRoot = path.join(home, '.damocles', 'worktrees', 'repo-abcdef', 'aaaaaaaa');
    const inWorktree = file(path.join(worktreeRoot, 'AGENTS.md'), 'in the worktree');
    const damoclesAncestor = file(path.join(home, '.damocles', 'worktrees', 'AGENTS.md'), 'never');
    const global = file(path.join(home, '.damocles', 'AGENTS.md'), 'global');
    const piWalk = [damoclesAncestor, inWorktree];
    const files = overrideGlobalContextFile(piWalk, { agentDir, homeDir: home, trusted: true, worktree: { worktreeRoot, repositoryRoot: repository } });
    expect(files.map((f) => f.content)).toEqual([global.content, above.content, inWorktree.content]);
  });
});
