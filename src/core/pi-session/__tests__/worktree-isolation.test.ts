import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getShellConfig } from '@earendil-works/pi-coding-agent';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nativeShellPath, worktreeIsolationBlock, WORKTREE_ISOLATION_REASON, type WorktreeIsolation } from '../worktree-isolation';
import { parseShellStructure } from '../readonly-shell';
import { runPermissionGate, type GatePermissionContext } from '../permission-gate';

let base: string;
let iso: WorktreeIsolation;
let project: string;
let worktree: string;
let outside: string;

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-iso-')));
  project = path.join(base, 'project');
  worktree = path.join(base, 'home', '.damocles', 'worktrees', 'project-abcdef', 'aaaaaaaa');
  const other = path.join(base, 'home', '.damocles', 'worktrees', 'project-abcdef', 'bbbbbbbb');
  outside = path.join(base, 'outside');
  for (const dir of [project, worktree, other, outside]) fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  const homeDir = path.join(base, 'home');
  const environment = { PATH: path.join(base, 'bin'), HOME: homeDir, TEMP: outside };
  iso = { workingFolder: worktree, projectPath: project, repositoryRoot: project, otherWorktrees: [other], homeDir, environment };
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

const bash = (command: string): string | undefined => worktreeIsolationBlock('Bash', { command }, iso);
const ps = (command: string): string | undefined => worktreeIsolationBlock('PowerShell', { command }, iso);
const q = (p: string): string => JSON.stringify(p);
/** A check whose starting environment adds `extra` to the test's own. */
const withEnvironment = (tool: 'Bash' | 'PowerShell', extra: Readonly<Record<string, string | undefined>>) => (command: string): string | undefined =>
  worktreeIsolationBlock(tool, { command }, { ...iso, environment: { ...iso.environment, ...extra } });
