import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EDITOR_MAX_DOCUMENT_BYTES } from '../../../../shared/types/messages';
import { gitExecutable } from '../../../git-executable';
import { readDiskText } from '../../chat-review';
import { checkpointCommitFile } from '../rewind';

/** A checkpoint blob is read within the editor's bound, and is binary by git's test: a NUL among its first 8000 bytes. */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function repoWith(files: Record<string, Buffer | string>): { repoDir: string; commit: string } {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dam-checkpoint-file-'));
  dirs.push(repoDir);
  const git = (...args: string[]): string => execFileSync(gitExecutable(), ['-c', 'core.autocrlf=false', ...args], { cwd: repoDir, encoding: 'utf8' });
  git('init', '--quiet');
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(repoDir, name), content);
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t.invalid', 'commit', '--quiet', '-m', 'snapshot');
  return { repoDir, commit: git('rev-parse', 'HEAD').trim() };
}

describe('checkpointCommitFile', () => {
  it('reads a NUL past the first 8000 bytes as text, and one among them as binary with the bytes\' digest', async () => {
    const late = Buffer.concat([Buffer.from('a'.repeat(9000)), Buffer.from([0]), Buffer.from('tail\n')]);
    const early = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    const { repoDir, commit } = repoWith({ 'late.txt': late, 'image.png': early });
    expect(await checkpointCommitFile(repoDir, commit, 'late.txt')).toEqual({ kind: 'text', text: late.toString('utf8') });
    const binary = await checkpointCommitFile(repoDir, commit, 'image.png');
    expect(binary).toMatchObject({ kind: 'binary', digest: expect.stringMatching(/^[0-9a-f]{40}$/) });
    // the review drops a binary file whose disk digest equals the checkpoint's, so both read the same bytes the same way
    expect(await readDiskText(path.join(repoDir, 'image.png'))).toEqual(binary);
    expect(await checkpointCommitFile(repoDir, commit, 'missing.txt')).toEqual({ kind: 'absent' });
  });

  it('stops reading a blob past the editor\'s bound and calls it too large', async () => {
    const { repoDir, commit } = repoWith({ 'big.txt': 'x'.repeat(EDITOR_MAX_DOCUMENT_BYTES + 1) });
    expect(await checkpointCommitFile(repoDir, commit, 'big.txt')).toEqual({ kind: 'tooLarge' });
  }, 30_000);
});
