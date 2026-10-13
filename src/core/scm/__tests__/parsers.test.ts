import { describe, expect, it } from 'vitest';
import { GitStatusParser, parseGitmodules, parseUnsafeRepository, stripCommitMessageComments } from '../parsers';
import { MAX_CLI_LENGTH, splitInChunks } from '../git-runner';

// Fixtures ported from VS Code's extensions/git/src/test/git.test.ts (MIT).
describe('GitStatusParser', () => {
  const files = [{ x: '?', y: '?', path: 'file.txt' }, { x: '?', y: '?', path: 'file2.txt' }, { x: '?', y: '?', path: 'file3.txt' }];

  it('empty parser', () => {
    expect(new GitStatusParser().status).toEqual([]);
    const parser = new GitStatusParser();
    parser.update('');
    expect(parser.status).toEqual([]);
  });

  it('simple', () => {
    const parser = new GitStatusParser();
    parser.update('?? file.txt\0');
    expect(parser.status).toEqual([{ x: '?', y: '?', path: 'file.txt' }]);
  });

  it('simple 2', () => {
    const parser = new GitStatusParser();
    parser.update('?? file.txt\0');
    parser.update('?? file2.txt\0');
    parser.update('?? file3.txt\0');
    expect(parser.status).toEqual(files);
  });

  it('empty lines', () => {
    const parser = new GitStatusParser();
    for (const chunk of ['', '?? file.txt\0', '', '', '?? file2.txt\0', '', '?? file3.txt\0', '']) parser.update(chunk);
    expect(parser.status).toEqual(files);
  });

  it('combined', () => {
    const parser = new GitStatusParser();
    parser.update('?? file.txt\0?? file2.txt\0?? file3.txt\0');
    expect(parser.status).toEqual(files);
  });

  it.each([
    ['split 1', ['?? file.txt\0?? file2', '.txt\0?? file3.txt\0']],
    ['split 2', ['?? file.txt', '\0?? file2.txt\0?? file3.txt\0']],
    ['split 3', ['?? file.txt\0?? file2.txt\0?? file3.txt', '\0']],
  ])('%s', (_name, chunks) => {
    const parser = new GitStatusParser();
    for (const chunk of chunks) parser.update(chunk);
    expect(parser.status).toEqual(files);
  });

  it('rename', () => {
    const parser = new GitStatusParser();
    parser.update('R  newfile.txt\0file.txt\0?? file2.txt\0?? file3.txt\0');
    expect(parser.status).toEqual([{ x: 'R', y: ' ', path: 'file.txt', rename: 'newfile.txt' }, files[1], files[2]]);
  });

  it('rename split', () => {
    const parser = new GitStatusParser();
    parser.update('R  newfile.txt\0fil');
    parser.update('e.txt\0?? file2.txt\0?? file3.txt\0');
    expect(parser.status).toEqual([{ x: 'R', y: ' ', path: 'file.txt', rename: 'newfile.txt' }, files[1], files[2]]);
  });

  it('rename split 3', () => {
    const parser = new GitStatusParser();
    parser.update('?? file2.txt\0R  new');
    parser.update('file.txt\0fil');
    parser.update('e.txt\0?? file3.txt\0');
    expect(parser.status).toEqual([files[1], { x: 'R', y: ' ', path: 'file.txt', rename: 'newfile.txt' }, files[2]]);
  });

  it('drops a nested repository, which status lists with a trailing slash', () => {
    const parser = new GitStatusParser();
    parser.update('?? nested/\0?? file.txt\0');
    expect(parser.status).toEqual([files[0]]);
  });
});