/** A Bash check whose tool runs `shellPath`, as pi's bash tool does when the setting names one. */
const withShell = (shellPath: string) => (command: string): string | undefined => worktreeIsolationBlock('Bash', { command }, { ...iso, shellPath });
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';
const REACHES = Symbol('reaches');
const AREA = /(?:in|at) (?:the project folder|another worktree of the project|the project's repository)\./;
/** The block names the area the command reaches; the fixed prefix names one too, so only the detail after it counts. */
const expectReaches = (result: string | undefined, command: string): void => {
  expect(result, command).toContain(WORKTREE_ISOLATION_REASON);
  expect(result!.slice(WORKTREE_ISOLATION_REASON.length), command).toMatch(AREA);
};

describe('worktree isolation (D62)', () => {
  it('blocks an Edit, Write or GenerateImage of the project folder\'s copy, and allows the worktree\'s', () => {
    for (const tool of ['Edit', 'Write', 'GenerateImage']) {
      expect(worktreeIsolationBlock(tool, { file_path: path.join(project, 'src', 'a.ts') }, iso)).toContain(WORKTREE_ISOLATION_REASON);
      expect(worktreeIsolationBlock(tool, { file_path: path.join(worktree, 'src', 'a.ts') }, iso)).toBeUndefined();
      expect(worktreeIsolationBlock(tool, { file_path: 'src/a.ts' }, iso)).toBeUndefined();
    }
    expect(worktreeIsolationBlock('Edit', { file_path: `../../../../../project/src/a.ts` }, iso)).toContain(WORKTREE_ISOLATION_REASON);
    expect(worktreeIsolationBlock('Edit', { file_path: path.join(iso.otherWorktrees[0]!, 'x') }, iso)).toContain(WORKTREE_ISOLATION_REASON);
  });

  // A junction needs no privilege on Windows; elsewhere the type is ignored and a directory symlink is made.
  it('blocks a path that resolves through a link into the project folder, and `..` taken physically through it', () => {
    const linked = path.join(worktree, 'linked');
    fs.symlinkSync(path.join(project, 'src'), linked, 'junction');
    try {
      expect(worktreeIsolationBlock('Write', { file_path: path.join(linked, 'a.ts') }, iso)).toContain(WORKTREE_ISOLATION_REASON);
      expect(bash(`cd linked && git status`)).toContain(WORKTREE_ISOLATION_REASON);
      expect(bash('git -C linked/.. status')).toContain(WORKTREE_ISOLATION_REASON);
      expect(bash('git --work-tree=linked/.. status')).toContain(WORKTREE_ISOLATION_REASON);
      expect(bash('cd -P linked/.. && git status')).toContain(WORKTREE_ISOLATION_REASON);
      expect(bash('git -C src/.. status')).toBeUndefined();
    } finally {
      fs.rmSync(linked, { force: true });
    }
  });

  // Windows environment names have no case, so git there reads `git_dir` as GIT_DIR; bash's own CDPATH keeps its case.
  it('reads a bash variable git reads without case on Windows, and with case elsewhere', () => {
    const gitDir = `git_dir=${q(path.join(project, '.git'))} git log`;
    const exported = `export Git_Work_Tree=${q(project)}; git status`;
    if (process.platform === 'win32') {
      expect(bash(gitDir)).toContain(WORKTREE_ISOLATION_REASON);
      expect(bash(exported)).toContain(WORKTREE_ISOLATION_REASON);
      expect(bash(`env git_dir=${q(path.join(project, '.git'))} git log`)).toContain(WORKTREE_ISOLATION_REASON);
      expect(bash('read git_dir; git log')).toContain('sets a variable git reads');
    } else {
      expect(bash(gitDir)).toBeUndefined();
      expect(bash(exported)).toBeUndefined();
    }
    expect(bash(`cdpath=${q(base)}; cd project && git status`)).toBeUndefined();
  });

  it('blocks git aimed at the project folder by -C, GIT_DIR, --git-dir, --work-tree and a cd', () => {
    expect(bash(`git -C ${q(project)} status`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`GIT_DIR=${q(path.join(project, '.git'))} git log`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`cd ${q(project)} && git add .`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`git --git-dir=${q(path.join(project, '.git'))} log`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`git --work-tree ${q(project)} status`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`export GIT_WORK_TREE=${q(project)}; git status`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`env GIT_DIR=${q(path.join(project, '.git'))} git log`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`git -c core.worktree=${q(project)} status`)).toContain(WORKTREE_ISOLATION_REASON);
  });

  it('allows git inside the worktree, commits included, and plain commands elsewhere', () => {
    expect(bash('git status && git add -A && git commit -m "work"')).toBeUndefined();
    expect(bash('cd src && git diff > out.txt')).toBeUndefined();
    expect(bash(`ls ${q(project)} | wc -l`)).toBeUndefined();
    expect(bash('echo "$(git rev-parse HEAD)"')).toBeUndefined();
    expect(bash(`cat <<'EOF'\ncd ${project}\nEOF\ngit status`)).toBeUndefined();
  });

  it('blocks git or cd whose target it cannot read, and a computed command name', () => {
    expect(bash('cd "$(cat f)" && git status')).toContain('computed');
    expect(bash('source ./env.sh; git -C "$DIR" status')).toContain('computed');
    expect(bash('source ./env.sh; $GIT status')).toContain('computed');
    expect(bash('$(echo git) status')).toContain('computed');
    expect(bash('source ./env.sh; export GIT_DIR=$X')).toContain('computed');
    checkWith('Bash', { PROJECT: project }, 'cd "$PROJECT" && git status', REACHES);
    expect(withEnvironment('Bash', { DIR: worktree })('git -C "$DIR" status')).toBeUndefined();
    expect(withEnvironment('Bash', { GIT: 'git' })('$GIT status')).toBeUndefined();
    checkWith('Bash', { GIT: 'git' }, '$GIT -C <QP> add .', REACHES);
    checkWith('Bash', { X: path.join(project, '.git') }, 'export GIT_DIR="$X"; git log', REACHES);
    expect(bash(`echo $(cd ${q(project)} && git log)`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`bash -c ${q(`git -C '${project}' status`)}`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`eval git -C ${q(project.split(path.sep).join('/'))} status`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`xargs git -C ${q(project)} add`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`"g""it" -C ${q(project)} status`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`/usr/bin/git -C ${q(project)} status`)).toContain(WORKTREE_ISOLATION_REASON);
  });

  it('blocks an unparsable command and a function definition', () => {
    expect(bash('git status "unterminated')).toContain('parsed');
    expect(bash('f() { git status; }; f')).toContain('parsed');
    expect(bash('cat <<EOF\nno end')).toContain('parsed');
  });

  it('names the length limit when it blocks a long Bash or PowerShell command, the command prefix included', () => {
    expect(bash(`echo ${'a'.repeat(8187)}`)).toBeUndefined();
    expect(bash(`echo ${'a'.repeat(8188)}`)).toContain('longer than 8192 characters');
    const prefixed = worktreeIsolationBlock('Bash', { command: `echo ${'a'.repeat(8170)}` }, { ...iso, commandPrefix: 'shopt -s nullglob' });
    expect(prefixed).toContain('longer than 8192 characters');
    expect(prefixed).toContain('command prefix');
    expect(ps(`echo ${'a'.repeat(8187)}`)).toBeUndefined();
    const long = ps(`echo ${'a'.repeat(8188)}`);
    expect(long).toContain('longer than 8192 characters');
    expect(long).toContain('Write tool');
  });

  // The walk recurses once per nested block, so past the limit it blocks instead of running out of stack.
  it('names the nesting limit when blocks nest deeper than the walk follows', () => {
    for (const result of [bash(`${'('.repeat(201)}echo${')'.repeat(201)}`), bash(`${'('.repeat(3000)}echo${')'.repeat(3000)}`), ps(`${'function f { '.repeat(201)}echo${' }'.repeat(201)}`)]) {
      expect(result).toContain('nests blocks more than 200 deep');
    }
    expect(bash(`${'('.repeat(150)}echo${')'.repeat(150)}`)).toBeUndefined();
    expect(ps(`${'function f { '.repeat(150)}echo${' }'.repeat(150)}`)).toBeUndefined();
  });

  it('blocks a PowerShell working directory in the project folder, and only that', () => {
    expect(ps(`Set-Location ${q(project)}; git status`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(ps(`cd -LiteralPath '${project}'`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(ps(`Push-Location ${q(path.join(project, 'src'))}`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(ps('Set-Location $env:PROJECT')).toContain('computed');
    expect(withEnvironment('PowerShell', { PROJECT: worktree })('Set-Location $env:PROJECT')).toBeUndefined();
    checkWith('PowerShell', { PROJECT: project }, 'Set-Location $env:PROJECT', REACHES);
    expect(ps('Set-Location src; git status; $x = 1')).toBeUndefined();
    expect(ps(`Get-ChildItem ${q(project)}`)).toBeUndefined();
  });

  it('resolves write paths as the tools do: @, file:// and ~', () => {
    const file = path.join(project, 'a.ts');
    expect(worktreeIsolationBlock('Write', { file_path: `@${file}` }, iso)).toContain(WORKTREE_ISOLATION_REASON);
    expect(worktreeIsolationBlock('Write', { file_path: new URL(`file:///${file.split(path.sep).join('/').replace(/^\//, '')}`).href }, iso)).toContain(WORKTREE_ISOLATION_REASON);
  });

  it('keeps every directory a cd may leave the shell in, so a failed or subshell cd cannot hide the project folder', () => {
    const deep = path.relative(worktree, project).split(path.sep).join('/');
    expect(bash(`cd /no/such/dir/a/b/c/d/e/f 2>/dev/null; cd ${q(deep)} && git add .`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`(cd /tmp) && cd ${q(deep)} && git status`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`CDPATH=${q(base)} cd project && git add .`)).toContain(WORKTREE_ISOLATION_REASON);
  });

  it('reads the script of shells, wrappers and find, and blocks what reads its commands from input', () => {
    expect(bash(`bash -lc ${q(`git -C '${project}' add .`)}`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`echo "git status" | bash`)).toContain('input');
    expect(bash(`env -S ${q(`git -C '${project}' status`)}`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`echo x | xargs -I{} git -C {} add .`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`echo x | xargs git add`)).toBeUndefined();
    expect(bash(`find . -exec git -C ${q(project)} add {} ;`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`trap ${q(`git -C '${project}' add .`)} EXIT`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`pwsh -Command ${q(`Set-Location '${project}'`)}`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`cmd /c "cd ${project} && git add ."`)).toContain(WORKTREE_ISOLATION_REASON);
  });

  it('treats globs, brace expansions, ~user and comments as the shell does', () => {
    expect(bash(`git {-C,${project.split(path.sep).join('/')}} add .`)).toContain('computed');
    expect(bash(`cd ${q(base)}/pro?ect && git add .`)).toBeDefined();
    expect(bash('cd ~root && git status')).toContain('computed');
    expect(bash(`echo hi #'\ncd ${q(project)} && git add .\n'`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`cat <<EOF\n$(cd ${q(project)} && git add .)\nEOF`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`cd -- ${q(project)} && git status`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash('pushd -n /x; pushd')).toContain('pushd');
    // bash expands braces only around an unquoted `,` or `..`; any other braces are literal text.
    check(bash, [
      ['git -C <FP>{,} status'],
      ['git -C {<FP>,x} status'],
      ['git -C <FP>{a..b} status'],
      ['git -C <FP>{a,{b}} status'],
      ['git ls-files | xargs -I{} cp {} /tmp/', 'xargs puts what it reads in place of {}'],
      ['find . -name x | xargs -I{} rm {}', 'xargs puts what it reads in place of {}'],
      ['echo a | xargs -I{} touch {}.txt', 'xargs puts what it reads in place of {}'],
      ['ls | xargs -I {} grep foo {}', 'xargs puts what it reads in place of {}'],
      ['git diff --name-only | xargs -I{} git add {}', 'git runs in the worktree'],
      ['echo x | xargs -I{} git -C {} add .'],
      ['mkdir -p {} && cd {} && git status', 'braces holding nothing are a folder name'],
      ["git -C '{<FP>,x}' status", 'quoted braces expand nothing'],
      ['git -C {"<FP>,x"} status', 'a quoted comma expands nothing'],
    ]);
  });

  it('blocks git configuration from the environment, aliases and variables read from input', () => {
    expect(bash(`GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.worktree GIT_CONFIG_VALUE_0=${q(project)} git status`)).toContain('environment');
    expect(bash(`git -c alias.x='!cd /x && git add .' x`)).toContain('alias');
    expect(bash(`git --namespace x -C ${q(project)} add .`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`read -r GIT_DIR <<< x; export GIT_DIR; git log`)).toContain('variable');
    expect(bash(`git worktree remove ${q(iso.otherWorktrees[0]!)}`)).toContain(WORKTREE_ISOLATION_REASON);
  });

  it('closes the residual shell, xargs, find, cmd and git option paths', () => {
    const fwd = project.split(path.sep).join('/');
    expect(bash(`pushd /tmp; pushd /no/such; popd; cd ${q(project)}`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`bash --rcfile /dev/null -c ${q(`git -C '${project}' add .`)}`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`bash --weird x -c 'git status'`)).toContain('option');
    expect(bash(`bash -C -c ${q(`git -C '${project}' add .`)}`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`sh -C -c ${q(`git -C '${project}' add .`)}`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`busybox sh -c ${q(`git -C '${project}' add .`)}`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`find ${q(project)} -name .git -execdir git add . ;`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`find . -exec git -C '{}/.' add . ;`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`echo x | xargs env git`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`echo x | xargs -I'{}' env git -C '{}' add .`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash('echo x | xargs grep foo')).toBeUndefined();
    expect(bash('cmd //c "g^it status"')).toBeUndefined();
    expect(bash(`cmd //c "g^it -C ${project} status"`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`wsl git -C ${q(fwd)} add .`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`fish -c ${q(`git -C '${project}' add .`)}`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`git --attr-source HEAD -C ${q(project)} add .`)).toContain('option');
    expect(bash('git --no-pager log')).toBeUndefined();
    expect(bash(`printf '%s\\n' "$PATH"`)).toBeUndefined();
    expect(bash('[[ -f x ]] && git status')).toBeUndefined();
  });

  it('reads wsl.exe\'s own arguments before the command line it runs, from either shell', () => {
    const fwd = project.split(path.sep).join('/');
    for (const run of [bash, ps]) {
      for (const command of ['wsl -l -v', 'wsl.exe --list --verbose', 'wsl --status', 'wsl -d Ubuntu-24.04 --list', 'wsl --shutdown', 'wsl -d Ubuntu -u root -- node -v', 'wsl -d Ubuntu -e node -v', 'wsl --system -e uname -a', 'wsl git status', 'wsl -e git status']) {
        expect(run(command), command).toBeUndefined();
      }
      for (const command of [
        `wsl -d Ubuntu -e git -C ${fwd} add .`,
        `wsl -d Ubuntu -u root -- cd ${fwd} && git add .`,
        `wsl --shell-type login git -C ${fwd} add .`,
        `wsl --shell-type none git -C ${fwd} add .`,
        `wsl 0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0 git -C ${fwd} add .`,
        `wsl --cd ${fwd} git add .`,
        `wsl -e bash -lc "git -C '${fwd}' add ."`,
      ]) {
        expect(run(command), command).toContain(WORKTREE_ISOLATION_REASON);
      }
      expect(run('wsl')).toContain('input');
      expect(run('wsl -d Ubuntu')).toContain('input');
      expect(run('wsl --debug-shell')).toContain('input');
      expect(run('wsl --weird git status')).toContain('option');
      expect(run('wsl --cd relative git -C x add .')).toBeUndefined();
    }
    expect(bash('wsl $OPT git status')).toContain('computed');
    expect(bash(`echo ${q(`git -C '${fwd}' add .`)} | wsl`)).toContain('input');
    expect(ps(`wsl --cd '${project}' git add .`)).toContain(WORKTREE_ISOLATION_REASON);
  });

  it('reads PowerShell comments, provider paths, qualified names, dash parameters and Invoke-Expression', () => {
    expect(ps(`<# x #> Set-Location ${q(project)}`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(ps(`Set-Location (Join-Path 'C:' 'x' -Resolve)`)).toContain('computed');
    expect(ps(`Set-Location FileSystem::${project}`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(ps(`Microsoft.PowerShell.Management\\Set-Location '${project}'`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(ps(`Set-Location \u2013LiteralPath '${project}'`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(ps(`iex "Set-Location '${project}'"`)).toContain(WORKTREE_ISOLATION_REASON);
  });

  it('maps Git Bash drive paths and ~ to native paths', () => {
    expect(nativeShellPath('/mnt/c/GameDev/proj', 'C:\\x', 'C:\\Users\\me', 'win32')).toBe('C:\\GameDev\\proj');
    expect(nativeShellPath('/c/GameDev/proj', 'C:\\x', 'C:\\Users\\me', 'win32')).toBe('C:\\GameDev\\proj');
    expect(nativeShellPath('~\\x', 'C:\\x', 'C:\\Users\\me', 'win32')).toBe('C:\\Users\\me\\x');
    expect(nativeShellPath('/mnt/c/GameDev/proj', '/home/me', '/home/me', 'linux')).toBe('/mnt/c/GameDev/proj');
    expect(nativeShellPath('~/x', '/tmp', '/home/me', 'linux')).toBe('/home/me/x');
    expect(nativeShellPath('~/x', base, path.join(base, 'home'))).toBe(path.join(base, 'home', 'x'));
  });

  it('parses $(), backticks and redirects as structure', () => {
    const parsed = parseShellStructure('a=1 git -C "x y" log > out 2>&1 | grep `echo z` && cd $(pwd)');
    expect(parsed.unparsable).toBe(false);
    expect(parsed.segments.map((s) => s.words)).toEqual([['git', '-C', 'x y', 'log'], ['grep', undefined], ['cd', undefined]]);
    expect(parsed.segments[0]!.assignments).toMatchObject([{ name: 'a', value: '1', raw: '1' }]);
    expect(parsed.segments[1]!.substitutions[0]!.segments[0]!.words).toEqual(['echo', 'z']);
    const loop = parseShellStructure('for f in $(ls); do :; done < <(git ls-files)');
    expect(loop.unparsable).toBe(false);
    // The loop's redirection runs before its header.
    expect(loop.segments[0]!.substitutions[0]!.segments[0]!.words).toEqual(['git', 'ls-files']);
    expect(loop.segments[1]).toMatchObject({ assignments: [{ name: 'f', value: undefined }], words: [] });
    expect(loop.segments[1]!.substitutions[0]!.segments[0]!.words).toEqual(['ls']);
    const array = parseShellStructure('arr=(a "b c" $(pwd))');
    expect(array.segments[0]!.assignments).toMatchObject([{ name: 'arr', value: undefined, raw: '(a "b c" $(pwd))' }]);
    expect(array.segments[0]!.substitutions[0]!.segments[0]!.words).toEqual(['pwd']);
  });

  it('reads the substitutions of a for header and of a heredoc before one', () => {
    expect(bash(`for f in $(git -C ${q(project)} status --porcelain); do :; done`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`cat <<EOF\n$(git -C ${q(project)} add .)\nEOF\nfor f in a; do :; done`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`for GIT_DIR in ${q(path.join(project, '.git'))}; do export GIT_DIR; git log; done`)).toContain('GIT_DIR');
    expect(bash('for f in *.ts; do git add "$f"; done')).toBeUndefined();
  });

  it('follows a cd inside eval and a trap that runs later', () => {
    expect(bash(`eval 'cd ../../../../..'; cd project && git add .`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`trap 'git -C ../project add .' EXIT; cd ${q(path.join(base, 'home'))}`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`trap ${q(`cd '${base}'`)} DEBUG; cd project; git add .`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`eval 'cd src'; git status`)).toBeUndefined();
  });

  it('reads ${...} words, arithmetic, $\'...\' escapes and heredoc delimiters as bash does', () => {
    expect(bash(`echo \${x:-$(git -C ${q(project)} add .)}`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`echo "\${x:-$(git -C ${q(project)} add .)}"`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`echo $(( $(git -C ${q(project)} add .) ))`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`echo $'\\'' && git -C ${q(project)} add . && echo \\'`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`cat <<"E"OF\nx\nEOF\ngit -C ${q(project)} add .\nE`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`echo \${x:-a #}; git -C ${q(project)} add .`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`echo "\${x:-" #"}" ; git -C ${q(project)} add .`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash('echo $(( (1 + 2) * 3 )) "${HOME:-x}" $\'a\\tb\'')).toBeUndefined();
  });

  it('reads the options of env, sudo and xargs, and blocks one it does not know', () => {
    expect(bash(`xargs -l git -C ${q(project)} add .`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`env -vC${q(project)} git add .`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`env --ch=${q(project)} git add .`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`env --sp=${q(`git -C '${project}' add .`)}`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`sudo --user root git -C ${q(project)} add .`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`sudo -D ${q(project)} git add .`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`sudo --chdir=${q(project)} git add .`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash('env --weird git status')).toContain('option');
    expect(bash('env -i FOO=1 git status && xargs -0 -n1 git add && sudo -u root git status && nice -n 5 git status && timeout -s KILL 10 git status')).toBeUndefined();
  });

  it('reads PowerShell line continuations, pipeline input, cd.. and cd\\, and parameter abbreviations', () => {
    expect(ps(`Set-Location \`\n'${project}'`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(ps(`Set-Location \`\r\n'${project}'`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(ps(`'${project}' | Set-Location`)).toContain('computed');
    expect(ps('cd..; cd..; cd..; cd..; cd..; cd project')).toContain(WORKTREE_ISOLATION_REASON);
    expect(ps(`cd\\; cd '${project.slice(path.parse(project).root.length)}'`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(ps(`Set-Location -Pat:'${project}'`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(ps(`Set-Location -Li:'${project}'`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(ps(`Set-Location -LiteralP '${project}'`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(ps(`Set-Location -ErrorAction SilentlyContinue '${project}'`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(ps('Set-Location -Foo src')).toContain('parameter');
    expect(ps('Get-ChildItem `\n  -Path src `\r\n  -Recurse\nSet-Location `\n  src; git status')).toBeUndefined();
  });

  // pwsh on Linux and macOS turns `\` into `/` in a provider path; git, like every native program, gets `\` as written.
  it('reads `\\` in a PowerShell location as PowerShell does, and in a git argument as git does', () => {
    const backslashed = project.split(path.sep).join('\\');
    expect(ps(`Set-Location '${backslashed}'; git status`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(ps('cd ..\\..\\..\\..\\..\\project')).toContain(WORKTREE_ISOLATION_REASON);
    const gitDir = ps(`git --git-dir='${backslashed}\\.git' log`);
    if (process.platform === 'win32') expect(gitDir).toContain(WORKTREE_ISOLATION_REASON);
    else expect(gitDir).toBeUndefined();
  });

  it('reads the cd~ function and the program exec runs, and blocks Switch-Process', () => {
    expect(ps('cd~; cd ../project; git status')).toContain(WORKTREE_ISOLATION_REASON);
    expect(ps(`exec git -C '${project}' status`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(ps('exec $tool status')).toContain('computed');
    expect(ps('exec git status')).toBeUndefined();
    expect(ps('Switch-Process -WithCommand git, status')).toContain('Switch-Process');
  });

  it('parses the command prefix pi runs before every command', () => {
    expect(worktreeIsolationBlock('Bash', { command: 'git add .' }, { ...iso, commandPrefix: `cd ${q(project)}` })).toContain(WORKTREE_ISOLATION_REASON);
    expect(worktreeIsolationBlock('Bash', { command: 'git add .' }, { ...iso, commandPrefix: 'set -e' })).toBeUndefined();
  });

  it('blocks a computed value only for the variables that point git at a folder or run a command', () => {
    expect(bash('GIT_AUTHOR_NAME="$n" git commit -m x')).toBeUndefined();
    expect(bash('GIT_SSH_COMMAND="ssh -i $K" git push')).toBeUndefined();
    expect(bash(`GIT_SSH_COMMAND=${q(`cd '${project}' && git add . #`)} git fetch`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`git -c core.pager=${q(`git -C '${project}' add .`)} log`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash('GIT_DIR="$(cat f)" git log')).toContain('computed');
    checkWith('Bash', { D: path.join(project, '.git') }, 'GIT_DIR="$D" git log', REACHES);
    expect(bash('while read l; do echo "$l"; done < <(git ls-files)')).toBeUndefined();
    expect(bash(`while read l; do :; done < <(git -C ${q(project)} ls-files)`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash('arr=(a b "c d"); declare -a more=(x y); git status')).toBeUndefined();
    expect(bash(`arr=($(git -C ${q(project)} ls-files))`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash('GIT_DIR=(x) git log')).toContain('computed');
  });

  it('names the area a block is about', () => {
    expect(worktreeIsolationBlock('Edit', { file_path: path.join(iso.otherWorktrees[0]!, 'x') }, iso)).toContain('another worktree of the project');
    expect(bash(`cd ${q(path.join(project, 'src'))}`)).toContain('in the project folder');
    const repo = path.join(base, 'repo');
    const app = path.join(repo, 'app');
    fs.mkdirSync(app, { recursive: true });
    const nested = { ...iso, projectPath: app, repositoryRoot: repo };
    expect(worktreeIsolationBlock('Bash', { command: `git -C ${q(repo)} add .` }, nested)).toContain("the project's repository");
    expect(worktreeIsolationBlock('PowerShell', { command: `Set-Location '${repo}'; git add .` }, nested)).toContain("the project's repository");
  });

  // `<QP>` is the project folder as a double-quoted word, `<P>` as written, `<FP>` with forward slashes, `<QB>` its parent
  // double-quoted, `<S>` the host's path separator, which git takes as one; a row with a reason is allowed. `<W>`, `<QW>`
  // and `<FW>` are the worktree in the same forms, `<UP>` the project reached from it, and `<P*>` and `<P?>` the project
  // with its last characters turned into wildcards.
  // A row marked REACHES must block by naming the area it reaches; a block because a value is computed fails it.
  type Row = readonly [command: string, verdict?: string | typeof REACHES];
  const expand = (command: string): string =>
    command
      .replaceAll('<QP>', q(project)).replaceAll('<FP>', project.split(path.sep).join('/')).replaceAll('<P>', project)
      .replaceAll('<P*>', `${project.slice(0, -2)}*`).replaceAll('<P?>', `${project.slice(0, -1)}?`)
      .replaceAll('<QW>', q(worktree)).replaceAll('<FW>', worktree.split(path.sep).join('/')).replaceAll('<W>', worktree)
      .replaceAll('<UP>', '../../../../../project').replaceAll('<QB>', q(base)).replaceAll('<S>', path.sep);
  const check = (run: (command: string) => string | undefined, rows: readonly Row[]): void => {
    for (const [command, verdict] of rows) {
      const result = run(expand(command));
      if (verdict === undefined) expect(result, command).toContain(WORKTREE_ISOLATION_REASON);
      else if (verdict === REACHES) expectReaches(result, command);
      else expect(result, command).toBeUndefined();
    }
  };
  /** One row for the shell `tool` started with `extra` added to its environment. */
  const checkWith = (tool: 'Bash' | 'PowerShell', extra: Readonly<Record<string, string | undefined>>, command: string, verdict?: Row[1]): void =>
    check(withEnvironment(tool, extra), [verdict === undefined ? [command] : [command, verdict]]);

  it('reads bash expansions wherever they run', () => {
    check(bash, [
      ['echo "$(git -C <QP> add .)"'],
      ["echo `git -C '<P>' add .`"],
      ['echo ${x:=$(git -C <QP> add .)}'],
      ['echo "${x:+$(git -C <QP> add .)}"'],
      ['echo ${#x} ${x//a/$(git -C <QP> add .)}'],
      ['echo $(( 1 + $(git -C <QP> rev-list --count HEAD) ))'],
      ["echo $((`git -C '<P>' add .`))"],
      ['echo $((cd <QP>; git add .) )'],
      ['diff <(git -C <QP> show HEAD:a) a'],
      ['cat > >(git -C <QP> add .)'],
      [`eval "cd '<P>'"`],
      ["eval 'cd ..'; eval 'cd ..'; eval 'cd ..'; eval 'cd ..'; eval 'cd ..'; git -C project add ."],
      ['arr=([0]=$(git -C <QP> add .))'],
      ['arr+=("$(git -C <QP> add .)")'],
      ["echo $'\\x27' ; git -C <QP> add ."],
      ["x=$'\\''; git -C <QP> add ."],
      ['cd $"<P>" && git status'],
      ["x='a[$(git -C <FP> add .)]'; echo $((x))"],
      // A declaration builtin evaluates the subscript of an operand whose name any expansion may give.
      ["n=a; declare $n'[$(git -C <FP> add .)]=1'", REACHES],
      ["declare $-'[$(git -C <FP> add .)]=1'", REACHES],
      // bash leaves single quotes inside an unquoted ${} literal; the parse reads the text anyway and blocks.
      ["echo ${x:-'$(git -C <FP> add .)'}"],
      ['echo "$(git rev-parse --show-toplevel)" ${HOME:-/tmp} $((2*3))', 'git runs in the worktree'],
      ['files=($(git ls-files)); echo "${files[@]}"', 'git runs in the worktree'],
      [`export MSG='use $(git status) here'; git commit -m "$MSG"`, 'the git status the text holds runs in the worktree'],
      ['(cd src && git status)', 'the subshell moves within the worktree'],
    ]);
  });

  it('reads heredoc delimiters and bodies as bash does', () => {
    check(bash, [
      ["cat <<'EOF'\n$(git -C <FP> add .)\nEOF", 'a quoted delimiter makes the body data'],
      ['cat <<E"O"F\n$(git -C <FP> add .)\nEOF', 'a partly quoted delimiter makes the body data'],
      ['cat <<\\EOF\n$(git -C <FP> add .)\nEOF\ngit status', 'an escaped delimiter makes the body data, and git runs in the worktree'],
      ['cat <<-EOF\n\t$(git -C <QP> add .)\n\tEOF'],
      ['cat <<-EOF\n\tbody\n\tEOF\ngit -C <QP> add .'],
      ['cat <<A <<B\nx\nA\n$(git -C <QP> add .)\nB'],
      ["cat <<A; cat <<'B'\n$(git -C <QP> add .)\nA\nx\nB"],
      ['cat <<EOF\nx\nEOF\nwhile read l; do git -C <QP> add "$l"; done'],
      ['cat <<EOF\n$(git -C <QP> add .)\nEOF\ncase x in x) :;; esac'],
      ['cat <<"E"OF\nE\ngit -C <QP> add .\nEOF', 'the delimiter is EOF, so both lines are body data'],
      ['cat <<EOF\nEOF \ngit -C <QP> add .'],
      ["git commit -F - <<'MSG'\nfix: cd <P>\nMSG", 'the message is data'],
      ["cat <<EOF\n`git -C '<P>' add .`\nEOF"],
      ['cat <<E\\OF\nx\nEOF\ngit -C <QP> add .'],
      ["cat <<$'EOF'\nx\nEOF"],
    ]);
  });

  it('reads the options of every wrapper it follows', () => {
    check(bash, [
      ['env -i -C <QP> git add .'],
      ['env --chdir <QP> git add .'],
      ['env -u FOO -- git -C <QP> add .'],
      ['env -0v git -C <QP> add .'],
      ['env - GIT_DIR=<QP>/.git git log'],
      ["env -S'git -C <FP> add .'"],
      ['env --i git status'],
      ['env --unset=X --ignore-env git status', 'the abbreviation is unambiguous and git runs in the worktree'],
      ['sudo -nu root git -C <QP> add .'],
      ['sudo -E -H --preserve-env=PATH git -C <QP> add .'],
      ['sudo --u=root git status', '--u is --user and git runs in the worktree'],
      ['sudo -R / git status'],
      ['sudo -i git status'],
      ['sudo GIT_WORK_TREE=<QP> git status'],
      ['sudo -D<QP> git add .'],
      ['xargs -i git -C {} add .'],
      ['xargs -0 -I % git -C % add .'],
      ['xargs --replace=@ git -C @ add .'],
      ['xargs -n 1 -P 4 git -C <QP> add'],
      ['xargs -L1 git add', 'xargs appends what it reads to git add, which runs in the worktree'],
      ['xargs -E END git add', 'xargs appends what it reads to git add, which runs in the worktree'],
      ["xargs -a list.txt -d '\\n' git -C <QP> add"],
      ['nice -n 10 git -C <QP> add .'],
      ['nice -5 git -C <QP> add .'],
      ['timeout --signal=KILL 5s git -C <QP> add .'],
      ['timeout -k 1 5 env -C <QP> git add .'],
      ['stdbuf -oL git -C <QP> add .'],
      ['nohup git -C <QP> add . &'],
      ['command -p git -C <QP> add .'],
      ['builtin cd <QP>'],
      ['exec -a name git -C <QP> add .'],
      ['time -p git status', 'the -p belongs to the time keyword and git runs in the worktree'],
      ['time -p git -C <QP> add .'],
      ['busybox env -C <QP> git add .'],
      ['setsid git -C <QP> add .'],
      ['setsid --wait git -C <QP> add .'],
      ['setsid -x git status'],
      ['setsid -f git status', 'git runs in the worktree'],
      ['doas -u root git -C <QP> add .'],
      ['doas -n git status', 'git runs in the worktree'],
      ['doas -C /etc/doas.conf git -C <QP> add .', 'doas -C only checks its configuration and runs nothing'],
      ['flock /tmp/l git -C <QP> add .'],
      ["flock -n /tmp/l -c 'git -C <FP> add .'"],
      [`flock --command "cd '<P>' && git add ." /tmp/l`],
      ['flock -w 5 /tmp/l git status', 'git runs in the worktree'],
      ['flock -x 9', 'it locks a descriptor and runs nothing'],
      ['watch -n 2 git -C <FP> status'],
      [`watch "cd '<P>' && git status"`],
      ['watch -x git -C <QP> status'],
      ['watch -d git status', 'git runs in the worktree'],
      ['parallel git -C {} add . ::: <QP>'],
      ["parallel 'cd {} && git add .' ::: a"],
      ['parallel git -C <FP> add ::: a'],
      [`parallel ::: "git -C '<P>' add ."`],
      ['parallel --wd <QP> git add . ::: a'],
      ['parallel -S host git status ::: a'],
      ['parallel < cmds.txt'],
      ['parallel -j4 git add ::: a b', 'git add runs in the worktree with each input appended'],
      ['parallel echo ::: a b', 'echo runs with each input'],
    ]);
  });

  it('reads the command text git runs from its configuration and the environment', () => {
    check(bash, [
      [`git -c filter.x.clean="git -C '<P>' add ." add .`],
      [`git -c filter.x.smudge="cd '<P>'; git add ." checkout .`],
      [`git -c filter.x.process="git -C '<P>' add ." add .`],
      [`git -c diff.x.command="git -C '<P>' add ." diff`],
      [`git -c diff.x.textconv="git -C '<P>' add ." log -p`],
      [`git -c credential.helper="!git -C '<P>' add ." fetch`],
      [`git -c core.fsmonitor="git -C '<P>' add ." status`],
      [`git -c merge.x.driver="git -C '<P>' add ." merge b`],
      ['git -c include.path=<QP>/.git/config status'],
      [`PAGER="git -C '<P>' add ." git log`],
      [`EDITOR="cd '<P>'; git add ." git commit`],
      [`export VISUAL="git -C '<P>' add ."`],
      [`GIT_PAGER="git -C '<P>' add ." git log`],
      ['source ./env.sh; GIT_EDITOR="$E" git commit'],
      ['git -c credential.helper=store fetch', 'the helper is git credential-store, which runs in the worktree'],
      ['git -c core.fsmonitor=true status', 'true runs nothing'],
      ['PAGER=less EDITOR=vim git log', 'the pager and editor run in the worktree'],
      // Hooks run at the worktree's top level (githooks: "the root of the working tree"), and a hook file's text is never read, as `./build.sh` is not.
      ['git -c core.hooksPath=<QP>/.git/hooks commit -m x', 'its hooks run in the worktree and their text is a file, not command text'],
      // Arithmetic on counted input is ordinary, so text that reaches a variable from outside the command stays an accepted limit.
      ['n=$(wc -l < f); echo $((n+1))', 'wc runs in the worktree'],
    ]);
    // A command variable the shell starts with reaches git as one the command sets does.
    const into = `git -C ${q(project)} status`;
    for (const tool of ['Bash', 'PowerShell'] as const) {
      checkWith(tool, { GIT_PAGER: into }, 'git log', REACHES);
      checkWith(tool, { PAGER: `cd ${q(project)} && pwd` }, 'git log', REACHES);
      checkWith(tool, { GIT_SSH_COMMAND: `cd ${q(project)} && git add . #` }, 'git fetch', REACHES);
      checkWith(tool, { EDITOR: into }, 'git commit', REACHES);
      checkWith(tool, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: into }, 'git log');
      checkWith(tool, { GIT_PAGER: into }, 'Get-ChildItem; ls', 'no git runs, so nothing runs the pager');
      checkWith(tool, { GIT_PAGER: 'less -R', EDITOR: 'code --wait' }, 'git log; git commit', 'the pager and editor run in the worktree');
      checkWith(tool, { GIT_CONFIG_GLOBAL: path.join(base, 'home', '.gitconfig') }, 'git status', 'a configuration file is not read, as ~/.gitconfig is not');
    }
    checkWith('Bash', { GIT_PAGER: into }, 'bash -c "git log"', REACHES);
    checkWith('Bash', { GIT_PAGER: into }, 'GIT_PAGER=less git log', 'the assignment replaces the pager for this git');
    checkWith('Bash', { GIT_PAGER: into }, 'cmd /d /c "git log"', REACHES);
  });

  it('reads PowerShell continuations, pipelines, aliases, parameters, splatting and script blocks', () => {
    check(ps, [
      ["Set-Location `\r\n  -Path `\r\n  '<P>'"],
      ["sl '<P>'"],
      ["chdir '<P>'"],
      ["pushd '<P>'"],
      ["'<P>' | Push-Location"],
      ["Get-Item '<P>' | Set-Location"],
      ["'<P>' |\n  Set-Location"],
      ["Set-Location -P '<P>'"],
      ["Set-Location -PSPath '<P>'"],
      ["Set-Location -LP:'<P>'"],
      ["Set-Location -PassThru -Path '<P>'"],
      ["Set-Location -StackName s '<P>'"],
      ["$a = @{ Path = '<P>' }; Set-Location @a"],
      ["& { Set-Location '<P>' }"],
      ["Invoke-Command -ScriptBlock { cd '<P>' }"],
      ['CD..; CD..; CD..; CD..; CD..; cd project'],
      ["Set-Location -ErrorAction:Stop '<P>'"],
      ["New-PSDrive -Name P -PSProvider FileSystem -Root '<P>'; Set-Location P:"],
      ["Set-Location -Path @'\n<P>\n'@"],
      ['Set-Location src -PassThru | Out-Null', 'src is in the worktree'],
      ['cd -', 'it returns to a location the command already had'],
      ['Get-ChildItem `\n  -Recurse `\n  -Filter *.ts | Select-Object -First 5', 'nothing changes location'],
      ['& { Set-Location src }; git status', 'the script block moves within the worktree'],
    ]);
  });

  it('blocks source and a shell reading their script from input, and allows a script file', () => {
    check(bash, [
      ['source <(echo "cd <FP>"); git add .'],
      ['. <(echo "cd <FP>"); git add .'],
      ['. /dev/stdin <<< "cd <FP>"; git add .'],
      ['source /dev/fd/0 <<< "cd <FP>"; git add .'],
      ['source /proc/self/fd/0 <<< "cd <FP>"; git add .'],
      ['source -- /dev/stdin <<< "cd <FP>"; git add .'],
      ['builtin source <(echo "cd <FP>"); git add .'],
      ['source "$(cat f)"; git status'],
      ['bash /dev/stdin <<< "git -C <FP> add ."'],
      ['sh /dev/fd/0 <<< "git -C <FP> add ."'],
      ['echo "git -C <FP> add ." | bash /dev/stdin'],
      ['bash -- /dev/stdin <<< "git -C <FP> add ."'],
      ['bash -- <(echo "git -C <FP> add .")'],
      ['echo "git -C <FP> add ." | bash --'],
      ['bash -s x <<< "git -C <FP> add ."'],
      ['source .venv/bin/activate && git status', 'a script file\'s text is not read'],
      ['. ./env.sh && npm test', 'a script file\'s text is not read'],
      ['source -- .venv/bin/activate; source -p /opt/env setup.sh', 'a script file\'s text is not read'],
      ['bash -- ./build.sh x && sh -e ./ci.sh', 'a script file\'s text is not read'],
      ['cat <<EOF > s.sh\ncd <P>\nEOF\nbash s.sh', 'a script file\'s text is not read, even one the command wrote'],
    ]);
    expect(worktreeIsolationBlock('Bash', { command: 'git add .' }, { ...iso, commandPrefix: `source <(echo ${q(`cd '${project}'`)})` })).toContain(WORKTREE_ISOLATION_REASON);
  });

  it('ends a for header without a list at do, as bash does', () => {
    check(bash, [
      ['set -- x; for f do git -C <QP> add .; done'],
      ['for f do cd <QP>; done; git add .'],
      ['for ((i=0;i<1;i++)) do git -C <QP> add .; done'],
      ['for ((i=0;i<1;i++)); do git -C <QP> add .; done'],
      ['for f; do git -C <QP> add .; done'],
      ['for f in a do b; do echo "$f"; done; git status', 'do inside the list is an item'],
      ['for f; do echo "$f"; done', 'nothing runs git'],
    ]);
    expect(parseShellStructure('for f do git status; done').segments.map((s) => s.words)).toEqual([[], ['git', 'status']]);
    expect(parseShellStructure('for f in a do git; do :; done').segments.map((s) => s.words)).toEqual([[], [':']]);
  });

  it('finds the end of a command substitution past heredoc bodies and comments', () => {
    check(bash, [
      ["git commit -m \"$(cat <<'EOF'\nfix: don't crash\nEOF\n)\"", 'the message is data'],
      ["git commit -m \"$(cat <<'EOF'\nfeat: steps\n\n1) parse\n2) check\nEOF\n)\"", 'the message is data'],
      ["git commit -m \"$(cat <<'EOF'\nfeat: x :)\nEOF\n)\"", 'the message is data'],
      ['git commit -m "$(cat <<-EOF\n\tfix: a )\n\tEOF\n)"', 'the message is data'],
      ["x=$(echo a # it's )\n); git status", 'the comment is not code'],
      ["git commit -m \"$(cat <<'EOF'\n$(git -C <FP> add .)\nEOF\n)\"", 'a quoted delimiter makes the body data'],
      ['git commit -m "$(cat <<EOF\n$(git -C <FP> add .)\nEOF\n)"'],
      ['x=$(echo # )\ngit -C <QP> add .\n)'],
      ['echo $(( 1 << 2 ))\ngit -C <QP> add .'],
      ['echo $(( 1 << 2 )); git status', 'a shift is not a heredoc'],
    ]);
  });

  it('keeps every value a target variable may hold, and gives substitutions their own variables and stack', () => {
    check(bash, [
      ['export GIT_DIR=../../../../../../project/.git; (GIT_DIR=x); cd src; git log'],
      ['CDPATH=<QB>; (CDPATH=); cd project && git add .'],
      ['CDPATH=<QB>; x=$(CDPATH=; :); cd project && git add .'],
      ['CDPATH=<QB>; if false; then CDPATH=; fi; cd project && git add .'],
      ['x=$(CDPATH=<QB>); cd project && git status', 'the substitution sets its own copy'],
      ['x=$(pushd /tmp); popd; cd src && git status', 'popd on an empty stack fails and stays put'],
      ['GIT_DIR=.git git status; git log', 'a prefix assignment lasts one command'],
    ]);
  });

  it('reads the text a command variable runs with a variable from outside the command as a computed word', () => {
    check(bash, [
      ['source ./env.sh; GIT_SSH_COMMAND="ssh -i $K" git push', 'K comes from outside the command'],
      ['export GIT_SSH_COMMAND="ssh -i ${HOME}/.ssh/id -o \'IdentitiesOnly yes\'"; git fetch', 'HOME comes from outside the command'],
      ['GIT_SSH_COMMAND="ssh \'$K\'" git push', 'K is an ssh argument'],
      ['K="x; git -C <FP> add ."; GIT_SSH_COMMAND="ssh -i $K" git push'],
      ['read K <<< x; GIT_SSH_COMMAND="ssh -i $K" git push'],
      ['read <<< x; GIT_SSH_COMMAND="ssh -i $REPLY" git push'],
      ['source ./env.sh; GIT_SSH_COMMAND="$CMD -i k" git push'],
      ['source ./env.sh; GIT_SSH_COMMAND="git -C \'$D\' add ." git fetch'],
      ['source ./env.sh; GIT_SSH_COMMAND="cd $D && ssh" git fetch'],
      ['GIT_SSH_COMMAND="ssh $1" git push'],
      ['GIT_SSH_COMMAND="ssh ${K:-x}" git push'],
      ['GIT_SSH_COMMAND="ssh $(cat k)" git push'],
      ['source ./env.sh; env GIT_SSH_COMMAND="ssh -i $K" git push', 'K comes from outside the command'],
      ['source ./env.sh; export GIT_SSH_COMMAND="ssh -i $K"', 'K comes from outside the command'],
    ]);
    const environment = { K: 'id_ed25519', CMD: 'ssh', D: worktree, E: 'vim', F: './env.sh' };
    check(withEnvironment('Bash', environment), [
      ['GIT_SSH_COMMAND="ssh -i $K" git push', 'K reads as a key file'],
      ['GIT_SSH_COMMAND="$CMD -i k" git push', 'CMD reads as ssh'],
      ['GIT_SSH_COMMAND="git -C \'$D\' status" git fetch', 'D reads as the worktree'],
      ['GIT_EDITOR="$E" git commit', 'E reads as an editor'],
      ['source "$F"; git status', 'F reads as a script file'],
    ]);
    const fwd = project.split(path.sep).join('/');
    check(withEnvironment('Bash', { K: `x; git -C ${fwd} add .`, CMD: `git -C '${fwd}' add . #`, D: fwd, E: `git -C '${fwd}' add .`, F: '/dev/stdin' }), [
      ['GIT_SSH_COMMAND="ssh -i $K" git push'],
      ['GIT_SSH_COMMAND="$CMD -i k" git push'],
      ['GIT_SSH_COMMAND="git -C \'$D\' add ." git fetch'],
      ['GIT_SSH_COMMAND="cd $D && ssh" git fetch'],
      ['GIT_EDITOR="$E" git commit'],
      ['source "$F" <<< "cd <FP>"; git add .'],
    ]);
  });

  it('reads the options of the other command runners', () => {
    check(bash, [
      ['script -qc "git -C <FP> add ." /dev/null'],
      ['script /dev/null -c "git -C <FP> add ."'],
      ['script --command="cd <FP> && git add ." /dev/null'],
      ['script -q /dev/null git -C <QP> add .'],
      ['script /dev/null'],
      ['script -t 0 /dev/null git status'],
      ['su -c "git -C <FP> add ."'],
      ['su - root -c "git status"'],
      ['su root -- -c "git -C <FP> add ."'],
      ['su root'],
      ['runuser -u bob -- git -C <QP> add .'],
      ['runuser -u bob git -C <QP> add .'],
      ['runuser bob -c "git -C <FP> add ."'],
      ['ionice -c3 git -C <QP> add .'],
      ['ionice -c 2 -n 7 env -C <QP> git add .'],
      ['taskset 0x3 git -C <QP> add .'],
      ['taskset -c 0-2 git -C <QP> add .'],
      ['chrt -o 0 git -C <QP> add .'],
      ['chrt 10 git -C <QP> add .'],
      ['winpty git -C <QP> status'],
      ['winpty --mouse env -C <QP> git add .'],
      ['cross-env GIT_DIR=<QP>/.git git log'],
      ['npx cross-env GIT_DIR=<QP>/.git git log'],
      ['npx --yes cross-env NODE_ENV=test git -C <QP> add .'],
      ['npx -c "git -C <FP> add ."'],
      ['cross-env-shell "git -C <FP> add ."'],
      ['ionice --weird git status'],
      ['script -qc "git status" /dev/null', 'git runs in the worktree'],
      ['su -c "git status"', 'su without a login shell stays in the worktree'],
      ['runuser -u bob -- git status', 'git runs in the worktree'],
      ['ionice -p 123 && taskset -p 123 && chrt -p 123 && chrt -m', 'they act on running processes'],
      ['ionice -c3 nice git status && taskset 1 git status && chrt -o 0 git status', 'git runs in the worktree'],
      ['winpty node app.js', 'node runs in the worktree'],
      ['npx vitest run && npx --yes prettier --write . && npx cross-env NODE_ENV=test vitest run', 'they run in the worktree'],
    ]);
  });

  it('follows substitutions only in text that becomes a variable\'s value or arithmetic', () => {
    check(bash, [
      ["echo a='$(git -C <FP> add .)'", 'the argument is data'],
      ["echo x='$(case a in a) ;; esac)'; git status", 'the argument is data'],
      ["git commit -m 'x=$(y)'", 'the message is data'],
      ["x=\"$y\"'a[$(git -C <FP> add .)]'; echo $((x))"],
      ["let 'x=a[$(git -C <FP> add .)]'"],
      ["[[ 1 -eq 'a[$(git -C <FP> add .)]' ]]"],
      ["declare x='a[$(git -C <FP> add .)]'"],
      ["local -i x='a[$(git -C <FP> add .)]'"],
      ["[[ $x == 'a[$(git -C <FP> add .)]' ]]", 'a string comparison is not arithmetic'],
    ]);
  });

  it('ignores a computed value given to a PowerShell switch', () => {
    check(ps, [
      ['Set-Location -WhatIf:$true src', 'the switch takes the value'],
      ['Set-Location -Verbose:$false src; git status', 'the switch takes the value'],
      ["Set-Location -Verbose:$false '<P>'"],
      ["Set-Location -ErrorAction:$e '<P>'"],
      ['Set-Location -Path:$x'],
    ]);
  });

  const UP = "$env:GIT_DIR = '..<S>..<S>..<S>..<S>..<S>..<S>project<S>.git'";
  // PowerShell's -EncodedCommand text: base64 of UTF-16LE.
  const encoded = (text: string): string => Buffer.from(expand(text), 'utf16le').toString('base64');

  it('blocks git aimed at the project folder from PowerShell, however git is spelled or called', () => {
    check(ps, [
      ['git -C <QP> status'],
      ['& git -C <QP> status'],
      ["& 'git' -C '<P>' status"],
      ["&git -C '<P>' status"],
      [". git -C '<P>' status"],
      ["git.exe -C '<P>' status"],
      ["GIT -C '<P>' status"],
      ["g`it -C '<P>' status"],
      ["& \"C:\\Program Files\\Git\\cmd\\git.exe\" -C '<P>' status"],
      ["C:\\Program` Files\\Git\\cmd\\git.exe -C '<P>' status"],
      [".\\tools\\git.exe -C '<P>' status"],
      ["./bin/git -C '<P>' status"],
      ["git --git-dir='<P><S>.git' log"],
      ["git --work-tree '<P>' status"],
      ["git -c core.worktree='<P>' status"],
      ["git -c include.path='<P><S>.git<S>config' status"],
      ["git -c core.sshCommand=\"git -C '<P>' add .\" fetch"],
      ["git -c alias.x='!git -C <FP> add .' x"],
      ['git --attr-source HEAD status'],
      ['git @a status'],
      ['git $x status'],
      ["git 2>&1 -C '<P>' status"],
      ["git --% -C '<P>' status"],
      ['Set-Location src; git -C ..<S>..<S>..<S>..<S>..<S>..<S>project status'],
      ["$out = git -C '<P>' status"],
      ["$out=git -C '<P>' status"],
      ["[string]$out = git -C '<P>' status"],
      ["Write-Output (git -C '<P>' status)"],
      ["Write-Output (')'); git -C '<P>' status #'"],
      ["Write-Host \"head: $(git -C '<P>' rev-parse HEAD)\""],
      ["@\"\n$(git -C '<P>' status)\n\"@ | Out-File x.txt"],
      ["foreach ($f in git -C '<P>' ls-files) { $f }"],
      ["return git -C '<P>' status"],
      ["Set-Alias g git; g -C '<P>' status"],
      ["Set-Item alias:g git; g -C '<P>' status"],
      ["New-Item alias:g -Value git; g -C '<P>' status"],
      ["${alias:g} = 'git'; g -C '<P>' status"],
      ["$alias:g = 'git'; g -C '<P>' status"],
      ["Set-Item function:gf \"git -C '<P>' status\"; gf"],
      ["${function:gf} = \"git -C '<P>' status\"; gf"],
      ["$h = @{ b = git -C '<P>' status }"],
      ["@{ a = 1; b = git -C '<P>' status }"],
      ["& ([scriptblock]::Create(\"git -C '<P>' status\"))"],
      ["[scriptblock]::Create(\"git -C '<P>' status\").Invoke()"],
      ["$ExecutionContext.InvokeCommand.InvokeScript(\"git -C '<P>' status\")"],
    ]);
    expect(ps(`git worktree remove ${q(iso.otherWorktrees[0]!)}`)).toContain('another worktree of the project');
  });

  it('reads the environment PowerShell gives git, however it is set and wherever git runs later', () => {
    check(ps, [
      ['$env:GIT_DIR="<P><S>.git"; git log'],
      ["$env:GIT_WORK_TREE = '<P>'; git status"],
      ["$env:git_dir = '<P><S>.git'; git log"],
      ["${env:GIT_DIR} = '<P><S>.git'; git log"],
      ["Set-Item env:GIT_DIR '<P><S>.git'; git log"],
      ["Set-Item -Path Env:\\GIT_WORK_TREE -Value '<P>'; git status"],
      ["New-Item -Path env:GIT_DIR -Value '<P><S>.git'; git log"],
      ["New-Item -Path env: -Name GIT_DIR -Value '<P><S>.git'; git log"],
      ["Set-Content env:GIT_DIR '<P><S>.git'; git log"],
      ['Copy-Item env:TEMP env:GIT_DIR; git log'],
      ["$ExecutionContext.SessionState.PSVariable.Set('env:GIT_DIR', '<P><S>.git'); git log"],
      ["[Environment]::SetEnvironmentVariable('GIT_DIR', '<P><S>.git'); git log"],
      ["[System.Environment]::SetEnvironmentVariable('GIT_WORK_TREE', '<P>', 'Process'); git status"],
      ['[Environment]::SetEnvironmentVariable($n, $v); git log'],
      ["[Environment]::SetEnvironmentVariable.Invoke('GIT_DIR', '<P><S>.git'); git log"],
      ["[Environment]::'SetEnvironmentVariable'('GIT_DIR', '<P><S>.git'); git log"],
      ["$env:GIT_DIR, $null = '<P><S>.git', 1; git log"],
      ["$env:GIT_DIR = \"$root\\.git\"; git log"],
      ["$env:GIT_DIR += '\\x'; git log"],
      ["$env:GIT_SSH_COMMAND = \"cd '<P>'; git add .\"; git fetch"],
      ["$env:GIT_PAGER = \"git -C '<P>' add .\""],
      ['$env:GIT_SSH_COMMAND = "ssh -i $key"; git fetch'],
      ["$env:EDITOR = \"git -C '<P>' add .\"; git commit"],
      ['$env:GIT_CONFIG_COUNT = 1; git status'],
      ["if ($x) { $env:GIT_WORK_TREE = '<P>' }; git status"],
      // From the worktree this relative GIT_DIR names a folder outside the project; from its src folder it names the project's.
      [`${UP}; Set-Location src; git log`],
      [`${UP}; Set-Location src; foreach ($i in 1..2) { git log }`],
      [`${UP}; Set-Location src; & { git log }`],
      [`if ($x) { ${UP} }; Set-Location src; git log`],
      [`${UP}; Set-Location src; bash -c 'git log'`],
      [`${UP}; iex 'Set-Location src'; cmd /c dir; git log`],
      [`${UP}; git log`, 'the relative GIT_DIR names a folder outside the project from the worktree'],
    ]);
  });

  it('reads Start-Process as a working directory for the process it starts, and the git it starts', () => {
    check(ps, [
      ["Start-Process git -ArgumentList '-C','<P>','status'"],
      ["Start-Process git -ArgumentList '-C', '<P>', 'status'"],
      ["Start-Process git '-C','<P>','status'"],
      ["Start-Process -Arg '-C \"<P>\" status' git"],
      ["Start-Process -FilePath git -Args '-C <P> status'"],
      ["Start-Process git -WorkingDirectory '<P>'"],
      ["Start-Process notepad -WorkingDirectory '<P>'"],
      ["Start-Process notepad -Wo '<P>'"],
      ["saps git -ArgumentList '-C','<P>','status'"],
      ["start notepad -WorkingDirectory '<P>'"],
      ['Start-Process git -ArgumentList $a'],
      ['Start-Process $exe'],
      ["Start-Process git -ArgumentList 'log' -Environment @{GIT_DIR='<P><S>.git'}"],
      ["Start-Process pwsh -ArgumentList '-c', \"git -C '<P>' status\""],
      ["Start-Process cmd -ArgumentList '/c', 'git -C <P> status'"],
      ["Set-Location '<P>'; Start-Process notepad"],
    ]);
  });

  it('reads the text Invoke-Expression and nested shells run from PowerShell', () => {
    check(ps, [
      ["Invoke-Expression \"git -C '<P>' status\""],
      ["Invoke-Expression -Command \"git -C '<P>' status\""],
      ["iex 'cd ''<P>'''"],
      ["iex 'cd ..\\..\\..\\..\\..'; cd project; git status"],
      ['iex $s'],
      ["'git status' | iex"],
      ["cmd /c \"git -C <P> status\""],
      ["cmd.exe /c \"cd /d <P> & git status\""],
      ["cmd /c start /d <P> notepad"],
      ['cmd "/cgit -C <P> status"'],
      ["cmd /kgit -C '<P>' status"],
      ["bash -c \"git -C '<P>' status\""],
      ["sh -c \"cd '<FP>' && git add .\""],
      ["pwsh -c \"git -C '<P>' status\""],
      ["powershell -Command \"Set-Location '<P>'\""],
      ["pwsh -NoProfile -co \"git -C '<P>' status\""],
      ["pwsh /c \"git -C '<P>' status\""],
      ["pwsh --command \"git -C '<P>' status\""],
      ["pwsh -wd '<P>' -c 'git status'"],
      ['pwsh -Command -'],
      ['pwsh -c $s'],
      [`pwsh -EncodedCommand ${encoded("git -C '<P>' status")}`],
      [`powershell -enc ${encoded("Set-Location '<P>'")}`],
      ['pwsh -e not*base64'],
    ]);
    expect(bash(`pwsh -EncodedCommand ${encoded("git -C '<P>' status")}`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash("export GIT_DIR=../../../../../../project/.git; cd src; pwsh -c 'git log'")).toContain(WORKTREE_ISOLATION_REASON);
  });

  it('allows ordinary PowerShell', () => {
    const because = 'it stays in the worktree';
    check(ps, [
      ['git status', because],
      ['git -C src log --oneline -5', because],
      ['Set-Location src; git -C .. status', because],
      ["$env:NODE_ENV='test'; npm test", because],
      ['Start-Process notepad', because],
      ["Start-Process npm -ArgumentList 'test' -WorkingDirectory src", because],
      ["Start-Process git -ArgumentList 'status' -NoNewWindow -Wait", because],
      ['Get-ChildItem -Recurse -Filter *.ts | Select-Object -First 5', because],
      ["Select-String -Path src\\*.ts -Pattern 'TODO'", because],
      ['node scripts/build.js --watch', because],
      ['npm run build', because],
      ['npm run test `\n  -- --reporter=dot `\r\n  --bail', because],
      ['& { git status; git log -1 }', because],
      ['foreach ($f in Get-ChildItem src) { git log -1 -- $f.FullName }', because],
      ['try {\n  Push-Location src\n  npm test\n} finally {\n  Pop-Location\n}', because],
      ["$msg = @'\nfix: thing (a, b)\n'@\ngit commit -m $msg", because],
      ["$env:GIT_AUTHOR_NAME='x'; git commit -m y", because],
      ["$env:GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'; git fetch", because],
      ["[Environment]::SetEnvironmentVariable('NODE_ENV', 'test'); npm test", because],
      ['Set-Item env:NODE_ENV production; npm run build', because],
      ['Remove-Item env:GIT_DIR -ErrorAction SilentlyContinue; git status', because],
      ["iex 'Get-Date'", because],
      ['cmd /c dir', because],
      ['bash -c "ls"', because],
      ['pwsh -NoProfile -Command "git status"', because],
      [`pwsh -EncodedCommand ${encoded('git status')}`, because],
      ["git log --format='%h %s' -5 | ForEach-Object { $_.Trim() }", because],
      ['$out = git status --porcelain; if ($out) { Write-Host $out }', because],
      ['Write-Host "branch: $(git branch --show-current)"', because],
      ['$files = @(git ls-files); $files.Count', because],
      ['git diff 2>&1 | Out-File diff.txt', because],
      ["git commit -m 'fix: handle a, b and (c)'", because],
      ['Get-Content package.json | ConvertFrom-Json | Select-Object -ExpandProperty version', because],
      ['@"\nline $(Get-Date)\n"@ | Out-File notes.txt', because],
      ['New-Item -ItemType Directory -Path "$PWD\\out" -Force | Out-Null', because],
      ['[Environment]::CurrentDirectory = "<P>"; git status', 'PowerShell starts native commands in its own location'],
      ["$h = @{ Name = 'x'; Path = 'src' }; $h.Name", because],
      ['$env:GIT_DIR = $null; git status', because],
    ]);
  });

  it('blocks aliases, namerefs, set -k, git.cmd, session-state locations, default parameters and location wildcards', () => {
    check(bash, [
      ["shopt -s expand_aliases\nalias g='git -C <FP>'\ng add .", REACHES],
      ['alias g="$X"'],
      ['declare -n r=GIT_DIR; r=<QP>/.git; export GIT_DIR; git log'],
      ['local -n r=GIT_DIR; r=<QP>/.git; git log'],
      ['typeset -n r=GIT_DIR; r=<QP>/.git; git log'],
      ['declare -gn r=GIT_DIR'],
      ['set -k; git log GIT_DIR=<QP>/.git'],
      ['set -ek; git status'],
      ['set -o keyword; git log GIT_DIR=<QP>/.git'],
      ["bash -k -c 'git log GIT_DIR=<FP>/.git'"],
      ["mapfile -C 'cd <FP>; git add .' -c 1 lines < list.txt"],
      ['alias', 'listing aliases defines none'],
      ['alias -p', 'listing aliases defines none'],
      ['alias ll', 'printing an alias defines none'],
      ['export -n FOO; git status', 'export -n removes the export attribute'],
      ['set -euo pipefail; git status', 'no option sets keyword mode'],
      ['set -- -k; git status', 'after -- the words are positional parameters'],
    ]);
    check(ps, [
      ['git.cmd -C <QP> add .', REACHES],
      ["git.bat -C '<P>' add .", REACHES],
      ["$ExecutionContext.SessionState.Path.SetLocation('<P>'); git add ."],
      ["$host.Runspace.SessionStateProxy.Path.PushCurrentLocation('x')"],
      ["$ExecutionContext.SessionState.Drive.New($d, 'Global')"],
      ["$PSDefaultParameterValues['Set-Location:Path'] = '<P>'; Set-Location; git add ."],
      ['Set-Location <P*>; git add .'],
      ["Set-Location '<P?>'; git add ."],
      ['Push-Location <P*>; git add .'],
      ["Start-Process git -ArgumentList 'add','.' -WorkingDirectory '<P*>'"],
      ["$ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath('x')", 'the method resolves a path and moves nowhere'],
      ["Set-Location -LiteralPath '<W><S>odd[1]'; git status", '-LiteralPath takes no wildcards'],
      ['Get-ChildItem *.ts', 'nothing changes location'],
    ]);
    if (process.platform === 'win32') {
      check(ps, [['git add *.ts', 'Windows PowerShell passes the pattern to git as written']]);
    } else {
      check(ps, [['git -C <P*> add .'], ["git -C '<P*>' status", 'a quoted argument is not globbed']]);
    }
  });

  // Whether bash expands an alias in a row that passes or reaches matches Git Bash 5.3 running the same text with `bash -c`.
  it('reads a literal alias in place of the command word that uses it, where bash expands it', () => {
    const withPrefix = (commandPrefix: string) => (command: string): string | undefined =>
      worktreeIsolationBlock('Bash', { command }, { ...iso, commandPrefix: expand(commandPrefix) });
    const expanding = 'shopt -s expand_aliases\n';
    check(withPrefix("alias ll='ls -la'"), [
      ['git status', 'bash -c expands no alias without expand_aliases'],
      ['cd src && pwd', 'bash -c expands no alias without expand_aliases'],
      ['ll', 'bash -c expands no alias without expand_aliases'],
      ['source ./env.sh && git status', 'the alias does not expand where the file is sourced'],
    ]);
    check(withPrefix(`${expanding}alias ll='ls -la'`), [
      ['ll && git status', 'the alias lists files'],
      ['cd src && ll', 'the alias lists files'],
      ['git -C <QP> log', REACHES],
      ['source ./env.sh', 'a sourced file is not read, whatever it runs'],
    ]);
    check(withPrefix(`${expanding}alias g='git -C <FP>'`), [['g add .', REACHES], ['git status', 'the alias is not used']]);
    check(withPrefix(`${expanding}source ~/.bash_aliases`), [['git status', 'the aliases a file defines are not read']]);
    check(bash, [
      [`${expanding}alias g='git -C <FP>'\ng add .`, REACHES],
      [`${expanding}alias g='git -C <FP>'; g add .`, 'bash reads the whole line before the alias is defined'],
      ["alias g='git -C <FP>'\ng add .", 'bash -c expands no alias without expand_aliases'],
      [`alias g='git -C <FP>'\n${expanding}g add .`, REACHES],
      [`alias g='git -C <FP>'\nshopt -s expand_aliases; g add .`, 'the option is set after the line is read'],
      [`${expanding}alias g='git -C <FP>'\nshopt -u expand_aliases\ng add .`, 'expansion is off again'],
      [`${expanding}alias s='sudo ' g='git -C <FP>'\ns g add .`, REACHES],
      [`${expanding}alias e='echo ' g='git -C <FP>'\ne x g add .`, 'only the word after a text ending in a blank is checked'],
      [`${expanding}alias up='cd ..'\nup; up; up; up; up; cd project && git add .`, REACHES],
      [`${expanding}alias ll='ls -l' ls='git -C <FP> status'\nll`, REACHES],
      [`${expanding}alias ls='ls --color'\nls`, 'an alias is not expanded again inside its own text'],
      [`${expanding}alias cd=echo\ncd <QP> && git add .`, 'the alias runs echo in place of cd'],
      [`${expanding}alias cd=echo; cd <QP> && git add .`, REACHES],
      [`${expanding}alias g='git -C <FP>'\nX=1 g add .`, REACHES],
      [`${expanding}alias g='git -C <FP>'\nif true; then g add .; fi`, REACHES],
      [`${expanding}alias g='git -C <FP>'\ncommand g add .`, 'only a command word is expanded'],
      [`${expanding}alias g='git -C <FP>'\n"g" add .`, 'a quoted word is not expanded'],
      // A substitution, eval and trap text are read when they run, after the definition on their line.
      [`${expanding}alias g='git -C <FP>'; echo "$(g add .)"`, REACHES],
      [`${expanding}alias g='git -C <FP>'; eval 'g add .'`, REACHES],
      [`${expanding}alias g='git -C <FP>'\n(g add .)`, REACHES],
      [`${expanding}alias g='git -C <FP>'; (g add .)`, 'the subshell is read with its line'],
      [`${expanding}for i in 1; do\nalias g='git -C <FP>'\ng add .\ndone`, 'the loop is read whole before it runs'],
      [`${expanding}{\nalias g='git -C <FP>'\n}\ng add .`],
      [`${expanding}unalias -a; git status`, 'removing every alias defines none'],
      [`${expanding}alias cd=echo\nunalias cd\ncd <QP> && git add .`, REACHES],
      [`${expanding}alias cd=echo\nunalias -a\ncd <QP> && git add .`, REACHES],
      ["alias g='git -C <FP>'\nbash -c 'g add .'", 'a child shell starts without aliases'],
      ["sh -c \"alias g='git -C <FP>'\ng add .\"", REACHES],
      ["bash -c \"alias g='git -C <FP>'\ng add .\"", 'bash -c expands no alias without expand_aliases'],
      ["bash -O expand_aliases -c \"alias g='git -C <FP>'\ng add .\"", REACHES],
      ["bash --posix -c \"alias g='git -C <FP>'\ng add .\"", REACHES],
      [`set -o posix\nalias g='git -C <FP>'\ng add .`, REACHES],
      // A change that may not run, or a name or text the command computes, leaves the alias unread.
      [`${expanding}false && alias cd=echo\ncd src`],
      [`${expanding}(alias cd=echo)\ncd src`],
      [`${expanding}eval 'alias cd=echo'\ncd src`],
      [`${expanding}alias cd=echo\nsource ./env.sh\ncd src`],
      ['alias $n=x'],
      ['alias g=$X'],
      ['alias "$n"=x'],
      ['alias -p g=x'],
      ['alias if=echo'],
      [`${expanding}alias g="$(echo x)"`],
      [`${expanding}trap 'g' EXIT; alias g='git -C <FP>'`],
      [`${expanding}alias g='git\n-C <FP>'\ng add .`],
      ['shopt -s $opt\nalias cd=echo\ncd src'],
    ]);
    checkWith('Bash', { POSIXLY_CORRECT: '1' }, "alias g='git -C <FP>'\ng add .", REACHES);
    checkWith('Bash', { BASHOPTS: 'checkwinsize:expand_aliases' }, "alias g='git -C <FP>'\ng add .", REACHES);
    checkWith('Bash', { SHELLOPTS: 'braceexpand:posix' }, "alias g='git -C <FP>'\ng add .", REACHES);
    // A startup file may turn expansion on.
    checkWith('Bash', { BASH_ENV: 'x' }, 'alias cd=echo\ncd src');
    checkWith('Bash', { BASHOPTS: 'checkwinsize' }, "alias g='git -C <FP>'\ng add .", 'expand_aliases is not among the options');
    check(withShell('/bin/sh'), [["alias g='git -C <FP>'\ng add .", REACHES]]);
  });

  it('reads a PowerShell variable set once at the top level as its value, and every other reference as computed', () => {
    check(ps, [
      ["$wt = '<W>'; Set-Location $wt; git status", 'the value is the worktree'],
      ["$wt = '<W>'; git -C $wt status", 'the value is the worktree'],
      ["$wt = '<W>'; Push-Location \"$wt<S>src\"; Pop-Location", 'the string reads the value'],
      ["$WT = '<W>'; Set-Location ${wt}<S>src", 'names match without case, and a bare token is a template'],
      ["$git = 'git'; & $git status", 'the call operator runs git in the worktree'],
      ["$p = '<W>'; $env:GIT_WORK_TREE = $p; git status", 'the environment variable takes the worktree'],
      ["$wt = '<W>'; Start-Process -FilePath 'npm.cmd' -ArgumentList 'ci' -WorkingDirectory $wt -WindowStyle Hidden", 'the process starts in the worktree'],
      ["$env:wt = '<W>'; Set-Location $env:wt", 'an environment variable set once reads as its value'],
      ["$base = '<W>'; $wt = \"$base<S>src\"; Set-Location $wt", 'a value built from a value reads'],
      [". ./x.ps1; $wt = '<W>'; Set-Location $wt", 'the value is set after the dot-sourced file'],
      ["Set-Location $wt; $wt = '<W>'"],
      ["$wt = '<W>'; Set-Location $wt; $wt = '<P>'; Set-Location $wt"],
      ["$wt = '<W>'; foreach ($i in 1,2) { Set-Location $wt; $wt = '<P>' }"],
      ["if ($x) { $wt = '<W>' }; Set-Location $wt"],
      ["$wt = '<W>' | Out-Null; Set-Location $wt"],
      ["$wt = '<W>' && '<P>'; Set-Location $wt"],
      ["$wt = '<W>'; Set-Variable ('w'+'t') '<P>'; Set-Location $wt"],
      ["$wt = '<W>'; New-Variable -Name ('w'+'t') -Value '<P>' -Force; Set-Location $wt"],
      ["$wt = '<W>'; Set-Item variable:wt '<P>'; Set-Location $wt"],
      ["$wt = '<W>'; '<P>' | Tee-Object -Variable wt; Set-Location $wt"],
      ["$wt = '<W>'; sv wt '<P>'; Set-Location $wt"],
      ["$wt = '<W>'; Get-Item x -ov wt; Set-Location $wt"],
      ["$wt = '<W>'; Get-Item x -OutVariable:wt; Set-Location $wt"],
      ["$wt = '<W>'; Get-Item x -ev +wt; Set-Location $wt"],
      ["$n = 'wt'; $wt = '<W>'; Get-Item x -PipelineVariable $n; Set-Location $wt"],
      ["$wt = '<W>'; f ([ref]$wt); Set-Location $wt"],
      ["function f($wt) { Set-Location $wt }; $wt = '<W>'; f '<P>'"],
      ["& { param($wt) Set-Location $wt } '<P>'"],
      ["$script:wt = '<P>'; $wt = '<W>'; Set-Location $wt"],
      ["$global:wt = '<P>'; $wt = '<W>'; Set-Location $wt"],
      ["$wt = '<W>'; $wt += '<S><UP>'; Set-Location $wt"],
      ["$wt = '<W>'; $wt++; Set-Location $wt"],
      ["$a = $wt = '<P>'; Set-Location $wt"],
      ["$wt = '<W>'; $a = $wt = '<P>'; Set-Location $wt"],
      ["$wt = '<W>'; $wt, $b = '<P>', 1; Set-Location $wt"],
      ["$wt = '<W>'; trap { $wt = '<P>' }; Set-Location $wt"],
      ["$wt = '<W>'; iex \"`$wt = '<P>'\"; Set-Location $wt"],
      ["$wt = '<W>'; . ./x.ps1; Set-Location $wt"],
      ["$wt = '<W>'; Import-Module ./m.psm1; Set-Location $wt"],
      ["$wt = '<W>'; $f = { Set-Location $wt }; . ./x.ps1; Invoke-Command $f"],
      ["$wt = '<W>'; $p = @{ OutVariable = 'wt' }; Get-Item x @p; Set-Location $wt"],
      ["$env:wt = '<W>'; Remove-Item env:wt; Set-Location $env:wt"],
      ["$h = @{ a = 1 }; Set-Location $h"],
      ["$x = { '<W>' }; Set-Location $x"],
      ['$n = 0x10; Set-Location $n'],
      ["$wt = '<W>'; Set-Location $wt.Parent"],
      ["$wt = '<W>'; Set-Location \"$wt:x\""],
      ["$wt = '<W>'; Set-Location \"$wt?\""],
      ["$wt = '<W>'; Set-Location -Path:$wt.Parent"],
      ["$1 = '<P>'; Set-Location $1; git add .", REACHES],
      ["$wt = \"<W><S>..<S>..<S>..<S>..<S>..<S>proj`u{65}ct\"; Set-Location $wt; git add ."],
      // A site found only in text walked after a read invalidates the first pass, and the second reads the name as computed.
      ["$n = 'w'; $wt = '<W>'; foreach ($i in 1,2) { Set-Location $wt; iex \"`$${n}t = '<UP>'\" }; git add ."],
      ["$v = 'Variable'; $wt = '<W>'; foreach ($i in 1,2) { Set-Location $wt; iex \"Set-$v wt '<UP>'\" }; git add ."],
    ]);
    for (const command of [
      "$p = '<P>'; Set-Location $p",
      "$p = '<P>'; git -C \"$p\" add .",
      "$p = '<P>'; $env:GIT_DIR = \"$p<S>.git\"; git log",
      "$p = '<P>'; Start-Process git -ArgumentList '-C', $p, 'add', '.'",
      "$p = '<P>'; git --git-dir \"$p<S>.git\" log",
    ]) {
      const result = ps(expand(command));
      expect(result, command).toContain('the project folder');
      // A reason names the word as written, never a value read from it.
      expect(result, command).not.toContain(project);
    }
  });

  it('reads a bash variable set once at the top level as its value, and every other reference as computed', () => {
    check(bash, [
      ['wt=<QW>; cd "$wt" && git status', 'the value is the worktree'],
      ['wt=src; cd $wt && git status', 'an unquoted value that is one plain word reads'],
      ['wt=<QW>; cd -- "$wt"/src && git status', 'the word is a template'],
      ['base=<QW>; wt="$base/src"; git -C "$wt" status', 'a value built from a value reads'],
      ['export WT=<QW>; cd "$WT"', 'an option-free export defines'],
      ['IFS=/; wt=<QW>; cd "$wt"', 'a quoted reference is not split'],
      ['source ./env.sh; wt=<QW>; cd "$wt" && git status', 'the value is set after the sourced file'],
      ['p=<QP>; cd "$p" && git add .', REACHES],
      ['p=<UP>; cd $p && git add .', REACHES],
      ['g=git; $g -C <QP> add .', REACHES],
      // eval parses the value again, and bash drops a Windows path's backslashes there.
      ['p=<FP>; eval "cd $p"; git add .', REACHES],
      ['p=<QP>; bash -c "cd \'$p\' && git add ."', REACHES],
      ['K="x; git -C <FP> add ."; GIT_SSH_COMMAND="ssh -i $K" git push', REACHES],
      ['cd "$wt"; wt=<QW>'],
      ['wt=<QW>; cd "$wt"; wt=<QP>; cd "$wt" && git add .'],
      ['wt=<QW>; for i in 1 2; do cd "$wt" && git add .; wt=<QP>; done'],
      ['[ -n "$X" ] && wt=<QW>; cd "$wt"'],
      ['if true; then wt=<QW>; fi; cd "$wt"'],
      ['(wt=<QW>); cd "$wt"'],
      ['echo | wt=<QW>; cd "$wt"'],
      ['wt=<QW> | cat; cd "$wt"'],
      ['wt=<QW> &; cd "$wt"'],
      ['wt=<QW> true; cd "$wt"'],
      ['wt=<QW>; declare "w""t=<FP>"; cd "$wt"'],
      ["wt=<QW>; eval 'w''t=<FP>'; cd \"$wt\""],
      ['wt=<QW>; read "w""t" <<< <QP>; cd "$wt"'],
      ['wt=<QW>; printf -v wt %s <QP>; cd "$wt"'],
      ['wt=<QW>; unset wt; cd "$wt"'],
      ['wt=<QW>; wt[0]=<FP>; cd "$wt"'],
      ["wt=<QW>; y='wt=1'; echo $((y)); cd \"$wt\""],
      ['wt=<QW>; (( n = 1 )); cd "$wt"'],
      [': "${wt2:=<P>}"; cd "$wt2"'],
      ["trap 'wt=<FP>' DEBUG; wt=<QW>; cd \"$wt\" && git add ."],
      ['wt=<QW>; for wt in <QP>; do :; done; cd "$wt"'],
      ['wt=<QW>; source ./env.sh; cd "$wt"'],
      ['IFS=/; wt=a/b; cd $wt'],
      ["wt='src*'; cd $wt"],
      ["wt='~/x'; cd $wt"],
      ["wt=''; cd $wt"],
      ['wt=a/b; cd $wt; IFS=/'],
      ['wt=<QW>; export "w""t=<FP>"; cd "$wt"'],
      ['wt=<QW>; wait -p wt; cd "$wt"'],
      ['wt=<QW>; declare -u wt; cd "$wt"'],
      ['{ wt=<QW>; }; cd "$wt"'],
      ['a=1 && b=2 || wt=<QW>; cd "$wt"'],
      // A site found only in text walked after a read invalidates the first pass, and the second reads the name as computed.
      ['n=w; wt=<QW>; cd "$wt"; eval "${n}t=<UP>"; git add .'],
      ['n=K; eval "$n=x"; GIT_SSH_COMMAND="ssh -i $K" git push'],
      ['wt=<QW>; x=$(cd "$wt" && git status); cd "$wt" && git status', 'a substitution reads its shell\'s values'],
      ['wt=<QW> && cd "$wt" && git status', 'the assignment before && runs once'],
      ['d=src; bash -c "cd $d && git status"', 'the parent reads its value into the child\'s text'],
      ['K=x; GIT_SSH_COMMAND="ssh -i $K" git push', 'the command variable reads the value'],
    ]);
    for (const command of ['p=<QP>; cd "$p" && git add .', 'p=<UP>; cd $p && git add .', 'p=<QP>; git --git-dir "$p/.git" log']) {
      const result = bash(expand(command));
      expect(result, command).toContain('the project folder');
      // A reason names the word as written, never a value read from it.
      expect(result, command).not.toContain(project);
    }
  });

  it('gives a substitution, and a program a wrapper starts, its own copy of the variables and the directory stack', () => {
    check(bash, [
      ['wt=<QW>; v=$(source ./env.sh; echo hi); cd "$wt" && git status', 'the file runs in the substitution\'s shell'],
      ['for d in src docs; do v=$(source ./env.sh; echo x); git -C "$d" status; done', 'the file runs in the substitution\'s shell'],
      ["export d=src; v=$(source ./env.sh; echo x); bash -c 'cd \"$d\" && pwd'", 'the file runs in the substitution\'s shell'],
      ['wt=<QW>; nice source ./env.sh; cd "$wt" && git status', 'nice starts a program named source'],
      ['v=$(pushd src); popd; git status', 'the substitution pushes onto its own stack'],
      ['p=<QP>; v=$(source ./env.sh); cd "$p" && git add .', REACHES],
      ['for d in src <QP>; do v=$(source ./env.sh); git -C "$d" add .; done', REACHES],
      ['v=$(cd src); git -C <UP> add .', REACHES],
      ['wt=<QW>; source ./env.sh; v=$(cd "$wt"); git status'],
    ]);
  });

  it('reads text a runner hands a shell with each word it does not give as computed, never as a variable', () => {
    check(bash, [
      ['x=src; watch git -C "$(cat f)" status'],
      ['export x=src; parallel git -C {} status ::: a'],
      ['export x=src; parallel git -C ::: a'],
      ["x=src; env -S 'git -C' -- \"$(cat f)\" status"],
      ['export x=src; watch -n 1 -- "$(cat f)"'],
      ['export x=src; cross-env-shell echo "$(cat f)"'],
      ['watch -n 5 git status', 'watch runs git in the worktree'],
      ['parallel echo {} ::: a b', 'parallel quotes each input'],
    ]);
    checkWith('Bash', { x: worktree }, 'parallel git -C {} status ::: a');
    checkWith('Bash', { x: worktree }, 'watch git -C "$(cat f)" status');
  });

  // Each prints its version or help and exits without reading a command, as Git Bash 5.3, pwsh 7.6, Windows PowerShell 5.1 and cmd do.
  it('reads a shell asked for its version or help as running nothing', () => {
    check(bash, [
      ['bash --version | head -1', 'bash prints its version'],
      ['sh --version', 'sh prints its version'],
      ['bash --help', 'bash prints its help'],
      ['bash --login --version', 'bash prints its version'],
      ["bash -c 'git -C <FP> add .' --version", REACHES],
      ["bash -eo pipefail -c 'git -C <FP> add .'", REACHES],
      ['bash -- --version', 'the operand names a script file, which is not read'],
    ]);
    check(ps, [
      ['pwsh -Version', 'pwsh prints its version'],
      ['pwsh -v', 'pwsh prints its version'],
      ["pwsh -NoProfile -Version -Command \"git -C '<P>' add .\"", 'pwsh prints its version'],
      // pwsh on Linux and macOS globs an unquoted native argument, so there `-?` names whatever files match it.
      ...(process.platform === 'win32' ? [['pwsh -?', 'pwsh prints its help'] as const] : [["pwsh '-?'", 'pwsh prints its help'] as const, ['pwsh -?'] as const]),
      ['pwsh -Help', 'pwsh prints its help'],
      ['powershell -Help', 'Windows PowerShell prints its help'],
      ["powershell -Version 5.1 -NoProfile -Command \"git -C '<P>' add .\"", REACHES],
      ["pwsh -NoProfile -Command \"git -C '<P>' add .\" -Version", REACHES],
      // cmd is a Windows program, and pwsh elsewhere globs `/?`.
      ...(process.platform === 'win32' ? [['cmd /?', 'cmd prints its help'] as const, ['cmd /d /? /c "git -C <P> add ."', 'cmd prints its help'] as const] : []),
    ]);
  });

  it('reads the starting environment and what each child inherits, and computes what startup files may set', () => {
    check(ps, [
      ['Set-Location $env:TEMP; Get-ChildItem', 'TEMP is a folder outside the project'],
      ["$env:wt = '<W>'; Set-Location $env:wt", 'the value is set once'],
      ["$env:wt = '<W>'; bash -c 'cd \"$wt\" && git status'", 'the child inherits the value'],
      ["$env:wt = '<W>'; pwsh -NoProfile -Command 'Set-Location $env:wt'", 'the child inherits the value'],
      ["$wt = '<W>'; ./build.ps1; Set-Location $wt", 'a script file leaves plain variables alone'],
      // A block that runs where it stands holds nothing a script file may run later.
      ["$wt = '<W>'; if ($true) { 'x' }; ./build.ps1; Set-Location $wt", 'a script file leaves plain variables alone'],
      ["Set-Location $env:TEMP; if ($true) { 'x' }; ./build.ps1", 'TEMP is read before the script file'],
      ["$wt = '<W>'; foreach ($i in 1,2) { 'x' }; ./build.ps1; Set-Location $wt", 'a script file leaves plain variables alone'],
      ["$wt = '<W>'; 1..2 | ForEach-Object { 'x' }; ./build.ps1; Set-Location $wt", 'a script file leaves plain variables alone'],
      ["$wt = '<W>'; try { 'x' } finally { 'y' }; ./build.ps1; Set-Location $wt", 'a script file leaves plain variables alone'],
      ["$p = '<P>'; if ($true) { 'x' }; ./build.ps1; Set-Location $p; git add .", REACHES],
      ["$env:wt = '<W>'; Register-EngineEvent x -Action { Set-Location $env:wt }; ./setup.ps1"],
      ["$env:wt = '<W>'; $h = @{ a = { Set-Location $env:wt } }; ./setup.ps1; Invoke-Command -ScriptBlock $h.a"],
      ["$env:wt = '<W>'; $f = & { { Set-Location $env:wt } }; ./setup.ps1; Invoke-Command $f"],
      ["$env:wt = '<W>'; npm ci; Set-Location $env:wt", 'a bare name is a program'],
      ['Set-Location $env:NO_SUCH_VARIABLE'],
      ["$wt = '<W>'; Set-Location $env:wt"],
      ["$env:wt = '<W>'; Set-Location $wt"],
      ["$env:wt = '<W>'; wsl -- cd \"$wt\""],
      ["$env:wt = '<W>'; wsl -- cd '\"$wt\"'"],
      ["if ($x) { $env:wt = '<W>' }; Set-Location $env:wt"],
      ["$env:wt = '<W>'; $env:wt = '<P>'; bash -c 'cd \"$wt\" && git add .'"],
      ["$env:wt = '<W>'; pwsh -Command 'Set-Location $env:wt'"],
      ["$env:wt = '<W>'; ./setup.ps1; Set-Location $env:wt"],
      ["& 'tools\\env.PS1'; Set-Location $env:TEMP"],
      ["$env:wt = '<W>'; ./setup.ps1; bash -c 'cd \"$wt\"'"],
      ["$env:wt = '<W>'; $f = { Set-Location $env:wt }; ./setup.ps1; Invoke-Command $f"],
      ["$env:d = 'src'; Start-Process bash -ArgumentList '-c \"cd $d && git status\"'", 'the started process inherits the value'],
      ["$env:d = 'src'; Start-Process bash -ArgumentList '-c \"cd $d && git status\"' -UseNewEnvironment"],
      ["$env:d = 'src'; Start-Process bash -ArgumentList '-c \"cd $d && git status\"' -Verb RunAs"],
    ]);
    check(bash, [
      ['cd "$TEMP" && git status', 'TEMP is a folder outside the project'],
      ["export d=src; bash -c 'cd \"$d\" && git status'", 'the child inherits the exported value'],
      ["TEMP=<QW>; bash -c 'cd \"$TEMP\" && git status'", 'an inherited name reassigned is exported'],
      ["export d=src; pwsh -NoProfile -Command 'Set-Location $env:d; git status'", 'the child inherits the exported value'],
      ["d=src; export d; bash -c 'cd \"$d\"'"],
      ["export d=<QP>; bash -c 'cd \"$d\" && git add .'", REACHES],
      ["[ -n \"$X\" ] && export d=src; bash -c 'cd \"$d\"'"],
      ["export d=src; export -n d; bash -c 'cd \"$d\"'"],
      ["d=src; bash -c 'cd \"$d\"'"],
      ['source ~/.profile; cd "$PROJ"'],
      ["export d=src; bash -l -c 'cd \"$d\"'"],
      ["export d=src; bash -ic 'cd \"$d\"'"],
      ["export d=src; bash --login -c 'cd \"$d\"'"],
      ["export d=src; zsh -c 'cd \"$d\"'"],
      // zsh's and ksh's two-operand cd replaces part of the directory, and fish sets variables its own way.
      ["zsh -c 'cd aaaaaaaa ../project; git add .'"],
      ["ksh -c 'cd aaaaaaaa ../project; git add .'"],
      ["mksh -c 'git status'"],
      ["fish -c 'set -x GIT_DIR <FP>/.git; git log'"],
      ["tcsh -c 'git status'"],
      ['zsh --version', 'zsh prints its version and runs nothing'],
      ["dash -c 'git status'", 'dash reads as bash'],
      ["export d=src; sudo bash -c 'cd \"$d\"'"],
      ["export d=src; env -i bash -c 'cd \"$d\"'"],
      ["export d=src; pwsh -Command 'Set-Location $env:d'"],
    ]);
    checkWith('Bash', { CDPATH: base }, 'cd project && git add .', REACHES);
    checkWith('Bash', { GIT_DIR: path.join(project, '.git') }, 'git log', REACHES);
    checkWith('PowerShell', { GIT_DIR: path.join(project, '.git') }, 'git log', REACHES);
    checkWith('Bash', { PROJ: project }, 'cd "$PROJ" && git add .', REACHES);
    checkWith('PowerShell', { PROJ: project }, 'Set-Location $env:PROJ; git add .', REACHES);
    // Git Bash imports TEMP in POSIX form, so text that parses it again sees the path, not a Windows path whose `\` it drops.
    checkWith('Bash', { TEMP: project }, 'eval "cd $TEMP"; git add .', REACHES);
    checkWith('Bash', { TEMP: project }, 'bash -c "cd $TEMP && git add ."', REACHES);
    checkWith('Bash', { BASH_ENV: 'x' }, "export d=src; bash -c 'cd \"$d\"'");
    checkWith('Bash', { BASH_ENV: 'x' }, 'cd "$TEMP"');
    // Only an interactive shell reads ENV: bash -c and sh -c never do, and -i is a startup barrier of its own.
    checkWith('Bash', { ENV: 'x' }, 'cd "$TEMP" && git status', 'the tool runs bash -c, which never reads ENV');
    checkWith('Bash', { ENV: 'x' }, "export d=src; sh -c 'cd \"$d\" && git status'", 'sh -c is not interactive, so it never reads ENV');
    checkWith('Bash', { ENV: 'x' }, "export d=src; sh -i -c 'cd \"$d\"'");
    checkWith('PowerShell', { BASH_ENV: 'x' }, "$env:wt = '<W>'; bash -c 'cd \"$wt\"'");
    // pi sets PATH and its session variables per call, so the check cannot know them.
    checkWith('Bash', { PI_SESSION_FILE: undefined }, 'cd "$PI_SESSION_FILE/.." && git status');
    checkWith('PowerShell', { PI_SESSION_FILE: undefined }, 'Set-Location $env:PI_SESSION_FILE; git status');
    checkWith('Bash', { PI_MODEL: undefined }, 'echo "$PI_MODEL" && git status', 'echo is not a cd or git target');
    if (process.platform === 'win32') checkWith('PowerShell', { WT: worktree }, "$env:wt = '<W>'; bash -c 'cd \"$wt\"'");
    expect(withEnvironment('Bash', { CDPATH: base })('cd src && git status')).toBeUndefined();
    expect(withEnvironment('PowerShell', { PROJ: project })("Set-Location $env:TEMP; git status")).toBeUndefined();
  });

  // pi's bash tool runs its `shellPath` with -c, and WSL's System32 bash.exe with the command on stdin.
  it('starts from what the configured shell starts with, and blocks a shell whose text does not read as bash', () => {
    // Each passes when read as bash: fish's `set -x` and tcsh's `setenv` export, and zsh's and ksh's two-operand cd swaps part of $PWD.
    const unread: Row[] = [
      ['git status'],
      ['ls'],
      ['set -x GIT_DIR <QP>/.git; git log'],
      ['setenv GIT_DIR <QP>/.git; git log'],
      ['cd aaaaaaaa ../project; git add .'],
    ];
    for (const shell of ['/usr/bin/zsh', '/usr/bin/fish', '/bin/tcsh', '/bin/csh', '/bin/ksh', '/bin/mksh', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', '/usr/bin/nu', 'C:\\Windows\\System32\\cmd.exe']) {
      check(withShell(shell), unread);
      expect(withShell(shell)('git status')).toContain('whose commands this check cannot read. Use the PowerShell tool, or set shellPath to bash.');
    }
    for (const shell of ['/bin/bash', '/bin/sh', '/usr/bin/dash', '/bin/ash', GIT_BASH]) {
      check(withShell(shell), [
        ['cd "$X" && git status', 'X is unset, so the cd stays in the worktree'],
        ['cd "$TEMP" && git status', 'TEMP is a folder outside the project'],
      ]);
    }
    for (const shell of ['C:\\Windows\\System32\\bash.exe', 'C:\\WINDOWS\\Sysnative\\BASH.EXE']) {
      check(withShell(shell), [
        ['cd "$TEMP" && git status'],
        ['cd ~ && git status'],
        ['cd "$X" && git status'],
        ['d=src; cd "$d" && git status', 'a value set in the command reads'],
        ['git status', 'git runs in the worktree'],
      ]);
    }
    expect(withEnvironment('Bash', {})('cd "$X" && git status')).toBeUndefined();
  });

  it('reads ~ and HOME as every home the shell may have, and PWD as its one current directory', () => {
    check(bash, [
      ['cd ~ && git status', '~ is the home folder'],
      ['cd && git status', 'cd goes to the home folder'],
      ['cd "$HOME" && git status', 'HOME is the home folder'],
      ['git -C "$PWD" status', 'PWD is the worktree'],
      ["HOME=/tmp/h bash -c 'cd ~ && git status'", "the child's home is /tmp/h"],
      ['x=~/src; cd "$x" && git status', 'the assignment expands ~ to the home folder'],
      ['pushd src && pushd && git status', 'pushd swaps with a folder in the worktree'],
      ['HOME=<QP>; cd ~ && git add .'],
      ['export HOME=<QP>; cd; git add .'],
      ["HOME=<QP> bash -c 'cd ~ && git add .'", REACHES],
      ["env HOME=<QP> bash -c 'cd ~ && git add .'", REACHES],
      ['HOME=<QP> cd && git add .', REACHES],
      ['cd "$HOME/../project" && git add .', REACHES],
      ['cd ~/../project && git add .', REACHES],
      ['x=~; cd "$x/../project" && git add .', REACHES],
      ['read HOME <<< x; cd ~'],
      ['printf -v HOME %s <QP>; cd ~'],
      ['for HOME in <QP>; do cd ~; git add .; done'],
      ['unset HOME; cd ~'],
      ['(( HOME = 1 )); cd ~'],
      [': "${HOME:=<P>}"; cd ~ && git add .'],
      ['source ./env.sh; cd ~'],
      ["HOME=<QP> GIT_SSH_COMMAND='cd ~ && git add .' git fetch"],
      ['PWD=<QP>; git -C "$PWD" add .'],
      ['cd src; git -C "$PWD" status'],
    ]);
    check(ps, [
      ['Set-Location $HOME; git status', '$HOME is the home folder'],
      ['git -C "$PWD" status', '$PWD is the worktree'],
      ['Set-Location ~', '~ is the home folder'],
      ['New-Item -ItemType Directory -Path "$PWD<S>out"', '$PWD is the worktree'],
      ["$HOME = '<P>'; Set-Location $HOME; git status", '$HOME is read-only, so it keeps the home folder'],
      ["$env:HOME = '<P>'; bash -c 'cd ~ && git add .'"],
      ['Set-Location src; git -C "$PWD" status'],
      ["$PWD = '<P>'; git -C \"$PWD\" add ."],
    ]);
    checkWith('Bash', { HOME: project }, 'cd ~ && git add .', REACHES);
    checkWith('Bash', { HOME: project }, 'cd; git add .', REACHES);
    checkWith('PowerShell', { HOME: project }, "bash -c 'cd ~ && git add .'", REACHES);
    // bash expands `~` after an assignment's `=` and each unquoted `:`, and cd expands it in a CDPATH entry.
    checkWith('Bash', { HOME: base }, 'CDPATH=.:~; cd project && git add .', REACHES);
  });

  it('follows loop bodies and script blocks until what they reach stops growing, and a short list once per item', () => {
    const items = (count: number): string => Array.from({ length: count }, (_, k) => `d${k}`).join(' ');
    check(bash, [
      ['for d in src docs; do (cd "$d" && ls); done', 'each item is a folder in the worktree'],
      ['for d in src docs; do git -C "$d" status; done', 'each item is a folder in the worktree'],
      ['for f in *.ts; do git add "$f"; done', 'git adds files in the worktree'],
      ['while [ ! -d .git ]; do cd ..; done; git status', 'no folder above the worktree is protected'],
      ['for d in "src" ~/x; do cd "$d"; done; git status', 'every item is outside the project'],
      ['for d in; do cd <QP>; done; git status', 'an empty list runs the body no times'],
      ['for i in 1 2 3 4 5 6; do cd ..; done; cd project && git add .', REACHES],
      ['while true; do cd ..; done; cd project; git add .', REACHES],
      ['until false; do cd ..; done; cd project; git add .', REACHES],
      ['for d in src <QP>; do git -C "$d" add .; done', REACHES],
      ['for d in src docs; do d=<QP>; cd "$d"; done'],
      ['while :; do pushd src; done; git status'],
      // The stack grows on every walk while the directories stay put, so the loop never settles and they become unknown.
      ['while :; do pushd .; done; git status'],
      ['for d in src; do :; done; cd "$d"'],
      ['for d in $X; do cd "$d"; done'],
      ['for d in $(echo src); do cd "$d"; done'],
      ['for d in src; do source ./env.sh; cd "$d"; done'],
      ['while :; do cd ~; HOME=<QP>; done'],
      ['for i in 1 2; do cd ~; eval "HOME=<FP>"; done'],
      ["while :; do trap 'echo x' EXIT; done; git status", 'setting the same trap again adds nothing'],
      ['for CDPATH in <QB>; do cd project; done', REACHES],
      ['done; git status'],
      ['for d in src; do git status'],
      // After an assignment or a redirection a reserved word is a command name, so the body runs on to the real done.
      ['for f in 1 2 3 4 5; do X=1 done; cd ..; X=1 for y; done; cd project && git add .', REACHES],
      ['for f in 1 2 3 4 5; do >/dev/null done; cd ..; >/dev/null for y; done; cd project && git add .', REACHES],
      ['for f in 1 2 3 4 5; do X=1 done; cd ..; X=1 while :; done; cd project && git add .', REACHES],
      ['for f in 1 2 3 4 5; do 2>&1 done; cd ..; done; cd project && git add .', REACHES],
      ['for d in src; do cd "$d"; done < <(git -C <UP> add .)', REACHES],
      ['while read l; do :; done <<EOF\n$(git -C <QP> add .)\nEOF', REACHES],
    ]);
    // A closing word after an assignment or redirection closes nothing, so D may keep the project folder it starts with.
    checkWith('Bash', { D: project }, 'D=src; cd "$D" && git status', 'D is set once at the top level');
    checkWith('Bash', { D: project }, 'if false; then X=1 fi; D=src; fi; cd "$D" && git add .');
    checkWith('Bash', { D: project }, 'true || { X=1 }; D=src; }; cd "$D" && git add .');
    checkWith('Bash', { D: project }, 'true || { >/dev/null }; D=src; }; cd "$D" && git add .');
    expect(bash(`for d in ${items(33)}; do git -C "$d" status; done`)).toContain('computed');
    expect(bash(`for d in ${items(32)}; do git -C "$d" status; done`)).toBeUndefined();
    expect(bash(`for a in ${items(20)}; do for b in ${items(20)}; do :; done; done`)).toContain('loop');
    check(ps, [
      ["foreach ($d in 'src','docs') { Push-Location $d; git status; Pop-Location }", 'each item is a folder in the worktree'],
      ['1..3 | ForEach-Object { git status }', 'git runs in the worktree'],
      ['if ($x) { Set-Location src }; git status', 'the block runs once'],
      ['try {\n  Push-Location src\n  npm test\n} finally {\n  Pop-Location\n}', 'each block runs once'],
      ['try\n{\n  Push-Location src\n}\nfinally\n{\n  Pop-Location\n}', 'each block runs once'],
      ['& { Set-Location src }; . { Set-Location src }; git status', 'each block runs once'],
      ['foreach ($i in 1..6) { Set-Location .. }; Set-Location project; git add .', REACHES],
      ['function up { Set-Location .. }; up; up; up; up; up; Set-Location project; git add .', REACHES],
      ['function UP { Set-Location .. }; up; Set-Location project; git add .', REACHES],
      ['1..6 | ForEach-Object { Set-Location .. }; Set-Location project; git add .', REACHES],
      ['do { Set-Location .. } while ($true); Set-Location project; git add .', REACHES],
      ['while ($true) { Set-Location src }'],
      ['while ($true) { Push-Location . }; git status'],
      ["foreach ($d in 'src', '<P>') { git -C $d add . }", REACHES],
      ["foreach ($d in 'src') { $d = '<P>'; Set-Location $d }"],
      ["foreach ($d in 'src') { }; Set-Location $d"],
      ['Invoke-Command -ScriptBlock { Set-Location .. }; Set-Location project', REACHES],
    ]);
    const nest = path.join(base, 'nest');
    fs.mkdirSync(path.join(nest, 'wt'), { recursive: true });
    // The body runs where the call stands: from the worktree's parent, src is the project, which the definition never reaches.
    const nested = { ...iso, workingFolder: path.join(nest, 'wt'), projectPath: path.join(nest, 'src'), repositoryRoot: path.join(nest, 'src') };
    expect(worktreeIsolationBlock('PowerShell', { command: 'function down { Set-Location src }; Set-Location ..; down; git add .' }, nested)).toContain(WORKTREE_ISOLATION_REASON);
    expect(ps(`foreach ($a in ${items(20).split(' ').map((d) => `'${d}'`).join(',')}) { foreach ($b in ${items(20).split(' ').map((d) => `'${d}'`).join(',')}) { } }`)).toContain('loop');
  });

  const loopItems = (count: number, quote = ''): string[] => Array.from({ length: count }, (_, k) => `${quote}d${k}${quote}`);

  // From the worktree <UP> is the project; from its src folder it is a folder outside every protected area.
  it('walks a loop body that returns to where it started once per item, at every count up to the item limit', () => {
    for (const count of [4, 6, 16, 32]) {
      const words = loopItems(count).join(' ');
      check(bash, [
        [`for d in ${words}; do pushd "$d" && pwd; popd; done; git status`, 'each pass returns to the worktree'],
        [`for d in ${words}; do (cd "$d" && npm test); done; git status`, 'each subshell leaves the worktree as it was'],
      ]);
      check(ps, [[`foreach ($d in ${loopItems(count, "'").join(',')}) { Push-Location $d; pwd; Pop-Location }; git status`, 'each pass returns to the worktree']]);
    }
    const words = loopItems(32).join(' ');
    check(bash, [
      [`for d in ${words}; do pushd "$d" && pwd; popd; done; cd <UP> && git add .`, REACHES],
      [`for d in ${words}; do (cd "$d" && npm test); done; cd <UP> && git add .`, REACHES],
      [`for d in ${loopItems(31).join(' ')} <QP>; do pushd "$d" && git status; popd; done`, REACHES],
      [`for d in ${loopItems(4).join(' ')}; do cd "$d" && pwd && cd ..; done; git status`, 'four passes leave 16 possible folders'],
    ]);
    check(ps, [
      [`foreach ($d in ${loopItems(32, "'").join(',')}) { Push-Location $d; pwd; Pop-Location }; Set-Location <UP>; git add .`, REACHES],
      [`foreach ($d in ${loopItems(31, "'").join(',')},'<P>') { Push-Location $d; git status; Pop-Location }`, REACHES],
    ]);
    // A body whose cd stays deep where a command fails really can end anywhere, so the reason names the form that cannot.
    for (const command of [`for d in ${loopItems(6).join(' ')}; do cd "$d" && pwd && cd ..; done; git status`, `for d in ${loopItems(6).join(' ')}; do cd "$d"; done; git status`]) {
      const result = bash(command);
      expect(result, command).toMatch(/working directory (?:of this git command )?cannot be read/);
      expect(result, command).toContain('subshell, at a loop body\'s top level or in an `if` branch inside it');
    }
    const grown = ps(`foreach ($d in ${loopItems(6, "'").join(',')}) { Set-Location $d; Set-Location .. }; git status`);
    expect(grown).toContain('The working directory cannot be read.');
    expect(grown).toContain('Push-Location and Pop-Location, at a loop body\'s top level or in an `if` branch inside it');
  });

  // Read as commands that may each run alone, six items' branches leave more places than the check follows.
  it('runs an `if` branch whole or not at all, so a pair that returns inside a branch of a loop body leaves the places as they were', () => {
    for (const count of [6, 32]) {
      const words = loopItems(count).join(' ');
      const quoted = loopItems(count, "'").join(',');
      check(bash, [
        [`for d in ${words}; do if [ -d "$d" ]; then pushd "$d"; pwd; popd; fi; done; git status`, 'each branch returns to the worktree'],
        [`for d in ${words}; do if [ "$d" = d0 ]; then pushd "$d"; pwd; popd; elif [ -d "$d" ]; then pushd "$d"; popd; else pushd "$d"; ls; popd; fi; done; git status`, 'each branch returns to the worktree'],
        [`for d in ${words}; do if [ -d "$d" ]; then pushd "$d"; if [ -d lib ]; then pushd lib; git status; popd; fi; popd; fi; done; git status`, 'the inner pair returns to the outer one'],
        [`for d in ${words}; do if [ -d "$d" ]; then (cd "$d" && npm test); fi; done; git status`, 'each subshell leaves the worktree as it was'],
        [`for d in ${words}; do if [ -d "$d" ]; then pushd "$d"; pwd; popd; fi > /dev/null; done; git status`, 'the branch with its redirection returns to the worktree'],
      ]);
      check(ps, [
        [`foreach ($d in ${quoted}) { if (Test-Path $d) { Push-Location $d; (Get-Location).Path | Split-Path -Leaf; Pop-Location } }; git status --short`, 'each branch returns to the worktree'],
        [`foreach ($d in ${quoted}) { if ($d -eq 'd0') { Push-Location $d; pwd; Pop-Location } elseif (Test-Path $d) { Push-Location $d; Pop-Location } else { Push-Location $d; ls; Pop-Location } }; git status`, 'each branch returns to the worktree'],
        [`foreach ($d in ${quoted}) { if (Test-Path $d) { Push-Location $d; if (Test-Path lib) { Push-Location lib; git status; Pop-Location }; Pop-Location } }; git status`, 'the inner pair returns to the outer one'],
        // PowerShell reads the keyword before a `(` with no space as `if` and `elseif`.
        [`foreach ($d in ${quoted}) { if($true){ Push-Location $d; Pop-Location } }; git status`, 'each branch returns to the worktree'],
        [`foreach ($d in ${quoted}) { if ($d -eq 'd0') { } elseif(Test-Path $d){ Push-Location $d; Pop-Location } }; git status`, 'each branch returns to the worktree'],
      ]);
    }
    const words = loopItems(6).join(' ');
    const quoted = loopItems(6, "'").join(',');
    check(bash, [
      ['if x; then cd src && git -C <UP> status; fi', 'git runs only where the cd succeeded'],
      [`for d in ${words}; do if [ -d "$d" ]; then pushd "$d"; pwd; popd; fi; done; cd <UP> && git add .`, REACHES],
      [`for d in ${words} <QP>; do if [ -d "$d" ]; then pushd "$d"; git status; popd; fi; done`, REACHES],
      ['if x; then cd src; git -C <UP> add .; fi', REACHES],
      ['if x; then pushd src; popd; else pushd src; fi; git -C ../<UP> add .', REACHES],
      ['if x; then pushd src; popd; elif y; then pushd src; fi; git -C ../<UP> add .', REACHES],
      ['for d in src; do if true; then pushd "$d"; break; popd; fi; done; git -C ../<UP> add .', REACHES],
      [`for d in ${words}; do if [ -d "$d" ]; then pushd "$d"; popd; done; git status`],
      // An `elif` condition that moves runs where the earlier conditions failed, and its body only where it succeeds.
      ['if [ -f nope ]; then :; elif pushd src && [ -f Makefile ]; then make; popd; fi; git -C ../<UP> add .', REACHES],
      ['if false; then :; elif pushd src; false; then popd; fi; git -C ../<UP> add .', REACHES],
      ['if x; then cd src || git -C <UP> status; fi', REACHES],
      ['if a; then pushd src; if b; then popd; fi; fi; git -C ../<UP> add .', REACHES],
    ]);
    check(ps, [
      [`foreach ($d in ${quoted}) { if (Test-Path $d) { Push-Location $d; Pop-Location } }; Set-Location <UP>; git add .`, REACHES],
      [`foreach ($d in ${quoted},'<P>') { if (Test-Path $d) { Push-Location $d; git status; Pop-Location } }`, REACHES],
      ['if ($x) { Push-Location src; Pop-Location } else { Push-Location src }; git -C ../<UP> add .', REACHES],
      ["foreach ($d in 'src') { if ($true) { Push-Location $d; break; Pop-Location } }; git -C ../<UP> add .", REACHES],
      // A script block in a header opens first and starts where the statement it is in does.
      ['Push-Location src; if (Invoke-Command { $x }) { Pop-Location }; git -C ../<UP> add .', REACHES],
      ['foreach ($i in (Invoke-Command { 1..6 })) { Set-Location .. }; Set-Location project; git add .', REACHES],
      [`foreach ($d in ${quoted}) { if (Test-Path $d) { Push-Location "$d; Pop-Location } }; git status`],
      ['if ($x) { } elseif ((Push-Location src)) { Pop-Location }; git -C ../<UP> add .', REACHES],
      ['if ($x) { } elseif ($(Push-Location src; $false)) { Pop-Location }; git -C ../<UP> add .', REACHES],
      ['if ($x) { Set-Location src || git -C <UP> status }', REACHES],
      ['if ($a) { Push-Location src; if ($b) { Pop-Location } }; git -C ../<UP> add .', REACHES],
      ['if($x){ Push-Location src }; git -C ../<UP> add .', REACHES],
      // An error that ends one statement goes on with the next, so the branch still returns.
      ["if ($a) { Push-Location src; [int]::Parse('x'); Pop-Location }; git -C ../<UP> status", 'the branch ends in the worktree'],
      // A trap's continue resumes after the top-level statement around the error, wherever the trap stands in the scope.
      ['if ($true) { Push-Location src; Get-Item nope -ErrorAction Stop; Pop-Location }; git -C ../<UP> add .; trap { continue }', REACHES],
      ["foreach ($d in 'a') { Push-Location src; Get-Item nope -ErrorAction Stop; Pop-Location }; git -C ../<UP> add .; trap { continue }", REACHES],
    ]);
    for (const command of [`for d in ${words}; do if [ -d "$d" ]; then pushd "$d"; fi; done; git status`, `for d in ${words}; do if [ -d "$d" ]; then cd "$d"; fi; done; git status`]) {
      const result = bash(command);
      expect(result, command).toMatch(/working directory (?:of this git command )?cannot be read/);
      expect(result, command).toContain('subshell, at a loop body\'s top level or in an `if` branch inside it');
    }
    for (const command of [`foreach ($d in ${quoted}) { if (Test-Path $d) { Push-Location $d } }; git status`, `foreach ($d in ${quoted}) { if (Test-Path $d) { Set-Location $d } }; git status`]) {
      const result = ps(command);
      expect(result, command).toContain('The working directory cannot be read.');
      expect(result, command).toContain('Push-Location and Pop-Location, at a loop body\'s top level or in an `if` branch inside it');
    }
  });

  it('follows each place the shell may stand in with its own directory stack, and runs a command after && or || only where it can', () => {
    check(bash, [
      ['cd src || cd docs; git status', 'either folder is in the worktree'],
      ['cd src && git -C <UP> status', 'git runs only where the cd succeeded'],
      ['cd src && pwd && git -C <UP> status', 'git runs only where both succeeded'],
      ['cd nope || cd src && git -C <UP> status', 'git runs where either cd succeeded'],
      ['cd src && cd - && git status', 'cd - returns to the worktree'],
      ['cd -; git status', 'OLDPWD is unset, so cd - fails and stays put'],
      ['pushd src && pushd docs && popd && git -C <UP> status', 'git runs in src, where popd returns'],
      ['cd src &&\n\n  git -C <UP> status', 'a blank line keeps the guard'],
      ['cd <QP> && git add .', REACHES],
      ['cd nope || git -C <QP> add .', REACHES],
      ['cd <QW> || cd <QP>; git add .', REACHES],
      ['cd src || git -C <UP> add .', REACHES],
      ['cd src; git -C <UP> add .', REACHES],
      ['cd src && cd - && git -C <UP> add .', REACHES],
      ['cd src; cd -; git -C <UP> add .', REACHES],
      ['cd - && git -C <QP> add .', REACHES],
      ['pushd src; popd; git -C <UP> add .', REACHES],
      ['pushd src && pushd docs && popd && popd && git -C <UP> add .', REACHES],
      ['pushd nope; popd; git -C <UP> add .', REACHES],
      ['pushd src; dirs -c; popd; git -C ../<UP> add .', REACHES],
      ['(cd src) && git -C <UP> add .', REACHES],
      ['! cd src && git -C <UP> add .', REACHES],
      ['echo | cd src && git -C <UP> add .', REACHES],
      ['{ cd src; } && git -C <UP> add .', REACHES],
      ['if true; then cd src; fi && git -C <UP> add .', REACHES],
      ['cd src && time git -C <UP> add .', REACHES],
      ['env cd src && git -C <UP> add .', REACHES],
      ['CD src && git -C <UP> add .', REACHES],
      ["trap 'cd src' EXIT && git -C <UP> add .", REACHES],
      // A place a command may skip, or a jump may leave from, stays possible.
      ['pushd src; if false; then popd; fi; git -C ../<UP> add .', REACHES],
      ['pushd src; true && { popd; }; git -C ../<UP> add .', REACHES],
      ['pushd src; echo | popd; git -C ../<UP> add .', REACHES],
      ['pushd src; eval "false && popd"; git -C ../<UP> add .', REACHES],
      ['for d in src; do pushd "$d"; break; popd; done; git -C ../<UP> add .', REACHES],
      ['while pushd src && false; do popd; done; git -C ../<UP> add .', REACHES],
      ["trap 'git -C ../<UP> add .' EXIT; pushd src; npm test || exit 1; popd"],
      ['pushd src; DIRSTACK[0]=x; popd; git status'],
      ['pushd src; popd -n; git status'],
      ['OLDPWD=<QP>; cd src; cd - && git status'],
      ['export OLDPWD=<QP>; cd -; git status'],
      ['source ./env.sh; cd -; git status'],
    ]);
    checkWith('Bash', { OLDPWD: project }, 'cd - && git status');
    check(ps, [
      ['Set-Location src && git -C <UP> status', 'git runs only where Set-Location succeeded'],
      ['Set-Location src; Set-Location -; git status', 'the location history holds only the worktree and src'],
      ['Push-Location nope; Pop-Location; git status', 'Push-Location pushes even when it fails to move'],
      ["foreach ($d in 'a','b','c','d','e','f') { Set-Location $d }", 'nothing reads the location after the loop'],
      ['Set-Location src || git -C <UP> add .', REACHES],
      ['Set-Location src; git -C <UP> add .', REACHES],
      ['Push-Location nope; Pop-Location; git -C <UP> add .', REACHES],
      ['Push-Location src; Pop-Location; git -C <UP> add .', REACHES],
      ['Set-Location src; Set-Location -; git -C <UP> add .', REACHES],
      ['Push-Location src; if ($x) { Pop-Location }; git -C ../<UP> add .', REACHES],
      ["try { Push-Location src; throw 'x'; Pop-Location } catch { git -C ../<UP> add . }", REACHES],
      ['Push-Location src; function f { Pop-Location }; git -C ../<UP> add .', REACHES],
      ["foreach ($d in 'src') { Push-Location $d; break; Pop-Location }; git -C ../<UP> add .", REACHES],
      ['Push-Location -StackName s src; Pop-Location; git status'],
      ['Push-Location src; Pop-Location -StackName s; git status'],
    ]);
    check(bash, [
      ['cmd /d /c "pushd src && git status && popd"', 'cmd stays in the worktree'],
      ['cmd /d /c "popd & git status"', 'popd on an empty stack stays put'],
      ['cmd /d /c "pushd src & popd & git -C <UP> add ."', REACHES],
      ['cmd /d /c "pushd nope & popd & git -C <UP> add ."', REACHES],
      ['cmd /d /c "pushd <P> & popd & git status"', REACHES],
    ]);
  });

  // Measured with Git Bash: ERR runs after every failing command and DEBUG before every simple command, the EXIT trap's
  // included; neither runs again inside its own action.
  it('runs a trap on anything but EXIT any number of times before each later command and before the EXIT trap', () => {
    check(bash, [
      ["trap 'cd ..' ERR; false; false; false; false; git -C ../project status", REACHES],
      ["trap 'cd ..' DEBUG; : ; : ; : ; : ; cd project", REACHES],
      ["trap 'cd ..' ERR; trap 'git -C ../project status' EXIT; false; false; false; false", REACHES],
      ["trap 'cd ..' DEBUG; trap 'git -C ../project status' EXIT; : ; :", REACHES],
      ["trap 'cd ..' ERR; for i in 1 2 3 4; do false; done; git -C ../project status", REACHES],
      ["set -E; trap 'cd ..' ERR; (false; false; false; false; git -C ../project status)", REACHES],
      ["set -E; trap 'cd ..' ERR; x=$(false; false; false; false; git -C ../project status)", REACHES],
      ["set -T; trap 'cd ..' DEBUG; (: ; : ; : ; git -C ../project status)", REACHES],
      ["trap 'cd src' ERR; false; git status"],
      ["trap 'echo failed' ERR; git status; npm test", 'the trap stays in the worktree'],
      ["trap 'echo failed' ERR; cd src && git -C <UP> status", 'the trap keeps the status && reads'],
      ["trap 'echo $LINENO' DEBUG; for d in src docs; do (cd \"$d\" && npm test); done; git status", 'the trap stays in the worktree'],
      ["trap 'rm -f x' EXIT ERR; cd src; git status", 'the trap stays in the worktree'],
      // A command that changes nothing leaves the closure as it was, so many of them cost no walks.
      [`trap 'rm -rf x' EXIT INT TERM\n${Array.from({ length: 400 }, (_, k) => `echo ${k}`).join('\n')}\ngit status`, 'the trap stays in the worktree'],
    ]);
  });

  it('runs the EXIT trap a subshell sets when the subshell exits, from where the subshell stands', () => {
    check(bash, [
      ["(trap 'git -C ../project status' EXIT; cd ..; cd ..; cd ..; cd ..)", REACHES],
      ["(trap 'git -C ../project status' EXIT; cd ../../../..) &", REACHES],
      ["x=$(trap 'git -C ../project status' EXIT; cd ../../../..)", REACHES],
      ["(trap 'git -C ../project status' EXIT; (cd ../../../..; git status); cd ../../../..)", REACHES],
      ["(trap 'rm -f x' EXIT; cd src; git status)", 'the trap runs in the worktree'],
      ["(trap 'git -C ../project status' EXIT); cd ../../../..", 'the trap ran when the subshell exited'],
      ["trap 'git -C ../project status' EXIT; (cd ../../../..)", "the parent's EXIT trap does not run at the subshell's exit"],
      ["(trap 'git -C ../project status' EXIT; (cd ../../../..))", "the inner subshell's moves do not reach the outer one's exit"],
    ]);
  });

  it('blocks cd - and pushd - where the text does not prove OLDPWD', () => {
    check(bash, [
      ['cd ..; OLDPWD=<P>; cd -; touch x'],
      ['cd ..; OLDPWD=<P>; pushd -; touch x'],
      ['source ./env.sh; cd -; npm test'],
      ["bash -c 'cd -; touch x'"],
      ['cd src && cd - && git status', 'cd - returns to the worktree'],
      ['cd src && make && cd - && git status', 'cd - returns to the worktree'],
      ['pushd src && pushd - && git status', 'pushd - returns to the worktree'],
      ['pushd -; git status', 'OLDPWD is unset, so pushd - fails and stays put'],
      ['cd src; cd ..; pushd - && git -C ../<UP> status', REACHES],
      ['env -C - git status', 'only the cd and pushd builtins read - as OLDPWD; env -C takes a folder named -'],
      ['sudo -D - git status', 'sudo -D takes a folder named -'],
      ['cmd /d /c "cd - & git status"', "cmd's cd takes a folder named -"],
    ]);
    checkWith('Bash', { OLDPWD: project }, 'cd - && ls');
    checkWith('Bash', { OLDPWD: project }, 'pushd -; touch x');
    expect(bash('cd ..; OLDPWD=x; cd -; touch x')).toContain('computed');
    expect(bash('cd ..; OLDPWD=x; pushd -')).toContain('computed');
  });

  it('reads the path a path function gives from readable operands, and every other form as computed', () => {
    check(ps, [
      ["Set-Location (Join-Path '<W>' 'src')", 'Join-Path gives a folder in the worktree'],
      ["$wt = '<W>'; Set-Location $(Join-Path $wt src)", 'Join-Path gives a folder in the worktree'],
      ["$wt = '<W>'; Set-Location \"$(Join-Path $wt src)\"", 'Join-Path gives a folder in the worktree'],
      ["Set-Location (Join-Path -Path '<W>' -ChildPath src)", 'Join-Path gives a folder in the worktree'],
      ["Set-Location (Split-Path '<W><S>src<S>a.txt')", 'Split-Path gives a folder in the worktree'],
      ["Set-Location (Split-Path '<P><S>src' -Leaf)", 'the leaf is a folder name in the worktree'],
      ["$wt = '<W>'; Set-Location $($wt)", 'the subexpression is the variable'],
      ["Set-Location ([IO.Path]::Combine('<W>', 'src'))", 'Combine gives a folder in the worktree'],
      ["$wt = \"$(Join-Path '<W>' src)\"; Set-Location $wt", 'the string the variable is set to reads'],
      ["Set-Location ((Join-Path '<W>' src))", 'the inner subexpression is the one statement'],
      ["$wt = '<W>'; $p = Join-Path $wt 'src'; Set-Location $p", 'the variable is set to the path Join-Path gives'],
      ["$wt = '<W>'; $p = (Join-Path $wt 'src'); Set-Location $p", 'the variable is set to the path Join-Path gives'],
      ["$p = Split-Path '<W><S>src<S>a.txt'; git -C $p status", 'the variable is set to the path Split-Path gives'],
      ["$base = Join-Path $env:TEMP 'wiso'; Set-Location \"$base<S>work\"", 'TEMP is a folder outside the project'],
      ["$p = Join-Path '<P>' 'src'; Set-Location $p; git add .", REACHES],
      ["$p = (Join-Path '<P>' 'src'); Set-Location $p", REACHES],
      ["$wt = '<W>'; $p = Join-Path $wt '<UP>'; git -C $p add .", REACHES],
      ["$env:GIT_DIR = Join-Path '<P>' '.git'; git log", REACHES],
      ["$p = [IO.Path]::Combine('<P>', 'src'); Set-Location $p", REACHES],
      ["$p = Join-Path '<W>' 'src'; $p = '<P>'; Set-Location $p"],
      ["$p = Join-Path '<W>' 'src' | Out-Null; Set-Location $p"],
      // The variable takes what the whole pipeline outputs.
      ["$env:GIT_DIR = '<W>' | ForEach-Object { '<P><S>.git' }; git log"],
      ["$env:GIT_DIR = Join-Path '<W>' '.git' | ForEach-Object { '<P><S>.git' }; git log"],
      ["$p = Get-Item (Join-Path '<W>' 'src'); Set-Location $p"],
      ["if ($x) { $p = Join-Path '<W>' 'src' }; Set-Location $p"],
      ["Set-Location (Join-Path '<P>' 'src')", REACHES],
      ["Set-Location (Join-Path '<W>' '<UP>')", REACHES],
      ["git -C (Split-Path '<P><S>src') add .", REACHES],
      ["Set-Location (Join-Path '<W>' src -Resolve)"],
      ["Set-Location (Join-Path '<W>','<P>' src)"],
      ["Set-Location (Join-Path '<W>' a b)"],
      ['Set-Location (Join-Path HKLM: x)'],
      ['Set-Location (Join-Path $env:X src)'],
      ["Set-Location (Join-Path '<W>' '<S><S>src')"],
      ['Set-Location (Get-Item .)'],
      ["Set-Location ([IO.Path]::Combine('<W>', '<P>'))", REACHES],
      ["Set-Location ([System.IO.Path]::Combine('<W>', '..', '..', '..', '..', '..', 'project'))", REACHES],
      ["Set-Location $(Join-Path '<W>' src; Join-Path '<P>' src)"],
      ["Set-Location (Join-Path '<W>' src | ForEach-Object { '<P>' })"],
      ["Set-Location ('<W>')x"],
      ["Set-Location \"$(Split-Path '<P><S>src')\"", REACHES],
      ["Set-Location (Split-Path '<W><S>src<S>..' -Leaf)"],
      ["Set-Location (Split-Path '<P><S>src' -Leaf:$false)"],
    ]);
    // Join-Path prints nothing for a drive that does not exist, and Set-Location then goes home in pwsh 7.
    if (process.platform === 'win32') expect(ps(`Set-Location (Join-Path '${/^q/i.test(worktree) ? 'Z' : 'Q'}:\\a' b)`)).toContain('computed');
    check(bash, [
      ['wt=<QW>; cd "$(dirname "$wt/src/a.txt")"', 'dirname gives a folder in the worktree'],
      ['wt=<QW>; cd "$(realpath -m "$wt/src")"', 'realpath gives a folder in the worktree'],
      ['cd "$(realpath -m src)"', 'realpath gives a folder in the worktree'],
      ['cd "$(realpath -m -s src/../src)"', 'realpath gives a folder in the worktree'],
      ['git -C "$(basename "$PWD")/.." status', 'the folder is the worktree'],
      ['cd "$(basename <QP>)" && git status', 'the last name is a folder in the worktree'],
      ['cd "$(dirname <QP>/src)" && git add .', REACHES],
      ['x=$(dirname <QP>/src); cd "$x" && git add .', REACHES],
      ['cd "$(realpath "$x")"'],
      ['cd "$(dirname "$(cat f)")"'],
      ['cd "$(dirname <QW>/a > f)"'],
      ['cd "$(dirname <QW>/a; echo <QP>)"'],
      ["cd \"$(dirname '~/x')\""],
      ['cd src; cd "$(realpath -m ..)" && git status'],
    ]);
    const linked = path.join(worktree, 'linked');
    fs.symlinkSync(path.join(project, 'src'), linked, 'junction');
    try {
      expect(bash('cd "$(realpath -m linked/..)" && git add .')).toContain(WORKTREE_ISOLATION_REASON);
      expect(bash('cd "$(dirname "$(realpath -m linked)")" && git add .')).toContain(WORKTREE_ISOLATION_REASON);
      expect(bash('cd "$(realpath -m -s linked/..)" && git status')).toBeUndefined();
    } finally {
      fs.rmSync(linked, { force: true });
    }
  });

  it('reads cmd text as cmd reads it: switches, quotes, %NAME%, separators and its internal commands', () => {
    const because = 'cmd stays in the worktree';
    const both: Row[] = [
      ['cmd /d /c "cd /d <W> && npm ci"', because],
      ['cmd /c "cd /d <W> && npm ci"', because],
      ['cmd /c "git status"', because],
      ['cmd /c "npm i simple-git"', because],
      ['cmd /c "type .git\\HEAD"', because],
      ['cmd /c "echo %PATH%"', because],
      ['cmd /c dir', because],
      ['cmd /d /s /c "npm test"', because],
      ['cmd /c "set NODE_ENV=test && npm test"', because],
      ['cmd /c "start "" /d <W> npm test"', because],
      ['cmd /c "call npm ci"', because],
      ['cmd /v:on /c "echo !X!"', because],
      ['cmd /d /c "%G% status"', 'G is unset, so the command name stays %G%'],
      ['cmd /c "cd /d <P> && git add ."', REACHES],
      ['cmd /c "cd <P> & git add ."', REACHES],
      ['cmd /c "cd..<S>..<S>..<S>..<S>..<S>project & git add ."', REACHES],
      ['cmd /c "cd/d <P> & git add ."', REACHES],
      ['cmd /c "git -C <P> add ."', REACHES],
      ["cmd /c \"git -C '<P>' add .\"", REACHES],
      ['cmd /c "pushd <P> & git add ."', REACHES],
      ['cmd /c start /d <QP> notepad', REACHES],
      ['cmd /c "set GIT_DIR=<P><S>.git && git log"', REACHES],
      ['cmd /c "set "GIT_WORK_TREE=<FP>" & git status"', REACHES],
      ['cmd /c "set /p GIT_DIR=x & git log"'],
      ['cmd /c "%G% status"'],
      ['cmd /c "git -C %P% add ."'],
      ['cmd /c "set X=<P>& cd %X%"'],
      ['cmd /c "for %d in (a) do git -C %d add ."'],
      ['cmd /c "if exist x git add ."'],
      ['cmd /c "call :x"'],
      ['cmd /c "call git -C %%X%% add ."'],
      ['cmd /c "(cd <P>) & git add ."'],
      ['cmd /c "cmd /c git -C <P> add ."', REACHES],
      ["cmd /c \"bash -c 'git -C <FP> add .'\""],
      ['cmd /c "setlocal enabledelayedexpansion & echo x"'],
      ['cmd /d /c "echo ^& git -C <P> add . | more"', REACHES],
      // A redirection's target ends at a delimiter, and the rest is the command's text.
      ['cmd /d /c "cd >nul,<P> & git add ."', REACHES],
      ['cmd /d /c "cd >nul;<P> & git add ."', REACHES],
      ['cmd /d /c "cd >nul=<P> & git add ."', REACHES],
      ['cmd /d /c "cd >,nul <P> & git add ."', REACHES],
      ['cmd /d /c "pushd >nul;<P> & git add ."', REACHES],
      ['cmd /d /c "c\rd <P> & git add ."', REACHES],
      ['cmd /d /c "g\rit -C <P> add ."', REACHES],
      // Delayed expansion removes the carets of a part holding `!`; without /v the registry may turn it on.
      ['cmd /d /v:on /c "git -C <P><S>..<S>pro^^ject add . !x!"', REACHES],
      ['cmd /d /c "git -C <P><S>..<S>pro^^ject add . !x!"', REACHES],
      ['cmd /d /v:on /c "start /d <P><S>..<S>pro^^ject git add . !x!"', REACHES],
      ['cmd /d /c "echo x | git -C <P><S>..<S>pro^^^^ject add . !x!"', REACHES],
      ['cmd /d /v:off /c "git -C <P><S>..<S>pro^^ject add . !x!"', 'delayed expansion is off, so the caret stays in the name'],
      ['cmd /d /v:on /c "git -C <P><S>..<S>pro^^ject add ."', 'nothing holds a !, so the caret stays in the name'],
      ["cmd /d /c 'echo x & \"cmd\"/c git -C <P> add .'", REACHES],
      ['cmd /d /c "echo x & cmd(/c git -C <P> add ."'],
      ['cmd /d /c "cd\u0085<P> & git add ."', REACHES],
      ['cmd /d /c "cd\u00a0<P> & git add ."', REACHES],
      ['cmd /d /c "cd <P>\u0085\u180e& git add ."', REACHES],
      ['cmd /d /c "cd\u00ff<P> & git add ."', 'U+00FF is not a delimiter, so cmd runs no cd'],
      ['cmd /d /c "git -C <P> add .\necho a"', REACHES],
      ['cmd /d /c "echo a (<P>) & cd <P> & git add ."', REACHES],
      ['cmd /d /c "echo x & (cd <P>) & git add ."'],
      ['cmd'],
      ['echo "cd /d <P> & git add ." | cmd'],
      ['cmd /k dir'],
      ['cmd /x /c dir'],
    ];
    check(bash, [
      ...both,
      ['npx -c "npm test"', because],
      ['export wt=<QW>; cmd /d /c "cd /d %wt% && npm ci"', because],
      ['cmd //c "g^it status"', because],
      ['cmd //c "g^it -C <P> status"', REACHES],
      ['cmd //c start "" /d <QP> git add .', REACHES],
      ['export p=<QP>; cmd /d /c "cd /d %p% && git add ."', REACHES],
      ["export x='a & git -C <P> add .'; cmd /d /c \"echo %x%\"", REACHES],
      ['export wt=<QW>; cmd /c "cd /d %wt%"'],
      ['cmd /c "echo a\ngit -C <P> add ."', 'cmd ignores the text after a line feed'],
    ]);
    check(ps, [
      ...both,
      ["$env:wt = '<W>'; cmd /d /c \"cd /d %wt% && npm ci\"", because],
      [
        [
          "$wt = '<W>'",
          'node --version',
          'Start-Process -FilePath \'cmd.exe\' -ArgumentList "/c", "npm ci --ignore-scripts > `"$wt\\..\\x-npm.log`" 2>&1 && npm rebuild >> `"$wt\\..\\x-npm.log`" 2>&1 && echo DONE >> `"$wt\\..\\x-npm.log`"" -WorkingDirectory $wt -WindowStyle Hidden',
          "'started'",
        ].join('\n'),
        'npm runs in the worktree and the log lands beside it',
      ],
      ["cmd /c 'start \"t\" /d \"<P>\" git add .'", REACHES],
      ["cmd /c 'set \"GIT_WORK_TREE=<P>\" & git status'", REACHES],
      ["$env:p = '<P>'; cmd /d /c \"cd /d %p% && git add .\"", REACHES],
      ["$env:x = 'a & git -C <P> add .'; cmd /d /c \"echo %x%\"", REACHES],
      ["$env:wt = '<W>'; cmd /c \"cd /d %wt%\""],
      ['cmd /c "echo a`ngit -C <P> add ."', 'cmd ignores the text after a line feed'],
      ["$PSNativeCommandArgumentPassing = 'Standard'; cmd /c 'echo \"a & b\"'"],
    ]);
    // A Windows PATH holds `(x86)`, which is text where no command starts.
    const windowsPath = 'C:\\Program Files (x86)\\Common Files\\Oracle\\Java\\javapath;C:\\Windows\\system32;C:\\Windows;C:\\Program Files\\Git\\cmd;C:\\Program Files (x86)\\Microsoft SDKs\\Azure\\CLI2\\wbin';
    for (const tool of ['Bash', 'PowerShell'] as const) {
      checkWith(tool, { PATH: windowsPath }, 'cmd /d /c "echo %PATH%"', because);
      checkWith(tool, { PATH: windowsPath }, 'npx -c "echo %PATH%"', because);
      checkWith(tool, { PF: 'C:\\Program Files (x86)\\Tools' }, 'cmd /d /c "cd /d %PF% & npm test"', because);
      checkWith(tool, { X: '\r' }, 'cmd /d /c "c%X%d <P> & git add ."', REACHES);
      checkWith(tool, { X: `(cd ${project})` }, 'cmd /d /c "%X% & git add ."');
    }
    checkWith('Bash', { PATH: windowsPath }, 'cmd //d //c "echo %PATH%"', because);
    checkWith('PowerShell', { PATH: windowsPath }, "Start-Process cmd -ArgumentList '/d','/c','echo %PATH%'", because);
  });

  it('never quotes a value from the environment in a reason', () => {
    const secret = 'S3cr3tT0k3nValue';
    const short = 'q7z';
    const native = path.join(project, secret);
    const extra = {
      TOKEN: `--${secret}`, KEY: `x; git --${secret} status`, DIR: `${project.split(path.sep).join('/')}/${secret}`, K: short,
      GIT_PAGER: `cd '${native}' && pwd`, NATIVE: native, TEMP: native,
    };
    const rows: Array<['Bash' | 'PowerShell', string, typeof REACHES?]> = [
      ['Bash', 'git $TOKEN status'],
      ['Bash', 'eval "git $TOKEN status"'],
      ['Bash', 'bash -c "git $TOKEN"'],
      ["Bash", "bash -c 'git $TOKEN status'"],
      ['Bash', 'GIT_SSH_COMMAND="$KEY" git fetch'],
      ['Bash', 'env $TOKEN git status'],
      ['Bash', 'cd "$DIR"', REACHES],
      ['Bash', 'eval "cd $DIR"', REACHES],
      ['Bash', 'git log', REACHES],
      ['Bash', 'git --tok$K status'],
      ['Bash', 'eval "git --tok$K status"'],
      ['PowerShell', 'git $env:TOKEN status'],
      ['PowerShell', 'iex "git $env:TOKEN status"'],
      ['PowerShell', 'pwsh -NoProfile -Command "git $env:TOKEN"'],
      ['PowerShell', 'Start-Process git -ArgumentList $env:TOKEN'],
      ['PowerShell', 'Set-Location $env:DIR', REACHES],
      ['PowerShell', 'iex "Set-Location $env:DIR"', REACHES],
      ['PowerShell', 'cmd /d /c "git %TOKEN% status"'],
      ['PowerShell', 'git log', REACHES],
      ['PowerShell', 'iex "git --tok$env:K status"'],
      ['Bash', 'cmd /d /c "cd /d %DIR%"', REACHES],
      // A native value, and the POSIX form Git Bash imports TEMP in, which text parsed again then holds.
      ['Bash', 'cd "$NATIVE"', REACHES],
      ['Bash', `eval "cd '$NATIVE'"`, REACHES],
      ['Bash', 'eval "cd $TEMP"', REACHES],
      ['PowerShell', 'Set-Location $env:NATIVE', REACHES],
      ['PowerShell', "iex \"Set-Location '$env:NATIVE'\"", REACHES],
    ];
    for (const [tool, command, reaches] of rows) {
      const result = withEnvironment(tool, extra)(command);
      expect(result, command).toContain(WORKTREE_ISOLATION_REASON);
      if (reaches) expectReaches(result, command);
      expect(result!.toLowerCase(), command).not.toContain(secret.toLowerCase());
      expect(result!.toLowerCase(), command).not.toContain(short);
    }
    // The word as written is named, since it repeats nothing the command does not show.
    expect(withEnvironment('Bash', extra)('git --tok$K status')).toContain('--tok$K');
    expect(withEnvironment('Bash', extra)('cd "$DIR"')).toContain('"$DIR" is in the project folder.');
  });

  it('names a word the command wrote, even where it holds a piece of a value from the environment', () => {
    const literal = `ls ~; cd '${project}' && pwd`;
    const named = `'${project}' is in the project folder.`;
    expect(worktreeIsolationBlock('Bash', { command: literal }, { ...iso, environment: {} })).toContain(named);
    expect(bash(literal)).toContain(named);
    expect(withEnvironment('Bash', { HOME: project })(literal)).toContain(named);
    expect(ps(`Get-ChildItem ~; Set-Location '${project}'`)).toContain(named);
    // A home folder that did not come from the environment is not one of its values.
    expect(worktreeIsolationBlock('Bash', { command: 'eval "cd $HOME/../project"' }, { ...iso, environment: {} })).toMatch(/ \S+\/\.\.\/project is in the project folder\./);
    expect(bash('eval "cd $HOME/../project"')).toContain('A path the command builds is in the project folder.');
  });

  // The check trusts the tool's own Bash to run no startup file; a Git for Windows that started a login or interactive shell would.
  it.skipIf(process.platform !== 'win32' || !fs.existsSync(GIT_BASH))('runs Git Bash, started as pi starts it, as a non-login, non-interactive shell', () => {
    const { shell, args, commandTransport } = getShellConfig(GIT_BASH);
    expect(commandTransport).not.toBe('stdin');
    const [login, flags] = execFileSync(shell, [...args, 'shopt -q login_shell; echo $?; echo "$-"'], { encoding: 'utf8' }).trim().split(/\r?\n/);
    expect(login).toBe('1');
    expect(flags).not.toContain('i');
  });

  it('blocks PowerShell nested deeper than the parse follows, instead of failing', () => {
    expect(ps(`${'('.repeat(300)}git status${')'.repeat(300)}`)).toContain('parsed');
  });

  // Measured with git on Windows: the last segment loses every trailing `.` and space, an earlier one a single trailing `.`.
  it.skipIf(process.platform !== 'win32')('compares a shell target as Win32 opens it, trailing dots and spaces removed', () => {
    check(ps, [
      ["git -C '<P>.' status", REACHES],
      ["git -C '<P>..' status", REACHES],
      ["git -C '<P>. .' status", REACHES],
      ["git -C '<P>  ' status", REACHES],
      ["git -C '<P>.\\src' status", REACHES],
      ["git -C '<P>\\src. .' status", REACHES],
      ["git --git-dir='<P>.\\.git' status", REACHES],
      ["git --work-tree='<P>.' status", REACHES],
      ['cmd /d /c "cd /d <P>. & git status"', REACHES],
      ["Start-Process git -WorkingDirectory '<P>.'", REACHES],
      ["git -C '<P>..\\src' status", 'an earlier segment keeps two trailing dots'],
      ["git -C '<P> \\src' status", 'an earlier segment keeps a trailing space'],
    ]);
    check(bash, [["git -C '<FP>.' status", REACHES]]);
  });

  // Measured on pwsh 7 and Windows PowerShell 5.1: both read these alike.
  it('reads PowerShell whitespace, line breaks and quote characters as PowerShell does', () => {
    const spaces = ['\v', '\f', '\u00a0', '\u0085', '\u1680', '\u2000', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000'];
    check(ps, spaces.flatMap((space): Row[] => [[`cd${space}<P>`, REACHES], [`git -C${space}<P> status`, REACHES], [`Write-Host a${space}; cd <P>`, REACHES]]));
    check(ps, [
      ['cd <P>\u00a0', REACHES],
      ["Set-Location '<W>'\rSet-Location '<P>'", REACHES],
      ['# note\rSet-Location <QP>', REACHES],
      ['Set-Location `\r<QP>', REACHES],
      ['git -C \u201a<P>\u201b status', REACHES],
      ['git -C \u201b<P>\u2018 status', REACHES],
      ['git --git-dir=\u201a<P><S>.git\u201b status', REACHES],
      ['& \u201agit\u201b -C <P> status', REACHES],
      ['git -C \u201e<P>\u201c status', REACHES],
      ['git -C \u201e<P>\u201e status', REACHES],
      ['$p = @\u2018\n<P>\n\u2019@; Set-Location $p', REACHES],
      ['$p = @\u201e\n<P>\n\u201d@; Set-Location $p', REACHES],
      ["Set-Location '<W>'\r\nSet-Location src", 'a CRLF ends one statement'],
      ["Set-Location '<W>'\u2028Set-Location '<P>'", 'U+2028 is whitespace, not a line break, so this is one statement that fails'],
      ['cd\u200b<P>', 'U+200B is part of the token, so this names no command'],
      ['cd\ufeff<P>', 'U+FEFF is part of the token'],
      ['cd\u180e<P>', 'U+180E is part of the token'],
      ["git -C '<P>\u2018\u2019' status", 'two single quotes of either kind are one quote character'],
      ['git -C "<P>\u201c\u201d" status', 'two double quotes of either kind are one quote character'],
    ]);
  });

  // Measured: wsl.exe hands its shell the rest of its own command line as the caller wrote it, quotes included.
  it('reads the command line wsl hands its shell as the caller built it', () => {
    check(bash, [
      ['wsl bash -c "git -C <FP> status"', REACHES],
      ["wsl sh -c 'cd <FP> && git add .'", REACHES],
      ['wsl -d Ubuntu -- bash -c "git -C <FP> status"', REACHES],
      ['wsl --cd /tmp bash -c "git -C <FP> status"', REACHES],
      ['cmd //c wsl bash -c "git -C <FP> status"', REACHES],
      ['wsl ls -la', 'wsl runs ls'],
      ['wsl -e ls', 'wsl runs ls'],
      ['wsl bash -c "ls -la"', 'the shell runs ls'],
      ['wsl echo "a   b"; git status', 'git runs in the worktree'],
    ]);
    check(ps, [
      ["wsl bash -c \"git -C '<FP>' status\"", REACHES],
      ["wsl sh -c 'cd <FP> && git add .'", REACHES],
      ["Start-Process wsl -ArgumentList 'bash -c \"git -C <FP> status\"'", REACHES],
      ['cmd /c wsl bash -c "git -C <FP> status"', REACHES],
      ['wsl ls -la', 'wsl runs ls'],
      ['wsl -e ls', 'wsl runs ls'],
      ["wsl -e bash -c 'git status'", 'git runs in the worktree'],
    ]);
  });

  // Measured on cmd: the first quoted token among start's options is the title, options go on after it, a `/` right
  // after the title's closing quote starts the next option, and a second quoted token is the program.
  it('reads start\'s title wherever it stands among its options, as cmd does', () => {
    check(ps, [
      ["cmd /c 'start /wait /min \"t\" /d <P> cmd /c cd'", REACHES],
      ["cmd /c 'start /b /min \"t\" /d <P> cmd /c cd'", REACHES],
      ["cmd /c 'start /b \"t\" /wait /d <P> cmd /c cd'", REACHES],
      ["cmd /c 'start /wait \"t\"/d <P> cmd /c cd'", REACHES],
      ["cmd /c 'start /wait \"t\" /d <P> \"cmd\" /c cd'", REACHES],
      ["cmd /c 'start /wait /d <W> \"t\" /d <P> cmd /c cd'", REACHES],
      ['cmd /c start "" notepad', 'start runs notepad in the worktree'],
      ["cmd /c 'start /wait /d <W> \"t\" cmd /c cd'", 'start runs cmd in the worktree'],
      ["cmd /c 'start /wait \"t1\" \"t2\" /d <P> cmd /c cd'", 'the second quoted token is the program, and /d is its argument'],
    ]);
  });

  // Measured on pwsh 7.6 and Windows PowerShell 5.1: the first word that is neither a switch nor a switch's value ends the
  // switches; Windows PowerShell runs it and the rest as its command, and pwsh takes it as a script file.
  it('reads the first word after PowerShell\'s switches as Windows PowerShell\'s command and as pwsh\'s script file', () => {
    for (const run of [bash, ps]) {
      check(run, [
        ['powershell git -C <FP> status', REACHES],
        ['powershell -NoProfile -ExecutionPolicy Bypass git -C <FP> status', REACHES],
        ['powershell -NoProfile -ep Bypass -WindowStyle Normal -OutputFormat Text git -C <FP> status', REACHES],
        ['powershell -NoProfile -i Text git -C <FP> status', REACHES],
        ['powershell -Version 5.1 -NoProfile git -C <FP> status', REACHES],
        ['pwsh -NoProfile -s -c "git status"'],
        ['pwsh -'],
        ['pwsh -NoProfile -File -'],
        ['pwsh git -C <FP> status', 'pwsh takes git as a script file and runs no command text'],
        ['pwsh -NoProfile -ExecutionPolicy Bypass -i git -C <FP> status', 'pwsh takes git as a script file'],
        ['pwsh git status', 'pwsh takes git as a script file'],
        ['powershell -NoProfile -ExecutionPolicy Bypass -File x.ps1', 'the script file is not read'],
        ['powershell -NoProfile -Foo git -C <FP> status', 'Windows PowerShell runs the unknown switch as a command named -Foo'],
        ['powershell -NoProfile -wd <FP> -c "git status"', 'Windows PowerShell 5.1 takes the value of -WorkingDirectory and stays where it starts'],
      ]);
    }
    check(ps, [[`pwsh -NoProfile -ec ${encoded('git status')} -wd '<P>'`, REACHES]]);
  });

  // Measured on pwsh 7.6 and Windows PowerShell 5.1: $HOME and ~ come from the USERPROFILE a process starts with, and
  // changing USERPROFILE in a running process moves neither.
  it('gives each PowerShell process the home it starts with', () => {
    const profile = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    check(ps, [
      [`$env:${profile} = '<P>'; pwsh -NoProfile -c 'cd ~'`, REACHES],
      [`$env:${profile} = '<P>'; powershell -NoProfile -c 'Set-Location $HOME; git status'`, REACHES],
      [`$env:${profile} = '<P>'; bash -c "pwsh -NoProfile -c 'cd ~'"`, REACHES],
      [`if ($x) { $env:${profile} = '<W>' }; pwsh -NoProfile -c 'cd ~'`],
      [`$env:${profile} = '<P>'; Set-Location ~; git status`, 'the running process keeps the home it started with'],
      [`$env:${profile} = '<W>'; pwsh -NoProfile -c 'cd ~; git status'`, 'the child starts with the worktree as its home'],
      ["pwsh -NoProfile -c 'cd ~/../project; git status'", REACHES],
    ]);
    // Off Windows the child's home is Bash's own HOME, which an assignment leaves with two possible values.
    const exported = `export ${profile}=<QP>; pwsh -NoProfile -c 'Set-Location $HOME; git status'`;
    check(bash, [
      [`${profile}=<QP> pwsh -NoProfile -c 'cd ~'`],
      process.platform === 'win32' ? [exported, REACHES] : [exported],
    ]);
  });

  // Measured: pwsh 7.6 runs a Start-Job block in -WorkingDirectory, else in the current location; Windows PowerShell 5.1
  // has no -WorkingDirectory and runs it in Documents. Thread jobs and -Parallel blocks run in the current location.
  it('runs a Start-Job block in its -WorkingDirectory, and in a computed directory without one', () => {
    check(ps, [
      ["Start-Job -WorkingDirectory '<P>' { git status }", REACHES],
      ["Start-Job { git status } -WorkingDirectory '<P>'", REACHES],
      ["Start-Job -WorkingDirectory '<P>' -InitializationScript { git status } -ScriptBlock { 'x' }", REACHES],
      ["Start-Job -ScriptBlock { 'x' } -InitializationScript { git status } -WorkingDirectory '<P>'", REACHES],
      ["Start-Job -WorkingDirectory '<W>' { git -C <UP> status }", REACHES],
      ['Start-Job { git status }'],
      ["Start-Job -WorkingDirectory 'src' { git status }"],
      ["Start-Job -WorkingDirectory '<W>*' { git status }"],
      ["$wt = '<W>'; Start-Job -WorkingDirectory '<W>' { Set-Location $wt; git status }"],
      ['Start-ThreadJob { git -C <UP> status }', REACHES],
      ['1 | ForEach-Object -Parallel { git -C <UP> status }', REACHES],
      ['Start-Job { npm test }', 'npm reads no directory the check follows'],
      ["Start-Job -WorkingDirectory '<W>' { git status }", 'the job runs in the worktree'],
      ["$env:wt = '<W>'; Start-Job -WorkingDirectory '<W>' { Set-Location $env:wt; git status }", 'the job inherits the environment'],
    ]);
  });

  it('blocks the ways PowerShell starts a process or runs text through .NET, WMI and COM, and allows reading processes', () => {
    check(ps, [
      ["[powershell]::Create().AddScript(\"git -C '<P>' status\").Invoke()"],
      ["$p = [powershell]::Create(); $p.AddCommand('git').AddArgument('status').Invoke()"],
      ['$p = [System.Management.Automation.PowerShell]::Create(); $p.Invoke()'],
      ["$p = [Diagnostics.Process]::new(); $p.StartInfo.FileName = 'git'; $p.Start()"],
      ["$si = New-Object System.Diagnostics.ProcessStartInfo 'git', 'status'"],
      ['$p = New-Object -TypeName System.Diagnostics.Process'],
      ["Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'git status' }"],
      ["Invoke-WmiMethod -Class Win32_Process -Name Create -ArgumentList 'git status'"],
      ["([wmiclass]'Win32_Process').Create('git status')"],
      ["$c = Get-WmiObject -List Win32_Process; $c.Create('git status')"],
      ["(New-Object -ComObject WScript.Shell).Run('git status')"],
      ["(New-Object -ComObject WScript.Shell).Exec('git status')"],
      ["$sh = New-Object -ComObject Shell.Application; $sh.ShellExecute('git', 'status')"],
      ['Get-Process', 'it reads processes'],
      ['[Diagnostics.Process]::GetCurrentProcess().Id', 'it reads the current process'],
      ['Get-CimInstance Win32_Process | Select-Object -First 1', 'it reads processes'],
      ['Get-Process node -ErrorAction SilentlyContinue | Stop-Process', 'it stops processes'],
      ['$sw = [Diagnostics.Stopwatch]::StartNew(); $sw.Stop()', 'it times nothing that runs'],
      ['$sb = New-Object System.Text.StringBuilder', 'it makes a string builder'],
    ]);
  });

  // From the worktree `..` is the folder that holds every worktree of the project, and `<UP>` is the project folder.
  it('reads the folder git worktree add, clone and init write, and where git config puts core.worktree', () => {
    const rows: Row[] = [
      ['git worktree add <QP>/feature', REACHES],
      ['git worktree add -b x <UP>/x', REACHES],
      ['git worktree add <UP>/x -b x', REACHES],
      ['git worktree add -fb x <QP>/x', REACHES],
      ['git worktree add -B x --orphan <QP>/x', REACHES],
      ['git worktree add --detach --lock --reason r <QP>/x', REACHES],
      ['git worktree add --det <QP>/x', REACHES],
      ['git worktree add ../bbbbbbbb/x', REACHES],
      ['cd src && git worktree add ../<UP>/x', REACHES],
      ['git -C src worktree add ../<UP>/x', REACHES],
      ['git worktree add "$(cat f)"'],
      ['git worktree add "$(cat f)" ../x <QP>'],
      ['git worktree add --weird ../x'],
      ['git worktree repair ../bbbbbbbb', REACHES],
      ['git worktree add ../feature-x', 'the new worktree is a sibling of this one'],
      ['git worktree add -b x ../x', 'the new worktree is a sibling of this one'],
      ['git worktree add --lock --reason <QP> ../x', 'the reason is text, not the path'],
      ['git worktree add -b feature ../feature "$base"', 'the commit follows the path'],
      ['git worktree list && git worktree prune', 'it lists and prunes'],
      ['git clone https://example.com/r.git <QP>/vendor/r', REACHES],
      ['git clone --separate-git-dir <QP>/g https://example.com/r.git sub', REACHES],
      ['git clone https://example.com/r.git sub --separate-git-dir=<UP>/g', REACHES],
      ['git clone -c core.worktree=<QP> https://example.com/r.git sub', REACHES],
      ["git clone --upload-pack=\"git -C '<P>' add . #\" ../r sub", REACHES],
      ['git clone "$(cat f)" sub'],
      ['git clone --weird x https://example.com/r.git sub'],
      ['git clone https://example.com/r.git sub', 'it clones into the worktree'],
      ['git clone https://example.com/r.git', 'it clones into a folder of the worktree'],
      ['git clone --depth 1 -b main https://example.com/r.git vendor/r', 'it clones into the worktree'],
      ['git clone <QP> sub', 'it reads the project as the source'],
      ['git clone -c user.name=me https://example.com/r.git sub', 'the configuration names no folder'],
      ['git init <QP>/sub', REACHES],
      ['git init <UP>', REACHES],
      ['git init --separate-git-dir <QP>/g newrepo', REACHES],
      ['git init --separate-git-dir ../moved'],
      ['git -C .. init --separate-git-dir ../moved aaaaaaaa'],
      ['git init "$(cat f)"'],
      ['git init newrepo && git init -b main sub && git init --bare ../scratch.git', 'it makes repositories in and beside the worktree'],
      ['git init', 'it reinitializes the worktree in place'],
      ['git config core.worktree <QP>'],
      ['git config core.worktree ../elsewhere'],
      ['git config Core.WorkTree x'],
      ['git config --local core.worktree x'],
      ['git config --add core.worktree x'],
      ['git config --replace-all core.worktree x'],
      ['git config --repl core.worktree x'],
      ['git config set core.worktree x'],
      ['git config set --local core.worktree x'],
      ['git config --unset core.worktree'],
      ['git config unset core.worktree'],
      ['git config --remove-section core'],
      ['git config rename-section core x'],
      ['git config --worktree core.worktree <QP>', REACHES],
      ['git config set --worktree core.worktree <QP>/src', REACHES],
      ['git config --worktree core.worktree ../x'],
      ['git config --worktree core.worktree "$(cat f)"'],
      ['git config --file <QP>/.git/config core.worktree x'],
      ['git config -f <UP>/.git/config core.worktree x'],
      ['git config -f other.cfg core.worktree <QP>', REACHES],
      ['git config "$(cat f)" x'],
      ['git config --weird core.worktree x'],
      ['git config --get core.worktree', 'it reads'],
      ['git config core.worktree', 'it reads'],
      ['git config get core.worktree && git config --get-all core.worktree && git config -l && git config list', 'it reads'],
      ['git config user.name me', 'it sets another key'],
      ['git config user.email "$EMAIL"', 'it sets another key'],
      ['git config set user.name me', 'it sets another key'],
      ['git config core.worktreeX x', 'it sets another key'],
      ['git config --global core.worktree <QP>', 'git does not read core.worktree from the global file'],
      ['git config --system core.worktree x', 'git does not read core.worktree from the system file'],
      ['git config --worktree core.worktree <QW>/src', 'this worktree works in itself'],
      ['git config -f build.cfg core.worktree <QW>/src', 'the file is no repository of the project'],
      ['git config --worktree --unset core.worktree', 'it removes this worktree\'s own setting'],
    ];
    check(bash, rows);
    check(ps, [
      ["git worktree add -b x '<UP>/x'", REACHES],
      ["git clone https://example.com/r.git '<P><S>vendor'", REACHES],
      ['git config core.worktree x'],
      ["git worktree add -b x '../x'", 'the new worktree is a sibling of this one'],
      ['git config --get core.worktree', 'it reads'],
      ['git clone https://example.com/r.git sub', 'it clones into the worktree'],
    ]);
  });

  it('reads the links ln, New-Item and .NET make, and where each one reaches', () => {
    check(bash, [
      ['ln -s <QP> link && cd link && git status', REACHES],
      ['ln -s <QP>/src s', REACHES],
      ['ln -s <UP> p', REACHES],
      ['ln -s ../../../../../../project src/p', REACHES],
      ['ln -sr <UP> src/p', REACHES],
      ['ln --relative --symbolic <UP> src/p', REACHES],
      ['ln <UP>/a.ts src/a.ts', REACHES],
      ['ln -s .. up', REACHES],
      ['ln -s ~ h', REACHES],
      ['ln -s / r', REACHES],
      ['ln -st sub <QP>/src', REACHES],
      ['ln --target-directory=sub -s <QP>', REACHES],
      ['ln --target <QP>/x -s ../y', REACHES],
      ['ln -s -t <QP>/a ../y', REACHES],
      ['ln -sfn <QP> current', REACHES],
      ['ln -s src <QP>/x ../out', REACHES],
      ['ln <QP>/a.ts b.ts', REACHES],
      ['ln -s <QP>/src "$(cat f)"', REACHES],
      ['MSYS=winsymlinks:nativestrict ln -s <QP> l', REACHES],
      [`bash -c "ln -s '<P>' l"`, REACHES],
      ['ln -s "$(cat f)" l'],
      ['ln -s ../x "$(cat f)"'],
      ['ln --weird a b'],
      ['ln -S "$s" -s <QP> l', REACHES],
      ['ln -s ../src/a.ts b.ts', 'the link stays beside the worktree'],
      ['ln -s src/a.ts b.ts && ln src/a.ts c.ts', 'the links stay in the worktree'],
      ['ln -s <UP> src/p', 'read from src, the target is not the project folder'],
      ['ln -s <QW>/src s2', 'the target is in the worktree'],
      ['ln -sf ../../shared/x.json config.json', 'the target is outside every protected area'],
      ['ln --help && ln --version', 'it links nothing'],
    ]);
    check(ps, [
      ["New-Item -ItemType SymbolicLink -Path l -Value '<P>'", REACHES],
      ["New-Item -ItemType Junction l -Target '<P><S>src'", REACHES],
      ["ni -ItemType HardLink -Path b.ts -Value '<UP>/a.ts'", REACHES],
      ["New-Item -ItemType SymbolicLink -Path src/l -Value '<UP>'", REACHES],
      ["New-Item -Type s -Path l -Value '<P>'", REACHES],
      ["New-Item -ItemType '*link' l -Value '<P>'", REACHES],
      ["New-Item -ItemType '?unction' l -Value '<P>'", REACHES],
      ["New-Item -It J -Pa . -Na l -Va '<P>'", REACHES],
      ["New-Item -ItemType $t -Path l -Value '<P>'", REACHES],
      ["New-Item -ItemType SymbolicLink -Path l -Value '..'", REACHES],
      ['New-Item -ItemType SymbolicLink -Path l -Value $d'],
      ['New-Item -ItemType SymbolicLink -Path $p -Value ../x'],
      ["'<P>' | New-Item -ItemType SymbolicLink -Path l"],
      ["[IO.Directory]::CreateSymbolicLink('l', '<P>')"],
      ["[System.IO.File]::CreateSymbolicLink('l', 'x')"],
      ["(Get-Item x).CreateAsSymbolicLink('<P>')"],
      ['New-Item -ItemType Directory x', 'it makes a folder'],
      ["New-Item -ItemType File a.txt -Value '<P>'", 'the value is the file\'s text'],
      ['New-Item -ItemType SymbolicLink -Path l -Value src', 'the target is in the worktree'],
      ["New-Item -ItemType Junction -Path out -Value '<W><S>build'", 'the target is in the worktree'],
      ['ni x -ItemType Dir', 'it makes a folder'],
      ["New-Item -ItemType SymbolicLinkX -Path l -Value '<P>'", 'PowerShell knows no such type'],
      ["[IO.Directory]::CreateDirectory('x')", 'it makes a folder'],
    ]);
  });

  it.skipIf(process.platform !== 'win32')('reads the links mklink makes as cmd does, from Bash and PowerShell', () => {
    const rows: Row[] = [
      ['cmd /c mklink /D out <UP>', REACHES],
      ['cmd /c mklink out <UP>', REACHES],
      ['cmd /c mklink /J sub\\out <UP>', REACHES],
      ['cmd /c mklink /H b.ts <UP>\\a.ts', REACHES],
      ['cmd /c mklink out <UP> /J', REACHES],
      ['cmd /c mklink /j "out" "<P>\\src"', REACHES],
      ['cmd /c mklink /D sub\\out <UP>', 'read from sub, the target is not the project folder'],
      ['cmd /c mklink /J out build', 'the target is in the worktree'],
      ['cmd /c mklink /J a b c', 'mklink refuses a third operand'],
      ['cmd /c mklink /X out <UP>', 'mklink refuses an unknown switch'],
    ];
    check(ps, [...rows, ["cmd /c mklink /J out '<P>'", REACHES], ['cmd /c mklink /J out $d']]);
    check(bash, rows.map(([command, verdict]) => [command.replace('cmd /c ', 'cmd //c ').replaceAll('\\', '\\\\'), verdict] as Row));
  });

  it('applies in the gate in every mode, YOLO included, and before a hook\'s force-allow', async () => {
    const context = {
      permissionHandler: { matchRule: async () => undefined, canUseTool: async () => ({ behavior: 'allow' }), getPermissionMode: () => 'bypassPermissions', getDangerouslySkipPermissions: () => true },
      isPlanMode: () => false,
      shellCancel: { admit: () => undefined, releaseAdmitted: () => undefined, takeCancellation: () => undefined },
      worktreeIsolation: () => iso,
    } as unknown as GatePermissionContext;
    const event = { type: 'tool_call', toolName: 'write', toolCallId: 't1', input: { path: path.join(project, 'a.ts'), content: 'x' } };
    const hook = { run: async () => ({ decision: 'allow' as const, systemMessages: [], mutated: false, anyFailed: false }), onDecision: () => undefined, notify: () => undefined, stashContext: () => undefined };
    const result = await runPermissionGate(event as never, context, undefined, null, hook as never);
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('Blocked by Damocles policy:');
    expect(result?.reason).toContain(WORKTREE_ISOLATION_REASON);
  });
});
