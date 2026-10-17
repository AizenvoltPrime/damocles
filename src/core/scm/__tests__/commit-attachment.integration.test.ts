import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_COMMIT_ATTACHMENT_CHARS, MAX_COMMIT_ATTACHMENT_LINES, MAX_COMMIT_LABEL_CHARS } from '../../../shared/types/chat-attachment';
import { readCommitAttachment } from '../commit-attachment';
import { createGitRunner, GitUntrustedError, parseGitVersion } from '../git-runner';
import { MAX_MESSAGE_CHARS, Repository } from '../repository';
import { folder, git, GIT_PATH, harness, HAS_GIT, makeRepo, ready, sandbox, statusOf, useGitSandbox, waitFor, write } from './git-harness';

/** The Graph's Add to Chat reads a commit through the trust-gated repository into a bounded, escaped attachment. */
useGitSandbox();

function commit(repo: string, file: string, text: string, ...message: string[]): string {
  write(path.join(repo, file), text);
  git(['-c', 'core.autocrlf=false', 'add', '.'], repo);
  git(['commit', '--quiet', ...message.flatMap((paragraph) => ['-m', paragraph])], repo);
  return git(['rev-parse', 'HEAD'], repo).trim();
}

async function open(project: string) {
  const h = harness({ trusted: [project] });
  h.service.setProjects([{ key: 'p', path: project }]);
  const repoId = (await ready(h)).repos[0]!.repoId;
  await waitFor(() => statusOf(h, repoId), 'a first status');
  return { h, repoId };
}

