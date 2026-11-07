import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AutoCheckpointProducer, folderIdFor, folderRepoFor, getFolderRepoDir } from '../../pi-session/checkpoints';
import type { DesignRole } from '../design-entries';
import { readManifest } from '../design-files';
import { forkDesign } from '../design-fork';
import { designFolderOf, designStateDirOf, forkDesignId } from '../design-paths';
import { readDesignLink, updateDesignLink } from '../design-state';
import { clearDesigns } from './design-harness';

const DESIGN = 'contacts-abcd1234';
const FOLDER = designFolderOf(DESIGN);
const role: DesignRole = { designId: DESIGN, folder: FOLDER, parentSessionId: 'parent-1', ruleSet: 'full', title: 'Contacts' };

function write(rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(FOLDER, rel)), { recursive: true });
  fs.writeFileSync(path.join(FOLDER, rel), content);
}

function contents(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) out[path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/')] = fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8');
  }
  return out;
}

/** The design folder's checkpoint of a turn that edits `design.md` and adds a screen; its before-commit is the fork point. */
async function forkPoint(): Promise<string> {
  const sessionFile = path.join(os.tmpdir(), `design-fork-${process.pid}.jsonl`);
  fs.writeFileSync(sessionFile, '');
  const producer = new AutoCheckpointProducer({ sessionId: 'design-1', sessionFile, cwd: FOLDER, capturesTracked: false, maxFileSizeBytes: () => 25 * 1024 * 1024, createTurnId: () => 'turn', now: () => new Date() });
  const started = await producer.turnStart({ userEntryId: 'u2', prompt: 'p' });
  if (!started.ok) throw new Error(started.message);
  write('design.md', '# After the fork point\n');
  write('screens/S2.html', '<html></html>\n');
  const finalized = await producer.finalizeRun();
  producer.dispose();
  if (!finalized.ok || finalized.record?.kind !== 'checkpoint') throw new Error('no checkpoint');
  return finalized.record.beforeCommit;
}

beforeEach(() => {
  clearDesigns();
  write('manifest.json', JSON.stringify({ schemaVersion: 1, designId: DESIGN, plan: '/plans/p.md', fidelity: 'static', status: 'finished', version: 2, screens: [], updatedAt: '2026-01-01T00:00:00.000Z' }));
  write('design.md', '# At the fork point\n');
  write('screens/S1.html', '<html data-ds-screen="S1"></html>\n');
});
afterEach(() => fs.rmSync(getFolderRepoDir(folderIdFor(FOLDER)), { recursive: true, force: true }));

describe('Fork from here in a design chat (PD-36)', { timeout: 60_000 }, () => {
  it('makes <designId>-f<id8> from the fork point\'s checkpoint, with its own unlinked state folder, and leaves the original alone', async () => {
    await updateDesignLink(designStateDirOf(DESIGN), () => ({ schemaVersion: 1, designId: DESIGN, folder: FOLDER, title: 'Contacts', parentSessionId: 'parent-1', designSessionId: 'design-1', superseded: [] }));
    const commit = await forkPoint();
    const originalFiles = contents(FOLDER);

    const fork = await forkDesign(role, 'fork-session-1', { kind: 'checkpoint', handle: folderRepoFor(FOLDER, false), commit });

    expect(fork.designId).toBe(forkDesignId(DESIGN, 'fork-session-1'));
    expect(fork.designId).toMatch(/^contacts-abcd1234-f[0-9a-f]{8}$/);
    expect(fork).toEqual({ designId: fork.designId, folder: designFolderOf(fork.designId), parentSessionId: null, ruleSet: 'full', title: 'Contacts' });
    const { 'manifest.json': manifest, ...files } = contents(fork.folder);
    expect(files).toEqual({ 'design.md': '# At the fork point\n', 'screens/S1.html': '<html data-ds-screen="S1"></html>\n' });
    expect(await readManifest(fork.folder, fork.designId)).toMatchObject({ designId: fork.designId, plan: null, fidelity: 'static', status: 'draft', version: null });
    expect(JSON.parse(manifest!)).toMatchObject({ designId: fork.designId });
    expect(await readDesignLink(designStateDirOf(fork.designId))).toEqual({
      schemaVersion: 1, designId: fork.designId, folder: fork.folder, title: 'Contacts', parentSessionId: null, designSessionId: 'fork-session-1', superseded: [],
    });
    expect(contents(FOLDER)).toEqual(originalFiles);
    expect(await readDesignLink(designStateDirOf(DESIGN))).toMatchObject({ parentSessionId: 'parent-1', designSessionId: 'design-1', superseded: [] });
  });

  it('copies the files as they are now when the fork point has no checkpoint', async () => {
    const fork = await forkDesign(role, 'fork-session-2', { kind: 'copy' });
    const { 'manifest.json': _forkManifest, ...forkFiles } = contents(fork.folder);
    const { 'manifest.json': _manifest, ...files } = contents(FOLDER);
    expect(forkFiles).toEqual(files);
    expect(await readManifest(fork.folder, fork.designId)).toMatchObject({ designId: fork.designId, status: 'draft' });
  });

  it('refuses a design id that is not one safe path segment before creating anything (PD-23)', async () => {
    await expect(forkDesign({ ...role, designId: '../escape' }, 'fork-session-0', { kind: 'copy' })).rejects.toThrow(/Not a design id/);
    expect(fs.readdirSync(path.dirname(FOLDER)).sort()).toEqual([DESIGN]);
  });

  it('removes the folder it made when the state folder cannot be written, and never touches a folder that exists', async () => {
    const designId = forkDesignId(DESIGN, 'fork-session-3');
    await updateDesignLink(designStateDirOf(designId), () => ({ schemaVersion: 1, designId, folder: designFolderOf(designId), title: 'x', parentSessionId: null, designSessionId: 'someone', superseded: [] }));
    await expect(forkDesign(role, 'fork-session-3', { kind: 'copy' })).rejects.toThrow(/already has a link/);
    expect(fs.existsSync(designFolderOf(designId))).toBe(false);

    const taken = forkDesignId(DESIGN, 'fork-session-4');
    fs.mkdirSync(designFolderOf(taken));
    fs.writeFileSync(path.join(designFolderOf(taken), 'mine.txt'), 'user data');
    await expect(forkDesign(role, 'fork-session-4', { kind: 'copy' })).rejects.toThrow(/already exists/);
    expect(contents(designFolderOf(taken))).toEqual({ 'mine.txt': 'user data' });
  });
});
