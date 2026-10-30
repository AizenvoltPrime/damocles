import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../__mocks__/source-tree';
import { renderLocalizedText } from '../../../shared/localized-text';
import { markerNames, mergeWithMarkers } from '../../../shared/scm/merge-markers';
import type { MergeLabel } from '../merge';
import type { TextCodec } from '../staging';
import { folder, freshStatus, git, harness, HAS_GIT, makeRepo, ready, statusOf, useGitSandbox, waitFor, write, type Harness } from './git-harness';

/** The editor's git reads against real git: blame over HEAD, the timeline through a rename, and the merge editor's inputs. */
useGitSandbox();

const UTF8: TextCodec = { encoding: 'utf8', bom: false };
const commit = (dir: string, message: string): void => {
  git(['add', '-A'], dir);
  git(['commit', '--quiet', '-m', message], dir);
};

async function open(dir: string): Promise<{ h: Harness; repoId: string }> {
  const h = harness({ trusted: [dir] });
  h.service.setProjects([{ key: 'p', path: dir }]);
  const repoId = (await ready(h)).repos[0]!.repoId;
  await waitFor(() => statusOf(h, repoId), 'a first status');
  return { h, repoId };
}

// main and side both change line 2 of c.txt from the same base.
function conflicted(name: string): string {
  const dir = makeRepo(folder(name));
  write(path.join(dir, 'c.txt'), 'one\ntwo\nthree\n');
  commit(dir, 'base');
  git(['checkout', '--quiet', '-b', 'side'], dir);
  write(path.join(dir, 'c.txt'), 'one\nside\nthree\n');
  commit(dir, 'side change');
  git(['checkout', '--quiet', 'main'], dir);
  write(path.join(dir, 'c.txt'), 'one\nmain\nthree\n');
  commit(dir, 'main change');
  return dir;
}