describe.skipIf(!HAS_GIT)('a commit attachment', { timeout: 120_000 }, () => {
  it('lays out the header, the message, the stat and the patch against the first parent, with the subject and author apart', async () => {
    const repo = makeRepo(folder('attach'));
    const hash = commit(repo, 'b.txt', 'one\ntwo\n', 'Add b', 'It explains\nthe change.');
    const { h, repoId } = await open(repo);
    const attachment = await h.service.commitAttachment(repoId, hash);
    expect(attachment).toMatchObject({ kind: 'commit', hash, subject: 'Add b', author: 'Damocles Tests', omittedLines: 0 });
    expect(attachment.omittedAtLeast).toBeUndefined();
    const lines = attachment.text.split('\n');
    expect(lines.slice(0, 7)).toEqual([`commit ${hash}`, 'Author: Damocles Tests <tests@damocles.invalid>', expect.stringMatching(/^Date: {3}\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/), '', '    Add b', '', '    It explains']);
    expect(attachment.text).toContain(' b.txt | 2 ++');
    expect(attachment.text).toContain('diff --git a/b.txt b/b.txt');
    expect(attachment.text).toContain('+two');
    h.service.dispose();
  });

  it('diffs a root commit against the empty tree, and a merge against its first parent only', async () => {
    const repo = makeRepo(folder('merge'));
    const root = git(['rev-parse', 'HEAD'], repo).trim();
    git(['checkout', '--quiet', '-b', 'side'], repo);
    commit(repo, 'side.txt', 'from side\n', 'Side work');
    git(['checkout', '--quiet', 'main'], repo);
    const first = commit(repo, 'main.txt', 'from main\n', 'Main work');
    git(['merge', '--quiet', '--no-ff', '-m', 'Merge side', 'side'], repo);
    const merge = git(['rev-parse', 'HEAD'], repo).trim();
    const second = git(['rev-parse', 'side'], repo).trim();
    const { h, repoId } = await open(repo);

    const rootAttachment = await h.service.commitAttachment(repoId, root);
    expect(rootAttachment.text).toContain('new file mode 100644');
    expect(rootAttachment.text).toContain('--- /dev/null');
    expect(rootAttachment.text).toContain('+one');
    expect(rootAttachment.text).not.toContain('Merge:');

    const mergeAttachment = await h.service.commitAttachment(repoId, merge);
    expect(mergeAttachment.text.split('\n')[1]).toBe(`Merge: ${first} ${second}`);
    expect(mergeAttachment.text).toContain('diff --git a/side.txt b/side.txt');
    // the first parent already holds main.txt, so the merge brought only side.txt into it
    expect(mergeAttachment.text).not.toContain('main.txt');
    h.service.dispose();
  });

  it('keeps the start within the line and character bounds and counts every line it leaves out', async () => {
    const repo = makeRepo(folder('bounds'));
    const total = MAX_COMMIT_ATTACHMENT_LINES + 1000;
    const hash = commit(repo, 'many.txt', Array.from({ length: total }, (_, i) => `line ${i}`).join('\n') + '\n', 'Many lines');
    const wide = commit(repo, 'wide.txt', Array.from({ length: 200 }, (_, i) => `${i} ${'x'.repeat(997)}`).join('\n') + '\n', 'Wide lines');
    const { h, repoId } = await open(repo);

    const many = await h.service.commitAttachment(repoId, hash);
    const kept = many.text.split('\n');
    expect(kept).toHaveLength(MAX_COMMIT_ATTACHMENT_LINES);
    expect(kept[0]).toBe(`commit ${hash}`);
    // what git prints for the commit, the header lines included, is exactly what was kept plus what was left out
    const header = kept.findIndex((line) => line.startsWith(' many.txt |'));
    const printed = git(['-c', 'core.quotePath=false', 'diff', '--no-color', '--stat=120', '--patch', '--find-renames', `${hash}~1`, hash, '--'], repo).replace(/\n$/, '').split('\n').length;
    expect(many.omittedLines).toBe(header + printed - MAX_COMMIT_ATTACHMENT_LINES);
    expect(many.omittedAtLeast).toBeUndefined();

    const wideRead = await h.service.commitAttachment(repoId, wide);
    expect(wideRead.text.length).toBeLessThanOrEqual(MAX_COMMIT_ATTACHMENT_CHARS);
    expect(wideRead.text.split('\n').length).toBeLessThan(MAX_COMMIT_ATTACHMENT_LINES);
    expect(wideRead.omittedLines).toBeGreaterThan(0);
    h.service.dispose();
  });

  it('escapes control and bidirectional characters in the message, the author and the diff, and reads a CRLF file\'s lines without their CR', async () => {
    const repo = makeRepo(folder('escape'));
    git(['config', 'user.name', 'Eve \u202Emit'], repo);
    const hash = commit(repo, 'crlf.txt', 'first\r\nred \u001b[31mtext\r\n\u2066hidden\u2069\r\n', 'Fix \u202Egnp.exe', 'Body \u0007bell');
    const { h, repoId } = await open(repo);
    const attachment = await h.service.commitAttachment(repoId, hash);
    expect(attachment.subject).toBe('Fix \\u{202E}gnp.exe');
    expect(attachment.author).toBe('Eve \\u{202E}mit');
    expect(attachment.text).toContain('    Body \\u{7}bell');
    expect(attachment.text).toContain('+red \\u{1B}[31mtext');
    expect(attachment.text).toContain('+\\u{2066}hidden\\u{2069}');
    expect(attachment.text).toContain('+first\n');
    // eslint-disable-next-line no-control-regex
    expect(attachment.text).not.toMatch(/[\r\u0007\u001b\u202e\u2066\u2069]/);
    h.service.dispose();
  });

  it('shows the commit\'s own patch, never what a textconv driver makes of it', async () => {
    const repo = makeRepo(folder('textconv'));
    write(path.join(repo, '.gitattributes'), '*.txt diff=shout\n');
    git(['config', 'diff.shout.textconv', 'echo CONVERTED'], repo);
    const hash = commit(repo, 'b.txt', 'one\ntwo\n', 'Add b');
    const { h, repoId } = await open(repo);
    const attachment = await h.service.commitAttachment(repoId, hash);
    expect(attachment.text).toContain('+two');
    expect(attachment.text).not.toContain('CONVERTED');
    h.service.dispose();
  });

  it('cuts a long subject before an escape rather than inside it, and counts lines left out of a cut message as a floor', async () => {
    const repo = makeRepo(folder('cuts'));
    const subject = `${'x'.repeat(MAX_COMMIT_LABEL_CHARS - 5)}\u202Etail`;
    write(path.join(repo, 'b.txt'), 'one\n');
    // a message past MAX_MESSAGE_CHARS, given as a file since a command line cannot hold it
    const message = path.join(folder('cuts-message'), 'message.txt');
    write(message, `${subject}\n\n${'y'.repeat(MAX_MESSAGE_CHARS)}\n`);
    git(['add', '.'], repo);
    git(['commit', '--quiet', '--cleanup=verbatim', '-F', message], repo);
    const hash = git(['rev-parse', 'HEAD'], repo).trim();
    const { h, repoId } = await open(repo);
    const attachment = await h.service.commitAttachment(repoId, hash);
    expect(attachment.subject).toBe(`${'x'.repeat(MAX_COMMIT_LABEL_CHARS - 5)}…`);
    expect(attachment.omittedAtLeast).toBe(true);
    h.service.dispose();
  });

  it('runs no git in an untrusted project', async () => {
    const repo = makeRepo(folder('untrusted'));
    const hash = git(['rev-parse', 'HEAD'], repo).trim();
    const log: string[] = [];
    const runner = createGitRunner({ git: { path: GIT_PATH!, version: parseGitVersion(git(['--version'], sandbox))! }, log: { appendLine: (line) => log.push(line) }, isTrusted: () => false });
    const repository = new Repository({ root: repo, gitDir: path.join(repo, '.git'), commonDir: path.join(repo, '.git'), kind: 'root', project: repo }, runner);
    await expect(readCommitAttachment(repository, hash)).rejects.toBeInstanceOf(GitUntrustedError);
    expect(log).toEqual([]);
    repository.dispose();
  });
});
