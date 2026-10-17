import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { git, initRepo, type GitHome } from './git';
import type { HermeticHome } from './hermetic';

// Repositories and processes the worktree chat specs (slice 12a) start from. Everything lives under the hermetic root, and
// the app's worktrees under the hermetic home's ~/.damocles/worktrees.

export interface WorktreeRepoOptions {
  // committed files, forward-slash paths; a.ts by default
  readonly files?: Record<string, string>;
  // .worktreeinclude's text (D32), committed
  readonly worktreeInclude?: string;
  // .damocles/worktree.json (D32), committed
  readonly setup?: { readonly setup?: readonly string[]; readonly setupWindows?: readonly string[]; readonly setupUnix?: readonly string[] };
  // files listed in .gitignore and written, never committed (a .env for .worktreeinclude)
  readonly ignored?: Record<string, string>;
  // more local branches, each one commit ahead of the first branch, which stays checked out
  readonly branches?: readonly string[];
  // a bare remote named origin that has the first branch, plus this many commits the local branch lacks ("{n} newer")
  readonly remoteNewer?: number;
  // left uncommitted in the project folder after the setup above (D63's Bring my uncommitted changes)
  readonly modified?: Record<string, string>;
  readonly untracked?: Record<string, string>;
  // the project folder is this subfolder of the repository (D30's project in a subfolder)
  readonly subfolder?: string;
}

export interface WorktreeRepo {
  // the repository's top level
  readonly root: string;
  // the folder to add as the project: root, or its subfolder
  readonly project: string;
  // the bare remote, when remoteNewer was given
  readonly remote?: string;
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, ...name.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
}

/** A repository at `root` set up for worktree chats: include file, setup commands, ignored files, branches, a remote, local edits. */
export async function worktreeRepo(h: GitHome, root: string, options: WorktreeRepoOptions = {}): Promise<WorktreeRepo> {
  const ignored = options.ignored ?? {};
  const files: Record<string, string> = {
    ...(options.files ?? { 'a.ts': 'export const a = 1;\n' }),
    ...(Object.keys(ignored).length > 0 ? { '.gitignore': `${Object.keys(ignored).join('\n')}\n` } : {}),
    ...(options.worktreeInclude !== undefined ? { '.worktreeinclude': options.worktreeInclude } : {}),
    ...(options.setup ? { '.damocles/worktree.json': `${JSON.stringify(options.setup, null, 2)}\n` } : {}),
  };
  await initRepo(h, root, files);
  writeFiles(root, ignored);
  for (const branch of options.branches ?? []) {
    await git(h, root, 'switch', '-c', branch);
    writeFiles(root, { [`${branch.replace(/\//g, '-')}.txt`]: `${branch}\n` });
    await git(h, root, 'add', '-A');
    await git(h, root, 'commit', '-m', `On ${branch}`);
    await git(h, root, 'switch', 'main');
  }
  let remote: string | undefined;
  if (options.remoteNewer !== undefined) {
    remote = `${root}-remote.git`;
    await git(h, path.dirname(root), 'init', '--bare', '-b', 'main', remote);
    await git(h, root, 'remote', 'add', 'origin', remote);
    await git(h, root, 'push', '-u', 'origin', 'main');
    const other = `${root}-other`;
    await git(h, path.dirname(root), 'clone', remote, other);
    for (let commit = 1; commit <= options.remoteNewer; commit++) {
      writeFiles(other, { [`remote-${commit}.txt`]: `${commit}\n` });
      await git(h, other, 'add', '-A');
      await git(h, other, 'commit', '-m', `Remote ${commit}`);
    }
    await git(h, other, 'push', 'origin', 'main');
    await git(h, root, 'fetch', 'origin');
  }
  writeFiles(root, { ...(options.modified ?? {}), ...(options.untracked ?? {}) });
  const project = options.subfolder !== undefined ? path.join(root, ...options.subfolder.split('/')) : root;
  fs.mkdirSync(project, { recursive: true });
  return { root, project, ...(remote !== undefined ? { remote } : {}) };
}

/** ~/.damocles/worktrees in the hermetic home, where the app creates chat worktrees. */
export function worktreesRoot(h: HermeticHome): string {
  return path.join(h.damoclesDir, 'worktrees');
}

export interface RegistryRecord {
  readonly id: string;
  readonly kind: 'chat' | 'adopted';
  readonly projectPath?: string;
  readonly worktreeRoot: string;
  readonly workingFolder: string;
  readonly branch?: string;
  readonly index?: number;
  readonly deletedAt?: number;
}

/** The worktree registry's records as the app last wrote them; none before it wrote any. */
export function registryRecords(h: HermeticHome): RegistryRecord[] {
  const file = path.join(worktreesRoot(h), 'registry.json');
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { records?: RegistryRecord[] };
  return parsed.records ?? [];
}

export interface HeldFile {
  // the holder's pid, which Restart Manager reports
  readonly pid: number;
  // ends the holder and resolves once it exited, so a retried delete can remove the file
  release(): Promise<void>;
}

/**
 * A process outside Damocles that keeps `file` open until released: on Windows an open handle refuses the delete git's
 * `worktree remove` needs (D33's failure case); elsewhere a cwd inside the folder, which git's remove does not mind.
 */
export async function holdFile(file: string): Promise<HeldFile> {
  const script = `const fs = require('fs'); const fd = fs.openSync(${JSON.stringify(file)}, 'r'); process.stdout.write('held\\n'); setInterval(() => fs.fstatSync(fd), 1000);`;
  const child: ChildProcess = spawn(process.execPath, ['-e', script], { cwd: path.dirname(file), stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`the file holder exited with ${code}`)));
    child.stdout!.once('data', () => resolve());
  });
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  return {
    pid: child.pid!,
    release: async () => {
      child.kill();
      await exited;
    },
  };
}
