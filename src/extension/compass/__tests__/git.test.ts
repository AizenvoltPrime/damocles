import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { GraphStore } from '../database';
import type { NodeInfo } from '../types';
import { createTestStore } from './sql-test-helper';

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock('child_process', () => ({ execFileSync: execFileSyncMock }));

import { getChangedFiles, parseGitDiffRanges, resolveRepoRoot, resetRepoRootCacheForTests, GIT_HARDENING_ARGS } from '../git';
import { analyzeChanges, mapChangesToNodes } from '../changes';


beforeEach(() => {
	execFileSyncMock.mockReset();
	resetRepoRootCacheForTests();
});

/** The argv of one recorded call, minus the hardening prefix. */
function subcommandArgs(call: unknown[]): string[] {
	return (call[1] as string[]).slice(GIT_HARDENING_ARGS.length);
}

function abs(root: string, rel: string): string {
	return path.resolve(root, rel).replace(/\\/g, '/');
}

function makeNode(overrides: Partial<NodeInfo> & { name: string; file_path: string }): NodeInfo {
	return { kind: 'Function', line_start: 1, line_end: 10, ...overrides };
}

function mockGit(handlers: { revParse?: () => string; diff?: (args: string[]) => string }): void {
	execFileSyncMock.mockImplementation((file: unknown, args: unknown) => {
		const argv = (args as string[]).slice(GIT_HARDENING_ARGS.length);
		if (file !== 'git') throw new Error(`unexpected executable: ${String(file)}`);
		if (argv[0] === 'rev-parse' && argv[1] === '--show-toplevel') {
			if (!handlers.revParse) throw new Error('fatal: not a git repository');
			return handlers.revParse();
		}
		if (argv[0] === 'diff') {
			if (!handlers.diff) throw new Error('git diff failed');
			return handlers.diff(argv);
		}
		throw new Error(`unexpected git command: ${argv.join(' ')}`);
	});
}

function revParseCallCount(): number {
	return execFileSyncMock.mock.calls.filter(c => subcommandArgs(c)[0] === 'rev-parse').length;
}

describe('git invocation hardening', () => {
	it('overrides core.fsmonitor, which the repository sets and git runs as a command', () => {
		mockGit({ revParse: () => '/repo-h-1\n', diff: () => 'src/a.ts\n' });

		getChangedFiles('/repo-h-1');
		parseGitDiffRanges('/repo-h-1');

		expect(execFileSyncMock.mock.calls.length).toBeGreaterThan(0);
		for (const call of execFileSyncMock.mock.calls) {
			const argv = call[1] as string[];
			expect(argv.slice(0, 2)).toEqual(['-c', 'core.fsmonitor=false']);
			expect(argv.indexOf('core.fsmonitor=false')).toBeLessThan(argv.findIndex(a => a === 'diff' || a === 'rev-parse'));
		}
	});

	it('hardens the staged-diff fallback too', () => {
		mockGit({
			revParse: () => '/repo-h-2\n',
			diff: args => {
				if (args.includes('--cached')) return 'src/c.ts\n';
				throw new Error('bad revision');
			},
		});

		getChangedFiles('/repo-h-2');

		const staged = execFileSyncMock.mock.calls.find(c => (c[1] as string[]).includes('--cached'));
		expect(staged).toBeDefined();
		expect((staged![1] as string[]).slice(0, 2)).toEqual(['-c', 'core.fsmonitor=false']);
	});

	it('passes git an argv and no shell, so a ref reaching argv is never re-parsed', () => {
		mockGit({ revParse: () => '/repo-h-3\n', diff: () => 'src/a.ts\n' });

		getChangedFiles('/repo-h-3', 'release/1.0');

		for (const call of execFileSyncMock.mock.calls) {
			expect(call[0]).toBe('git');
			expect(Array.isArray(call[1])).toBe(true);
			expect(call[2]).not.toHaveProperty('shell');
		}
		const diff = execFileSyncMock.mock.calls.find(c => subcommandArgs(c)[0] === 'diff');
		expect(subcommandArgs(diff!)).toEqual(['diff', '--name-only', 'release/1.0', '--']);
	});

	it('passes no GIT_DIR/GIT_WORK_TREE env, which would retarget the checkpoint engine bare repo', () => {
		mockGit({ revParse: () => '/repo-h-4\n', diff: () => 'src/a.ts\n' });

		getChangedFiles('/repo-h-4');

		for (const call of execFileSyncMock.mock.calls) {
			expect((call[2] as { env?: unknown }).env).toBeUndefined();
		}
	});
});

