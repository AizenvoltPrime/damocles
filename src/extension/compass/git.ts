import * as childProcess from 'child_process';
import * as path from 'path';
import { isWithinRoot } from './util';

export const GIT_TIMEOUT: number = 30_000;
export const SAFE_GIT_REF: RegExp = /^(?!-)[A-Za-z0-9_.~^/@{}-]+$/;

const repoRootCache = new Map<string, string | null>();

export function resetRepoRootCacheForTests(): void {
	repoRootCache.clear();
}

function runGit(command: string, cwd: string): string {
	return childProcess.execSync(command, {
		cwd, encoding: 'utf8', timeout: GIT_TIMEOUT, stdio: ['pipe', 'pipe', 'pipe'],
	});
}

export function resolveRepoRoot(workspaceRoot: string): string | null {
	const cached = repoRootCache.get(workspaceRoot);
	if (cached !== undefined) return cached;

	let repoRoot: string | null;
	try {
		const stdout = runGit('git rev-parse --show-toplevel', workspaceRoot);
		const trimmed = stdout.trim();
		repoRoot = trimmed ? path.resolve(trimmed) : null;
	} catch {
		return null;
	}
	if (repoRoot !== null) repoRootCache.set(workspaceRoot, repoRoot);
	return repoRoot;
}

function toRepoAbsolute(repoRoot: string, gitRelativePath: string): string {
	return path.resolve(repoRoot, gitRelativePath).replace(/\\/g, '/');
}

/** Git spells the drive letter/root its own way on Windows; downstream lookups are case-sensitive, so re-anchor onto the caller's workspace spelling. */
function reanchorOnWorkspace(workspaceResolved: string, absolutePath: string): string {
	return path.resolve(workspaceResolved, path.relative(workspaceResolved, absolutePath)).replace(/\\/g, '/');
}

export function getChangedFiles(workspaceRoot: string, base: string = 'HEAD~1'): string[] {
	if (!SAFE_GIT_REF.test(base)) return [];

	let stdout: string;
	try {
		stdout = runGit(`git diff --name-only ${base} --`, workspaceRoot);
	} catch {
		try {
			stdout = runGit('git diff --name-only --cached', workspaceRoot);
		} catch {
			return [];
		}
	}

	const repoRoot = resolveRepoRoot(workspaceRoot) ?? workspaceRoot;
	const workspaceResolved = path.resolve(workspaceRoot);
	return stdout.split('\n')
		.map(l => l.trim())
		.filter(Boolean)
		.map(rel => toRepoAbsolute(repoRoot, rel))
		.filter(abs => isWithinRoot(abs, workspaceResolved))
		.map(abs => reanchorOnWorkspace(workspaceResolved, abs));
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
		stdout = runGit(`git diff --unified=0 ${base} --`, workspaceRoot);
	} catch {
		return new Map();
	}

	const repoRoot = resolveRepoRoot(workspaceRoot) ?? workspaceRoot;
	const remapped = new Map<string, Array<[number, number]>>();
	for (const [gitRelativePath, ranges] of parseUnifiedDiff(stdout)) {
		remapped.set(toRepoAbsolute(repoRoot, gitRelativePath), ranges);
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