describe.skipIf(!HAS_GIT)('editor git reads', { timeout: 180_000 }, () => {
  it('blames HEAD\'s lines and reuses the blame while HEAD stays', async () => {
    const dir = makeRepo(folder('blame'));
    write(path.join(dir, 'b.txt'), 'first\nsecond\n');
    commit(dir, 'add b');
    write(path.join(dir, 'b.txt'), 'first\nchanged\n');
    commit(dir, 'change b');
    const { h, repoId } = await open(dir);
    const read = await h.service.blame(repoId, 'b.txt');
    if (!read.ok) throw new Error('no blame');
    expect(read.blame.head).toBe(git(['rev-parse', 'HEAD'], dir).trim());
    expect(read.blame.lines.map((index) => read.blame.commits[index]!.summary)).toEqual(['add b', 'change b']);
    expect(read.blame.commits[0]!.author).toBe('Damocles Tests');
    const again = await h.service.blame(repoId, 'b.txt');
    expect(again.ok && again.blame).toBe(read.blame);
    expect(await h.service.blame(repoId, 'missing.txt')).toEqual({ ok: false, reason: 'notCommitted' });
    h.service.dispose();
  });

  it('blames a staged rename at HEAD\'s source path', async () => {
    const dir = makeRepo(folder('blame-rename'));
    write(path.join(dir, 'old.txt'), 'first\nsecond\n');
    commit(dir, 'add old');
    git(['mv', 'old.txt', 'new.txt'], dir);
    const { h, repoId } = await open(dir);
    await freshStatus(h, repoId);
    const read = await h.service.blame(repoId, 'new.txt');
    if (!read.ok) throw new Error(`no blame: ${read.reason}`);
    expect(read.blame.lines.map((index) => read.blame.commits[index]!.summary)).toEqual(['add old', 'add old']);
    h.service.dispose();
  });

  it('blames nothing in a UTF-16 file, whose 0x0A bytes inside characters git would split lines at', async () => {
    const dir = makeRepo(folder('blame-utf16'));
    fs.writeFileSync(path.join(dir, 'w.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('上一\r\n二\r\n', 'utf16le')]));
    commit(dir, 'utf-16');
    const { h, repoId } = await open(dir);
    expect(await h.service.blame(repoId, 'w.txt')).toEqual({ ok: false, reason: 'binary' });
    h.service.dispose();
  });

  it('names a timeline entry\'s author through .mailmap, as blame does', async () => {
    const dir = makeRepo(folder('timeline-mailmap'));
    write(path.join(dir, 'm.txt'), 'x\n');
    git(['add', '-A'], dir);
    git(['-c', 'user.name=Old Name', '-c', 'user.email=old@damocles.invalid', 'commit', '--quiet', '-m', 'by the old name'], dir);
    write(path.join(dir, '.mailmap'), 'New Name <new@damocles.invalid> Old Name <old@damocles.invalid>\n');
    commit(dir, 'mailmap');
    const { h, repoId } = await open(dir);
    const page = await h.service.timeline(repoId, 'm.txt');
    expect(page.entries.map((entry) => [entry.author, entry.email])).toEqual([['New Name', 'new@damocles.invalid']]);
    h.service.dispose();
  });

  it('pages the timeline 50 at a time through a rename, each entry at its path then', async () => {
    const dir = makeRepo(folder('timeline'));
    for (let index = 0; index < 52; index++) {
      write(path.join(dir, 'old.txt'), `version ${index}\n`);
      commit(dir, `old ${index}`);
    }
    git(['mv', 'old.txt', 'new.txt'], dir);
    commit(dir, 'rename');
    write(path.join(dir, 'new.txt'), 'renamed and changed\n');
    commit(dir, 'after rename');
    const { h, repoId } = await open(dir);
    const first = await h.service.timeline(repoId, 'new.txt');
    expect(first.entries).toHaveLength(50);
    expect(first.next).toEqual({ hash: first.entries[49]!.hash, path: 'old.txt' });
    expect(first.entries.slice(0, 3).map((entry) => [entry.subject, entry.path])).toEqual([['after rename', 'new.txt'], ['rename', 'new.txt'], ['old 51', 'old.txt']]);
    const second = await h.service.timeline(repoId, 'new.txt', first.next);
    expect(second.next).toBeUndefined();
    expect(second.entries.map((entry) => entry.subject)).toEqual(['old 3', 'old 2', 'old 1', 'old 0']);
    expect(second.entries.every((entry) => entry.path === 'old.txt')).toBe(true);
    const logged = git(['log', '--follow', '--format=%H', '--', 'new.txt'], dir).trim().split('\n');
    expect([...first.entries, ...second.entries].map((entry) => entry.hash)).toEqual(logged);
    write(path.join(dir, 'fresh.txt'), 'x\n');
    expect((await h.service.timeline(repoId, 'fresh.txt')).entries).toEqual([]);
    h.service.dispose();
  });

  it('reads a merge conflict\'s three stages with the branches\' labels, and merges them with git (diff3)', async () => {
    const dir = conflicted('merge');
    expect(() => git(['merge', '--quiet', 'side'], dir)).toThrow();
    const { h, repoId } = await open(dir);
    await freshStatus(h, repoId);
    const fileText = fs.readFileSync(path.join(dir, 'c.txt'), 'utf8');
    const inputs = await h.service.mergeInputs(repoId, 'c.txt', UTF8, fileText);
    if (!inputs.ok) throw new Error(`no inputs: ${inputs.reason}`);
    expect(inputs.operation).toBe('merge');
    expect([inputs.base, inputs.current, inputs.incoming]).toEqual(['one\ntwo\nthree\n', 'one\nmain\nthree\n', 'one\nside\nthree\n']);
    expect(inputs.labels.current).toMatchObject({ title: { message: 'Current' }, detail: 'main' });
    expect(inputs.labels.incoming).toMatchObject({ title: { message: 'Incoming' }, detail: 'side' });
    const merged = await h.service.mergeFile(repoId, 'c.txt', UTF8, true, fileText);
    if (!merged.ok) throw new Error('no merge');
    // labelled with the branch names, as git's merge and Reset Result write them
    expect(merged.text).toBe('one\n<<<<<<< main\nmain\n||||||| Base\ntwo\n=======\nside\n>>>>>>> side\nthree\n');
    const plain = await h.service.mergeFile(repoId, 'c.txt', UTF8, false, fileText);
    expect(plain).toEqual({ ok: true, text: 'one\n<<<<<<< main\nmain\n=======\nside\n>>>>>>> side\nthree\n' });
    h.service.dispose();
  });

  it('names Reset Result\'s markers as git\'s merge names them while main shows the titles in another language', async () => {
    const dir = makeRepo(folder('stash-markers'));
    write(path.join(dir, 'c.txt'), 'one\ntwo\nthree\n');
    commit(dir, 'base');
    write(path.join(dir, 'c.txt'), 'one\nstashed\nthree\n');
    git(['stash', '--quiet'], dir);
    write(path.join(dir, 'c.txt'), 'one\nmain\nthree\n');
    commit(dir, 'main change');
    expect(() => git(['stash', 'apply', '--quiet'], dir)).toThrow();
    const { h, repoId } = await open(dir);
    await freshStatus(h, repoId);
    const fileText = fs.readFileSync(path.join(dir, 'c.txt'), 'utf8');
    const inputs = await h.service.mergeInputs(repoId, 'c.txt', UTF8, fileText);
    if (!inputs.ok) throw new Error(`no inputs: ${inputs.reason}`);
    expect(inputs.operation).toBe('stash');
    // main gives the shell each title in its own language (ScmHost.mergeInputs)
    const greek = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'l10n', 'bundle.l10n.el.json'), 'utf8')) as Record<string, string>;
    const shown = (label: MergeLabel) => ({ ...label, title: renderLocalizedText(label.title, (key) => greek[key], 'el') });
    const labels = { current: shown(inputs.labels.current), incoming: shown(inputs.labels.incoming), base: shown(inputs.labels.base) };
    expect(labels.incoming.title).toBe('Αλλαγές στο stash');
    const reset = mergeWithMarkers(inputs.base, inputs.current, inputs.incoming, markerNames(labels), '\n');
    expect(await h.service.mergeFile(repoId, 'c.txt', UTF8, false, fileText)).toEqual({ ok: true, text: reset });
    expect(reset).toBe('one\n<<<<<<< main\nmain\n=======\nstashed\n>>>>>>> Stashed Changes\nthree\n');
    h.service.dispose();
  });

  it('computes conflicts with the marker size the file\'s conflict-marker-size attribute gives', async () => {
    const dir = conflicted('marker-size');
    write(path.join(dir, '.gitattributes'), 'c.txt conflict-marker-size=9\n');
    commit(dir, 'marker size');
    expect(() => git(['merge', '--quiet', 'side'], dir)).toThrow();
    const fileText = fs.readFileSync(path.join(dir, 'c.txt'), 'utf8');
    expect(fileText).toContain('<<<<<<<<< ');
    const { h, repoId } = await open(dir);
    await freshStatus(h, repoId);
    expect(await h.service.mergeFile(repoId, 'c.txt', UTF8, false, fileText)).toEqual({ ok: true, text: 'one\n<<<<<<<<< main\nmain\n=========\nside\n>>>>>>>>> side\nthree\n' });
    h.service.dispose();
  });

  it('names the branch rebased onto as Current and REBASE_HEAD as Incoming during a rebase, after replayed commits too', async () => {
    const dir = conflicted('rebase');
    git(['checkout', '--quiet', 'side'], dir);
    // a first commit that replays cleanly moves HEAD past main's tip before the conflict
    git(['checkout', '--quiet', 'side~1'], dir);
    git(['checkout', '--quiet', '-b', 'side2'], dir);
    write(path.join(dir, 'clean.txt'), 'clean\n');
    commit(dir, 'clean change');
    git(['cherry-pick', 'side'], dir);
    git(['branch', '--force', 'side', 'side2'], dir);
    git(['checkout', '--quiet', 'side'], dir);
    expect(() => git(['rebase', '--quiet', 'main'], dir)).toThrow();
    const { h, repoId } = await open(dir);
    await freshStatus(h, repoId);
    const inputs = await h.service.mergeInputs(repoId, 'c.txt', UTF8, fs.readFileSync(path.join(dir, 'c.txt'), 'utf8'));
    if (!inputs.ok) throw new Error(`no inputs: ${inputs.reason}`);
    expect(inputs.operation).toBe('rebase');
    expect(inputs.current).toBe('one\nmain\nthree\n');
    expect(inputs.incoming).toBe('one\nside\nthree\n');
    expect(inputs.labels.current.detail).toBe('main');
    expect(inputs.labels.incoming.description).toBe(git(['rev-parse', '--short=7', 'REBASE_HEAD'], dir).trim());
    h.service.dispose();
  });
});