describe('parseGitmodules', () => {
  it('empty', () => {
    expect(parseGitmodules('')).toEqual([]);
  });

  it('sample', () => {
    const sample = '[submodule "deps/spdlog"]\n\tpath = deps/spdlog\n\turl = https://github.com/gabime/spdlog.git\n';
    expect(parseGitmodules(sample)).toEqual([{ name: 'deps/spdlog', path: 'deps/spdlog', url: 'https://github.com/gabime/spdlog.git' }]);
  });

  it('big', () => {
    const sample = [1, 2, 3, 4]
      .map((n) => `[submodule "deps/spdlog${n === 1 ? '' : n}"]\n\tpath = deps/spdlog${n === 1 ? '' : n}\n\turl = https://github.com/gabime/spdlog${n === 4 ? '4' : ''}.git\n`)
      .join('');
    expect(parseGitmodules(sample)).toEqual([
      { name: 'deps/spdlog', path: 'deps/spdlog', url: 'https://github.com/gabime/spdlog.git' },
      { name: 'deps/spdlog2', path: 'deps/spdlog2', url: 'https://github.com/gabime/spdlog.git' },
      { name: 'deps/spdlog3', path: 'deps/spdlog3', url: 'https://github.com/gabime/spdlog.git' },
      { name: 'deps/spdlog4', path: 'deps/spdlog4', url: 'https://github.com/gabime/spdlog4.git' },
    ]);
  });

  it('whitespace #74844', () => {
    const sample = '[submodule "deps/spdlog"]\n\tpath = deps/spdlog\n\turl  = https://github.com/gabime/spdlog.git\n';
    expect(parseGitmodules(sample)).toEqual([{ name: 'deps/spdlog', path: 'deps/spdlog', url: 'https://github.com/gabime/spdlog.git' }]);
  });

  it('whitespace again #108371', () => {
    const sample = '[submodule "deps/spdlog"]\n\tpath= deps/spdlog\n\turl=https://github.com/gabime/spdlog.git\n';
    expect(parseGitmodules(sample)).toEqual([{ name: 'deps/spdlog', path: 'deps/spdlog', url: 'https://github.com/gabime/spdlog.git' }]);
  });
});

describe('splitInChunks', () => {
  // each path costs its length plus 3: the separating space and Windows' quotes around a path with a space
  it('counts each path with its separator and quotes', () => {
    const words = ['hello', 'there', 'cool', 'stuff'];
    expect([...splitInChunks(words, 6)]).toEqual([['hello'], ['there'], ['cool'], ['stuff']]);
    expect([...splitInChunks(words, 15)]).toEqual([['hello'], ['there', 'cool'], ['stuff']]);
    expect([...splitInChunks(words, 16)]).toEqual([['hello', 'there'], ['cool', 'stuff']]);
    expect([...splitInChunks(words, 23)]).toEqual([['hello', 'there', 'cool'], ['stuff']]);
    expect([...splitInChunks(words, 2000)]).toEqual([words]);
    const digits = ['0', '01', '012', '0', '01', '012', '0', '01', '012'];
    expect([...splitInChunks(digits, 1)]).toEqual(digits.map((digit) => [digit]));
    expect([...splitInChunks(digits, 9)]).toEqual([['0', '01'], ['012'], ['0', '01'], ['012'], ['0', '01'], ['012']]);
  });

  it('keeps every chunk of many short paths under the Windows command line, quotes and separators included', () => {
    const paths = Array.from({ length: 3_000 }, (_, index) => `d ${String(index).padStart(7, '0')}`);
    const chunks = [...splitInChunks(paths, MAX_CLI_LENGTH)];
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.map((entry) => `"${entry}"`).join(' ').length).toBeLessThanOrEqual(MAX_CLI_LENGTH);
  });
});

describe('parseUnsafeRepository', () => {
  it('reads the path git suggests for safe.directory', () => {
    const stderr = "fatal: detected dubious ownership in repository at 'C:/work/repo'\n'C:/work/repo' is owned by:\n\tBUILTIN/Administrators\nbut the current user is:\n\tme\nTo add an exception for this directory, call:\n\n\tgit config --global --add safe.directory C:/work/repo\n";
    expect(parseUnsafeRepository(stderr)).toBe('C:/work/repo');
  });

  it('is undefined for any other failure', () => {
    expect(parseUnsafeRepository('fatal: not a git repository (or any of the parent directories): .git\n')).toBeUndefined();
  });
});

describe('stripCommitMessageComments', () => {
  it('drops git comment lines and trims', () => {
    expect(stripCommitMessageComments("Merge branch 'feature'\n\n# Conflicts:\n#\ta.txt\n")).toBe("Merge branch 'feature'");
  });
});
