import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nativeShellPath, worktreeIsolationBlock, WORKTREE_ISOLATION_REASON, type WorktreeIsolation } from '../worktree-isolation';
import { parseShellStructure } from '../readonly-shell';
import { runPermissionGate, type GatePermissionContext } from '../permission-gate';

let base: string;
let iso: WorktreeIsolation;
let project: string;
let worktree: string;

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dam-iso-')));
  project = path.join(base, 'project');
  worktree = path.join(base, 'home', '.damocles', 'worktrees', 'project-abcdef', 'aaaaaaaa');
  const other = path.join(base, 'home', '.damocles', 'worktrees', 'project-abcdef', 'bbbbbbbb');
  for (const dir of [project, worktree, other]) fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  iso = { workingFolder: worktree, projectPath: project, repositoryRoot: project, otherWorktrees: [other], homeDir: path.join(base, 'home') };
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

const bash = (command: string): string | undefined => worktreeIsolationBlock('Bash', { command }, iso);
const ps = (command: string): string | undefined => worktreeIsolationBlock('PowerShell', { command }, iso);
const q = (p: string): string => JSON.stringify(p);

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
    expect(bash('cd "$PROJECT" && git status')).toContain('computed');
    expect(bash('git -C "$DIR" status')).toContain('computed');
    expect(bash('$GIT status')).toContain('computed');
    expect(bash('$(echo git) status')).toContain('computed');
    expect(bash('export GIT_DIR=$X')).toContain('computed');
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

  it('blocks a PowerShell working directory in the project folder, and only that', () => {
    expect(ps(`Set-Location ${q(project)}; git status`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(ps(`cd -LiteralPath '${project}'`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(ps(`Push-Location ${q(path.join(project, 'src'))}`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(ps('Set-Location $env:PROJECT')).toContain('computed');
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
    expect(bash('cmd /c "cd C:\\x && git add ."')).toContain(WORKTREE_ISOLATION_REASON);
  });

  it('treats globs, brace expansions, ~user and comments as the shell does', () => {
    expect(bash(`git {-C,${project.split(path.sep).join('/')}} add .`)).toContain('computed');
    expect(bash(`cd ${q(base)}/pro?ect && git add .`)).toBeDefined();
    expect(bash('cd ~root && git status')).toContain('computed');
    expect(bash(`echo hi #'\ncd ${q(project)} && git add .\n'`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`cat <<EOF\n$(cd ${q(project)} && git add .)\nEOF`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash(`cd -- ${q(project)} && git status`)).toContain(WORKTREE_ISOLATION_REASON);
    expect(bash('pushd -n /x; pushd')).toContain('pushd');
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
    expect(bash('cmd //c "g^it status"')).toContain('rewrites');
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
    expect(ps(`Set-Location (Join-Path 'C:' 'x')`)).toContain('computed');
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
    expect(parsed.segments[0]!.assignments).toEqual([{ name: 'a', value: '1', raw: '1' }]);
    expect(parsed.segments[1]!.substitutions[0]!.segments[0]!.words).toEqual(['echo', 'z']);
    const loop = parseShellStructure('for f in $(ls); do :; done < <(git ls-files)');
    expect(loop.unparsable).toBe(false);
    expect(loop.segments[0]).toMatchObject({ assignments: [{ name: 'f', value: undefined }], words: [] });
    expect(loop.segments[0]!.substitutions[0]!.segments[0]!.words).toEqual(['ls']);
    expect(loop.segments.at(-1)!.substitutions[0]!.segments[0]!.words).toEqual(['git', 'ls-files']);
    const array = parseShellStructure('arr=(a "b c" $(pwd))');
    expect(array.segments[0]!.assignments).toEqual([{ name: 'arr', value: undefined, raw: '(a "b c" $(pwd))' }]);
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
    expect(bash('GIT_DIR="$D" git log')).toContain('computed');
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
  // double-quoted, `<S>` the host's path separator, which git takes as one; a row with a reason is allowed.
  type Row = readonly [command: string, allowedBecause?: string];
  const expand = (command: string): string =>
    command.replaceAll('<QP>', q(project)).replaceAll('<FP>', project.split(path.sep).join('/')).replaceAll('<P>', project).replaceAll('<QB>', q(base)).replaceAll('<S>', path.sep);
  const check = (run: (command: string) => string | undefined, rows: readonly Row[]): void => {
    for (const [command, allowedBecause] of rows) {
      const result = run(expand(command));
      if (allowedBecause === undefined) expect(result, command).toContain(WORKTREE_ISOLATION_REASON);
      else expect(result, command).toBeUndefined();
    }
  };

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
      ['GIT_EDITOR="$E" git commit'],
      ['git -c credential.helper=store fetch', 'the helper is git credential-store, which runs in the worktree'],
      ['git -c core.fsmonitor=true status', 'true runs nothing'],
      ['PAGER=less EDITOR=vim git log', 'the pager and editor run in the worktree'],
      // Hooks run at the worktree's top level (githooks: "the root of the working tree"), and a hook file's text is never read, as `./build.sh` is not.
      ['git -c core.hooksPath=<QP>/.git/hooks commit -m x', 'its hooks run in the worktree and their text is a file, not command text'],
      // Arithmetic on counted input is ordinary, so text that reaches a variable from outside the command stays an accepted limit.
      ['n=$(wc -l < f); echo $((n+1))', 'wc runs in the worktree'],
    ]);
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
      ['source "$F"; git status'],
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
      ['GIT_SSH_COMMAND="ssh -i $K" git push', 'K comes from outside the command'],
      ['export GIT_SSH_COMMAND="ssh -i ${HOME}/.ssh/id -o \'IdentitiesOnly yes\'"; git fetch', 'HOME comes from outside the command'],
      ['GIT_SSH_COMMAND="ssh \'$K\'" git push', 'K is an ssh argument'],
      ['K="x; git -C <FP> add ."; GIT_SSH_COMMAND="ssh -i $K" git push'],
      ['read K <<< x; GIT_SSH_COMMAND="ssh -i $K" git push'],
      ['read <<< x; GIT_SSH_COMMAND="ssh -i $REPLY" git push'],
      ['GIT_SSH_COMMAND="$CMD -i k" git push'],
      ['GIT_SSH_COMMAND="git -C \'$D\' add ." git fetch'],
      ['GIT_SSH_COMMAND="cd $D && ssh" git fetch'],
      ['GIT_SSH_COMMAND="ssh $1" git push'],
      ['GIT_SSH_COMMAND="ssh ${K:-x}" git push'],
      ['GIT_SSH_COMMAND="ssh $(cat k)" git push'],
      ['env GIT_SSH_COMMAND="ssh -i $K" git push', 'K comes from outside the command'],
      ['export GIT_SSH_COMMAND="ssh -i $K"', 'K comes from outside the command'],
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

  it('blocks PowerShell nested deeper than the parse follows, instead of failing', () => {
    expect(ps(`${'('.repeat(20000)}git status${')'.repeat(20000)}`)).toContain('parsed');
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