describe('resolveRepoRoot', () => {
	it('returns the resolved repo root from rev-parse', () => {
		mockGit({ revParse: () => '/repo-rr-1\n' });
		expect(resolveRepoRoot('/repo-rr-1/packages/app')).toBe(path.resolve('/repo-rr-1'));
	});

	it('returns null outside a git repo', () => {
		mockGit({});
		expect(resolveRepoRoot('/no-repo-rr-2')).toBeNull();
	});

	it('caches the result per workspace path', () => {
		mockGit({ revParse: () => '/repo-rr-3\n' });
		resolveRepoRoot('/repo-rr-3');
		resolveRepoRoot('/repo-rr-3');
		expect(revParseCallCount()).toBe(1);
	});

	it('does not cache failures: a transient rev-parse error resolves on retry', () => {
		mockGit({});
		expect(resolveRepoRoot('/flaky-rr-4')).toBeNull();

		mockGit({ revParse: () => '/flaky-rr-4\n' });
		expect(resolveRepoRoot('/flaky-rr-4')).toBe(path.resolve('/flaky-rr-4'));
		expect(revParseCallCount()).toBe(2);

		expect(resolveRepoRoot('/flaky-rr-4')).toBe(path.resolve('/flaky-rr-4'));
		expect(revParseCallCount()).toBe(2);
	});
});

describe('getChangedFiles', () => {
	it('returns repo-root-absolute paths when workspace equals repo root', () => {
		mockGit({
			revParse: () => '/repo-gc-1\n',
			diff: () => 'src/a.ts\nsrc/b.ts\n',
		});

		const files = getChangedFiles('/repo-gc-1');
		expect(files).toEqual([abs('/repo-gc-1', 'src/a.ts'), abs('/repo-gc-1', 'src/b.ts')]);
	});

	it('resolves against the repo root and scopes results to the workspace (P2/M2)', () => {
		mockGit({
			revParse: () => '/repo-gc-2\n',
			diff: () => 'packages/app/src/a.ts\npackages/lib/src/b.ts\n',
		});

		const files = getChangedFiles('/repo-gc-2/packages/app');
		expect(files).toEqual([abs('/repo-gc-2', 'packages/app/src/a.ts')]);
	});

	it('filters out repo files outside the workspace so siblings never get indexed (M2)', () => {
		mockGit({
			revParse: () => '/repo-gc-6\n',
			diff: () => [
				'packages/app/src/kept.ts',
				'packages/lib/src/sibling.ts',
				'tooling/scripts/build.ts',
				'packages/app/nested/deep.ts',
			].join('\n') + '\n',
		});

		const files = getChangedFiles('/repo-gc-6/packages/app');
		expect(files).toEqual([
			abs('/repo-gc-6', 'packages/app/src/kept.ts'),
			abs('/repo-gc-6', 'packages/app/nested/deep.ts'),
		]);
	});

	it('re-anchors git paths onto the workspace spelling when git reports a different drive-letter case (win32)', () => {
		if (process.platform !== 'win32') return;
		mockGit({
			revParse: () => 'C:/Repo-Case\n',
			diff: () => 'src/a.ts\nSrc-Sub/b.ts\n',
		});

		const files = getChangedFiles('c:/repo-case');
		expect(files).toEqual(['c:/repo-case/src/a.ts', 'c:/repo-case/Src-Sub/b.ts']);
	});

	it('falls back to the workspace root outside a git repo', () => {
		mockGit({ diff: () => 'src/a.ts\n' });

		const files = getChangedFiles('/no-repo-gc-3');
		expect(files).toEqual([abs('/no-repo-gc-3', 'src/a.ts')]);
	});

	it('rejects unsafe base refs without invoking git', () => {
		mockGit({ revParse: () => '/repo-gc-4\n', diff: () => 'src/a.ts\n' });

		expect(getChangedFiles('/repo-gc-4', 'HEAD; rm -rf /')).toEqual([]);
		expect(execFileSyncMock).not.toHaveBeenCalled();
	});

	it('rejects leading-dash refs that would inject git options', () => {
		mockGit({ revParse: () => '/repo-gc-7\n', diff: () => 'src/a.ts\n' });

		expect(getChangedFiles('/repo-gc-7', '--ext-diff')).toEqual([]);
		expect(getChangedFiles('/repo-gc-7', '-')).toEqual([]);
		expect(parseGitDiffRanges('/repo-gc-7', '--no-index').size).toBe(0);
		expect(execFileSyncMock).not.toHaveBeenCalled();
	});

	it('falls back to staged diff when the base diff fails', () => {
		mockGit({
			revParse: () => '/repo-gc-5\n',
			diff: cmd => {
				if (cmd.includes('--cached')) return 'src/c.ts\n';
				throw new Error('bad revision');
			},
		});

		expect(getChangedFiles('/repo-gc-5')).toEqual([abs('/repo-gc-5', 'src/c.ts')]);
	});
});

