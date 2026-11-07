import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AutoCheckpointProducer } from '../auto-checkpoint';
import { folderRepoFor } from '../folder-repo';
import { materializeCheckpoint } from '../materialize';
import { RepoManager } from '../repo-manager';
import { folderIdFor, getFolderRepoDir } from '../resolver';

let root: string;
let source: string;
let turn = 0;

function write(rel: string, content: string, workTree = source): void {
  const full = path.join(workTree, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** Every file below `dir`, relative with forward slashes, mapped to its content. */
function contents(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string, prefix: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
      else out[rel] = fs.readFileSync(path.join(current, entry.name), 'utf8');
    }
  };
  walk(dir, '');
  return out;
}

const tempIndexDirs = (): string[] => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('damocles-materialize-'));

/** A turn of a design folder chat: its before-commit holds the files as they were when the turn started. */
async function beforeCommitOf(during: () => void): Promise<string> {
  const producer = new AutoCheckpointProducer({
    sessionId: 'design-session',
    sessionFile: path.join(root, 'design-session.jsonl'),
    cwd: source,
    capturesTracked: false,
    maxFileSizeBytes: () => 25 * 1024 * 1024,
    createTurnId: () => `turn-${++turn}`,
    now: () => new Date(),
  });
  const started = await producer.turnStart({ userEntryId: `u${turn + 1}`, prompt: 'p' });
  if (!started.ok) throw new Error(started.message);
  during();
  const finalized = await producer.finalizeRun();
  if (!finalized.ok || finalized.record?.kind !== 'checkpoint') throw new Error('no checkpoint');
  producer.dispose();
  return finalized.record.beforeCommit;
}

beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cp-materialize-'));
  source = path.join(root, 'designs', 'contacts-abcd1234');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(root, 'design-session.jsonl'), '');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.promises.rm(getFolderRepoDir(folderIdFor(source)), { recursive: true, force: true });
  await fs.promises.rm(root, { recursive: true, force: true });
});

describe('materializeCheckpoint (real git)', { timeout: 60_000 }, () => {
  it('writes the commit\'s tree into a new folder, byte for byte, and leaves the source folder and the temp index alone', async () => {
    write('design.md', '# Contacts\r\n');
    write('screens/S1-contacts.html', '<html data-ds-screen="S1"></html>\n');
    const before = await beforeCommitOf(() => {
      write('screens/S1-contacts.html', '<html data-ds-screen="S1">edited</html>\n');
      write('screens/S2-detail.html', '<html data-ds-screen="S2"></html>\n');
    });
    const sourceAfter = contents(source);
    const target = path.join(root, 'designs', 'contacts-abcd1234-f00000001');
    const indexDirsBefore = tempIndexDirs();

    await materializeCheckpoint(folderRepoFor(source, false), before, target);

    expect(contents(target)).toEqual({ 'design.md': '# Contacts\r\n', 'screens/S1-contacts.html': '<html data-ds-screen="S1"></html>\n' });
    expect(contents(source)).toEqual(sourceAfter);
    expect(tempIndexDirs()).toEqual(indexDirsBefore);
    expect(fs.readdirSync(path.dirname(target)).filter((name) => name.startsWith('.'))).toEqual([]);
  });

  it('refuses a target that already exists and leaves it as it was', async () => {
    write('design.md', '# Contacts\n');
    const before = await beforeCommitOf(() => write('design.md', '# Edited\n'));
    const target = path.join(root, 'designs', 'taken');
    write('mine.txt', 'user data', target);

    await expect(materializeCheckpoint(folderRepoFor(source, false), before, target)).rejects.toThrow(/already exists/);
    expect(contents(target)).toEqual({ 'mine.txt': 'user data' });
  });

  it('leaves no target folder, no staging folder and no temp index when the checkout fails', async () => {
    write('design.md', '# Contacts\n');
    const before = await beforeCommitOf(() => write('design.md', '# Edited\n'));
    const target = path.join(root, 'designs', 'contacts-abcd1234-f00000002');
    const indexDirsBefore = tempIndexDirs();
    vi.spyOn(RepoManager.prototype, 'checkoutTreeLocked').mockImplementation(async (_commit, workTree) => {
      fs.writeFileSync(path.join(workTree, 'half.html'), 'partial');
      throw new Error('checkout-index failed');
    });

    await expect(materializeCheckpoint(folderRepoFor(source, false), before, target)).rejects.toThrow('checkout-index failed');
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(path.dirname(target)).sort()).toEqual(['contacts-abcd1234']);
    expect(tempIndexDirs()).toEqual(indexDirsBefore);
  });

  it('refuses a commit the folder repo does not hold, creating nothing', async () => {
    write('design.md', '# Contacts\n');
    await beforeCommitOf(() => undefined);
    const target = path.join(root, 'designs', 'contacts-abcd1234-f00000003');
    await expect(materializeCheckpoint(folderRepoFor(source, false), 'a'.repeat(40), target)).rejects.toThrow(/is not in folder repo/);
    expect(fs.existsSync(target)).toBe(false);
    await expect(materializeCheckpoint(folderRepoFor(source, false), 'HEAD', target)).rejects.toThrow(/not a checkpoint commit/);
  });
});
