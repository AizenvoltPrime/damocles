import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { discover } from '../discovery';
import type { GitCall, GitRunner } from '../git-runner';

const sandbox = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-scm-discovery-')));

afterAll(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

// git's answer to the project folder's top-level lookup when the repository holding it belongs to another user
function refusedFor(owner: string): GitRunner {
  return {
    git: { path: '/usr/bin/git', version: { major: 2, minor: 45, patch: 0 } },
    envFor: () => ({}),
    run: async (call: GitCall) => ({
      exitCode: 128,
      stdout: Buffer.alloc(0),
      stderr: call.cwd === sandbox ? `fatal: detected dubious ownership in repository at '${owner}'\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory ${owner}\n` : '',
    }),
  };
}

describe('discovery', () => {
  it('treats an unsafe repository above the project folder as a parent, never offering safe.directory before D9', async () => {
    const owner = path.dirname(sandbox).replace(/\\/g, '/');
    const result = await discover(refusedFor(owner), sandbox, sandbox, 1, () => true);
    expect(result.unsafe).toEqual([]);
    expect(result.parents).toEqual([owner]);
  });

  it('offers safe.directory for an unsafe repository at the project folder, with the path as git printed it', async () => {
    const owner = sandbox.replace(/\\/g, '/');
    const result = await discover(refusedFor(owner), sandbox, sandbox, 1, () => true);
    expect(result.unsafe).toEqual([owner]);
    expect(result.parents).toEqual([]);
  });
});
