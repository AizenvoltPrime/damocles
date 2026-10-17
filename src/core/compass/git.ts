import * as childProcess from 'child_process';
import * as path from 'path';
import { gitExecutable } from '../git-executable';

export const GIT_TIMEOUT: number = 30_000;
export const SAFE_GIT_REF: RegExp = /^(?!-)[A-Za-z0-9_.~^/@{}-]+$/;

/**
 * Prefixed to every git invocation. Git reads the repository's own `.git/config` before anything
 * else, and `core.fsmonitor` there names a command git runs while refreshing the index.
 */
export const GIT_HARDENING_ARGS: readonly string[] = ['-c', 'core.fsmonitor=false'];

function runGit(args: string[], cwd: string): string {
	// `execFileSync`, not `execSync`: no shell, so a ref or path that reaches argv is never re-parsed.
	// No `ExecEnv` either, since the checkpoint engine's overrides retarget git at its private bare repo.
	// Every caller catches, so no git found reads as a git failure.
	return childProcess.execFileSync(gitExecutable(), [...GIT_HARDENING_ARGS, ...args], {
		cwd, encoding: 'utf8', timeout: GIT_TIMEOUT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
	});
}

// The diffs run with --relative, so git prints paths relative to the workspace and leaves out the rest of the repository:
// no path git spells (its toplevel is a realpath, 8.3 names expanded and links followed) meets the workspace's own spelling.
function toWorkspaceAbsolute(workspaceRoot: string, relativePath: string): string {
	return path.resolve(workspaceRoot, relativePath).replace(/\\/g, '/');
}

export function getChangedFiles(workspaceRoot: string, base: string = 'HEAD~1'): string[] {
	if (!SAFE_GIT_REF.test(base)) return [];

	let stdout: string;
	try {
		stdout = runGit(['diff', '--name-only', '--relative', base, '--'], workspaceRoot);
	} catch {
		try {
			stdout = runGit(['diff', '--name-only', '--relative', '--cached'], workspaceRoot);
		} catch {
			return [];
		}
	}

	return stdout.split('\n')
		.map(l => l.trim())
		.filter(Boolean)
		.map(rel => toWorkspaceAbsolute(workspaceRoot, rel));
}

export function parseGitDiffRanges(
	workspaceRoot: string,
	base: string = 'HEAD~1',
): Map<string, Array<[number, number]>> {
	if (!SAFE_GIT_REF.test(base)) {
		return new Map();
	}

	let stdout: string;
	try {
		stdout = runGit(['diff', '--unified=0', '--relative', base, '--'], workspaceRoot);
	} catch {
		return new Map();
	}

	const remapped = new Map<string, Array<[number, number]>>();
	for (const [relativePath, ranges] of parseUnifiedDiff(stdout)) {
		remapped.set(toWorkspaceAbsolute(workspaceRoot, relativePath), ranges);
	}
	return remapped;
}

export function parseUnifiedDiff(diffText: string): Map<string, Array<[number, number]>> {
	const ranges = new Map<string, Array<[number, number]>>();
	let currentFile: string | null = null;

	const filePattern = /^\+\+\+ b\/(.+)$/;
	const hunkPattern = /^@@ .+? \+(\d+)(?:,(\d+))? @@/;

	for (const rawLine of diffText.split('\n')) {
		const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
		const fileMatch = filePattern.exec(line);
		if (fileMatch) {
			currentFile = fileMatch[1] ?? null;
			continue;
		}

		const hunkMatch = hunkPattern.exec(line);
		if (hunkMatch && currentFile !== null) {
			const start = parseInt(hunkMatch[1]!, 10);
			const count = hunkMatch[2] !== undefined ? parseInt(hunkMatch[2], 10) : 1;
			const end = count === 0 ? start : start + count - 1;

			let fileRanges = ranges.get(currentFile);
			if (!fileRanges) {
				fileRanges = [];
				ranges.set(currentFile, fileRanges);
			}
			fileRanges.push([start, end]);
		}
	}

	return ranges;
}
