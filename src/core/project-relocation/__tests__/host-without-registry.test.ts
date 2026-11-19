import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { WORKTREES_ROOT_DIR } from '../../paths';
import { REGISTRY_FILE } from '../../worktrees/registry';
import { ProjectRelocations } from '../index';

// A host that keeps no worktree registry of its own (VS Code): preflight and the steps read the shared registry.json.

let tmp: string;
let P: string;
let P_NEW: string;
let relocations: ProjectRelocations;
const registryFile = path.join(WORKTREES_ROOT_DIR, REGISTRY_FILE);

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'no-registry-')));
  P = path.join(tmp, 'repos', 'acme');
  P_NEW = path.join(tmp, 'moved', 'acme');
  fs.mkdirSync(P_NEW, { recursive: true });
  fs.mkdirSync(WORKTREES_ROOT_DIR, { recursive: true });
  relocations = new ProjectRelocations({
    requestedBy: 'vscode',
    watcherFactory: createFakePlatform().fileWatchers,
    metaIndex: { move: async () => undefined, meta: async () => null },
    memory: { relocateWorkspace: async () => ({}) },
    hostState: { mcp: { relocateFolders: async () => undefined } },
    trust: { isTrusted: () => false, onDidChangeTrust: () => ({ dispose: () => undefined }) },
    projectFolders: () => [P_NEW],
    log: () => undefined,
    file: path.join(tmp, 'project-relocations.json'),
    identitiesFile: path.join(tmp, 'folder-identities.json'),
    lockDir: path.join(tmp, 'locks'),
  });
});

afterEach(() => {
  relocations.dispose();
  fs.rmSync(WORKTREES_ROOT_DIR, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a relocation on a host without a worktree registry', () => {
  it('refuses while registry.json does not parse, since the project\'s chat worktree records cannot be known', async () => {
    fs.writeFileSync(registryFile, '{ broken');
    expect(await relocations.preflight({ from: P, to: P_NEW, listed: [P_NEW] })).toEqual({ ok: false, refusal: { code: 'registryUnreadable' } });
  });

  it('re-points an adopted record of the project when it has no chat worktree', async () => {
    const adopted = { id: 'dddd4444', kind: 'adopted', projectPath: P, repositoryRoot: P, worktreeRoot: path.join(tmp, 'adopted'), workingFolder: path.join(tmp, 'adopted'), createdAt: 1 };
    fs.writeFileSync(registryFile, `${JSON.stringify({ version: 1, records: [adopted] }, null, 2)}\n`);
    const started = await relocations.relocate({ from: P, to: P_NEW, listed: [P_NEW] });
    expect(started).toEqual({ id: expect.any(String) });
    await relocations.whenIdle();
    expect(relocations.views()).toMatchObject([{ state: 'coreDone' }]);
    const records = (JSON.parse(fs.readFileSync(registryFile, 'utf8')) as { records: Array<{ id: string; projectPath: string }> }).records;
    expect(records.find((record) => record.id === adopted.id)?.projectPath).toBe(P_NEW);
  });
});
