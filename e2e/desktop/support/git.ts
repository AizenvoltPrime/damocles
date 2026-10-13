import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { hermeticEnv, type HermeticHome } from './hermetic';

const execFileAsync = promisify(execFile);

export type GitHome = Pick<HermeticHome, 'root' | 'home'>;

/**
 * Runs git in `cwd` with the launched app's environment on `h`, so neither side reads the developer's or the system's git
 * config, as a fixed identity with commit signing off; resolves with its trimmed stdout. `init` copies in no template hooks.
 */
export async function git(h: GitHome, cwd: string, ...args: string[]): Promise<string> {
  const command = args[0] === 'init' ? ['init', '--template=', ...args.slice(1)] : args;
  // The app's git reads the same file through HOME; a missing file reads as empty.
  const env = { ...hermeticEnv(h), GIT_CONFIG_GLOBAL: path.join(h.home, '.gitconfig') };
  const { stdout } = await execFileAsync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', '-c', 'commit.gpgsign=false', ...command], { cwd, env, encoding: 'utf8' });
  return stdout.trim();
}

export interface InitRepoOptions {
  readonly branch?: string;
  /** The repository's own user.name and user.email, which the app's commits use; false leaves none, as the hermetic home has none. */
  readonly identity?: { readonly name: string; readonly email: string } | false;
}

/** A repository at `dir` whose first commit holds `files` (forward-slash relative paths). */
export async function initRepo(h: GitHome, dir: string, files: Record<string, string> = { 'a.ts': 'export const a = 1;\n' }, options: InitRepoOptions = {}): Promise<void> {
  const identity = options.identity ?? { name: 'Scm Tester', email: 'scm@example.com' };
  fs.mkdirSync(dir, { recursive: true });
  await git(h, dir, 'init', '-b', options.branch ?? 'main');
  if (identity) {
    await git(h, dir, 'config', 'user.name', identity.name);
    await git(h, dir, 'config', 'user.email', identity.email);
  }
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, ...name.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  await git(h, dir, 'add', '-A');
  await git(h, dir, 'commit', '-m', 'Initial commit');
}