describe('parseGitDiffRanges', () => {
	it('remaps diff keys to repo-root-absolute paths', () => {
		mockGit({
			revParse: () => '/repo-pd-1\n',
			diff: () => [
				'+++ b/packages/app/src/x.ts',
				'@@ -5,2 +5,3 @@',
			].join('\n'),
		});

		const ranges = parseGitDiffRanges('/repo-pd-1/packages/app');
		expect(ranges.get(abs('/repo-pd-1', 'packages/app/src/x.ts'))).toEqual([[5, 7]]);
		expect(ranges.has('packages/app/src/x.ts')).toBe(false);
	});

	it('remaps against the workspace root outside a git repo', () => {
		mockGit({
			diff: () => [
				'+++ b/src/y.ts',
				'@@ -1,2 +1,2 @@',
			].join('\n'),
		});

		const ranges = parseGitDiffRanges('/no-repo-pd-2');
		expect(ranges.get(abs('/no-repo-pd-2', 'src/y.ts'))).toEqual([[1, 2]]);
	});

	it('returns an empty map when git diff fails', () => {
		mockGit({ revParse: () => '/repo-pd-3\n' });
		expect(parseGitDiffRanges('/repo-pd-3').size).toBe(0);
	});

	it('rejects unsafe base refs without invoking git', () => {
		mockGit({ revParse: () => '/repo-pd-4\n', diff: () => '+++ b/src/a.ts\n@@ -1 +1 @@' });

		expect(parseGitDiffRanges('/repo-pd-4', '$(whoami)').size).toBe(0);
		expect(execFileSyncMock).not.toHaveBeenCalled();
	});
});

describe('monorepo graph resolution with remapped paths (P2)', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	const workspace = '/repo-mono/packages/a';
	const realFile = abs(workspace, 'src/x.ts');
	const decoyFile = abs(workspace, 'vendor/packages/a/src/x.ts');

	function seedMonorepo(): void {
		store = createTestStore();
		store.upsertNode(makeNode({ name: 'realFunc', file_path: realFile, line_start: 1, line_end: 10 }));
		store.upsertNode(makeNode({ name: 'decoyFunc', file_path: decoyFile, line_start: 1, line_end: 10 }));
	}

	it('raw repo-relative keys over-match both files via the suffix fallback', () => {
		seedMonorepo();

		const resolved = store.resolveGraphFilePathsGrouped(['packages/a/src/x.ts'], workspace);
		expect(resolved.get('packages/a/src/x.ts')).toHaveLength(2);
	});

	it('remapped diff keys resolve to exactly one file', () => {
		seedMonorepo();
		mockGit({
			revParse: () => '/repo-mono\n',
			diff: () => [
				'+++ b/packages/a/src/x.ts',
				'@@ -1,5 +1,5 @@',
			].join('\n'),
		});

		const ranges = parseGitDiffRanges(workspace);
		const resolved = store.resolveGraphFilePathsGrouped([...ranges.keys()], workspace);
		expect(resolved.get(abs('/repo-mono', 'packages/a/src/x.ts'))).toEqual([realFile]);

		const nodes = mapChangesToNodes(store, ranges, workspace);
		expect(nodes.map(n => n.name)).toEqual(['realFunc']);
	});

	it('analyzeChanges with internally-parsed git ranges only analyzes the changed package', () => {
		seedMonorepo();
		mockGit({
			revParse: () => '/repo-mono\n',
			diff: () => [
				'+++ b/packages/a/src/x.ts',
				'@@ -1,5 +1,5 @@',
			].join('\n'),
		});

		const analysis = analyzeChanges(store, [realFile], undefined, workspace);
		expect(analysis.risks.map(r => r.node.name)).toEqual(['realFunc']);
		expect(analysis.risks.every(r => r.node.file_path === realFile)).toBe(true);
	});
});
