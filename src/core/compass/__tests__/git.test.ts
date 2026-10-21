import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { GraphStore } from '../database';
import type { NodeInfo } from '../types';
import { createTestStore } from './sql-test-helper';

const { execFileMock, GIT } = vi.hoisted(() => ({ execFileMock: vi.fn(), GIT: '/resolved/bin/git' }));
vi.mock('child_process', () => ({ execFile: execFileMock }));
vi.mock('../../git-executable', () => ({ gitExecutable: () => GIT }));

import { getChangedFiles, parseGitDiffRanges } from '../git';
import { GIT_HARDENING_ARGS } from '../../git-hardening';
import { analyzeChanges, mapChangesToNodes } from '../changes';


beforeEach(() => {
	execFileMock.mockReset();
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
	const answer = (file: unknown, argv: string[]): string => {
		if (file !== GIT) throw new Error(`unexpected executable: ${String(file)}`);
		if (argv[0] === 'rev-parse' && argv[1] === '--show-toplevel') {
			if (!handlers.revParse) throw new Error('fatal: not a git repository');
			return handlers.revParse();
		}
		if (argv[0] === 'diff') {
			if (!handlers.diff) throw new Error('git diff failed');
			return handlers.diff(argv);
		}
		throw new Error(`unexpected git command: ${argv.join(' ')}`);
	};
	execFileMock.mockImplementation((file: unknown, args: unknown, _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
		let stdout: string;
		try {
			stdout = answer(file, (args as string[]).slice(GIT_HARDENING_ARGS.length));
		} catch (error) {
			callback(error as Error, '');
			return;
		}
		callback(null, stdout);
	});
}

describe('git invocation hardening', () => {
	it('overrides core.fsmonitor, which the repository sets and git runs as a command', async () => {
		mockGit({ revParse: () => '/repo-h-1\n', diff: () => 'src/a.ts\n' });

		await getChangedFiles('/repo-h-1');
		await parseGitDiffRanges('/repo-h-1');

		expect(execFileMock.mock.calls.length).toBeGreaterThan(0);
		for (const call of execFileMock.mock.calls) {
			const argv = call[1] as string[];
			expect(argv.slice(0, 2)).toEqual(['-c', 'core.fsmonitor=false']);
			expect(argv.indexOf('core.fsmonitor=false')).toBeLessThan(argv.findIndex(a => a === 'diff' || a === 'rev-parse'));
		}
	});

	it('hardens the staged-diff fallback too', async () => {
		mockGit({
			revParse: () => '/repo-h-2\n',
			diff: args => {
				if (args.includes('--cached')) return 'src/c.ts\n';
				throw new Error('bad revision');
			},
		});

		await getChangedFiles('/repo-h-2');

		const staged = execFileMock.mock.calls.find(c => (c[1] as string[]).includes('--cached'));
		expect(staged).toBeDefined();
		expect((staged![1] as string[]).slice(0, 2)).toEqual(['-c', 'core.fsmonitor=false']);
	});

	it('passes git an argv and no shell, so a ref reaching argv is never re-parsed', async () => {
		mockGit({ revParse: () => '/repo-h-3\n', diff: () => 'src/a.ts\n' });

		await getChangedFiles('/repo-h-3', 'release/1.0');

		for (const call of execFileMock.mock.calls) {
			expect(call[0]).toBe(GIT);
			expect(Array.isArray(call[1])).toBe(true);
			expect(call[2]).not.toHaveProperty('shell');
		}
		const diff = execFileMock.mock.calls.find(c => subcommandArgs(c)[0] === 'diff');
		expect(subcommandArgs(diff!)).toEqual(['diff', '--name-only', '--relative', 'release/1.0', '--']);
	});

	it('passes no GIT_DIR/GIT_WORK_TREE env, which would retarget the checkpoint engine bare repo', async () => {
		mockGit({ revParse: () => '/repo-h-4\n', diff: () => 'src/a.ts\n' });

		await getChangedFiles('/repo-h-4');

		for (const call of execFileMock.mock.calls) {
			expect((call[2] as { env?: unknown }).env).toBeUndefined();
		}
	});
});

describe('getChangedFiles', () => {
	it('asks git for paths relative to the workspace and anchors them on the workspace as the caller spells it', async () => {
		mockGit({
			revParse: () => '/repo-gc-1\n',
			diff: () => 'src/a.ts\nsrc/b.ts\n',
		});

		const files = await getChangedFiles('/repo-gc-1/packages/app');
		expect(files).toEqual([abs('/repo-gc-1/packages/app', 'src/a.ts'), abs('/repo-gc-1/packages/app', 'src/b.ts')]);
		const diff = execFileMock.mock.calls.find(call => subcommandArgs(call)[0] === 'diff');
		expect(subcommandArgs(diff!)).toContain('--relative');
		expect(diff![2]).toMatchObject({ cwd: '/repo-gc-1/packages/app' });
	});

	it('keeps the workspace spelling whatever git would spell the repository as (win32 drive-letter case)', async () => {
		if (process.platform !== 'win32') return;
		mockGit({
			revParse: () => 'C:/Repo-Case\n',
			diff: () => 'src/a.ts\nSrc-Sub/b.ts\n',
		});

		const files = await getChangedFiles('c:/repo-case');
		expect(files).toEqual(['c:/repo-case/src/a.ts', 'c:/repo-case/Src-Sub/b.ts']);
	});

	it('falls back to the workspace root outside a git repo', async () => {
		mockGit({ diff: () => 'src/a.ts\n' });

		const files = await getChangedFiles('/no-repo-gc-3');
		expect(files).toEqual([abs('/no-repo-gc-3', 'src/a.ts')]);
	});

	it('rejects unsafe base refs without invoking git', async () => {
		mockGit({ revParse: () => '/repo-gc-4\n', diff: () => 'src/a.ts\n' });

		expect(await getChangedFiles('/repo-gc-4', 'HEAD; rm -rf /')).toEqual([]);
		expect(execFileMock).not.toHaveBeenCalled();
	});

	it('rejects leading-dash refs that would inject git options', async () => {
		mockGit({ revParse: () => '/repo-gc-7\n', diff: () => 'src/a.ts\n' });

		expect(await getChangedFiles('/repo-gc-7', '--ext-diff')).toEqual([]);
		expect(await getChangedFiles('/repo-gc-7', '-')).toEqual([]);
		expect((await parseGitDiffRanges('/repo-gc-7', '--no-index')).size).toBe(0);
		expect(execFileMock).not.toHaveBeenCalled();
	});

	it('falls back to staged diff when the base diff fails', async () => {
		mockGit({
			revParse: () => '/repo-gc-5\n',
			diff: cmd => {
				if (cmd.includes('--cached')) return 'src/c.ts\n';
				throw new Error('bad revision');
			},
		});

		expect(await getChangedFiles('/repo-gc-5')).toEqual([abs('/repo-gc-5', 'src/c.ts')]);
	});
});

describe('parseGitDiffRanges', () => {
	it('keys ranges by workspace-absolute paths from a diff git prints relative to the workspace', async () => {
		mockGit({
			revParse: () => '/repo-pd-1\n',
			diff: () => [
				'+++ b/src/x.ts',
				'@@ -5,2 +5,3 @@',
			].join('\n'),
		});

		const ranges = await parseGitDiffRanges('/repo-pd-1/packages/app');
		expect(ranges.get(abs('/repo-pd-1/packages/app', 'src/x.ts'))).toEqual([[5, 7]]);
		expect(ranges.has('src/x.ts')).toBe(false);
		const diff = execFileMock.mock.calls.find(call => subcommandArgs(call)[0] === 'diff');
		expect(subcommandArgs(diff!)).toEqual(['diff', '--unified=0', '--relative', 'HEAD~1', '--']);
	});

	it('remaps against the workspace root outside a git repo', async () => {
		mockGit({
			diff: () => [
				'+++ b/src/y.ts',
				'@@ -1,2 +1,2 @@',
			].join('\n'),
		});

		const ranges = await parseGitDiffRanges('/no-repo-pd-2');
		expect(ranges.get(abs('/no-repo-pd-2', 'src/y.ts'))).toEqual([[1, 2]]);
	});

	it('returns an empty map when git diff fails', async () => {
		mockGit({ revParse: () => '/repo-pd-3\n' });
		expect((await parseGitDiffRanges('/repo-pd-3')).size).toBe(0);
	});

	it('rejects unsafe base refs without invoking git', async () => {
		mockGit({ revParse: () => '/repo-pd-4\n', diff: () => '+++ b/src/a.ts\n@@ -1 +1 @@' });

		expect((await parseGitDiffRanges('/repo-pd-4', '$(whoami)')).size).toBe(0);
		expect(execFileMock).not.toHaveBeenCalled();
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

	it('remapped diff keys resolve to exactly one file', async () => {
		seedMonorepo();
		mockGit({
			revParse: () => '/repo-mono\n',
			diff: () => [
				'+++ b/src/x.ts',
				'@@ -1,5 +1,5 @@',
			].join('\n'),
		});

		const ranges = await parseGitDiffRanges(workspace);
		const resolved = store.resolveGraphFilePathsGrouped([...ranges.keys()], workspace);
		expect(resolved.get(realFile)).toEqual([realFile]);

		const nodes = mapChangesToNodes(store, ranges, workspace);
		expect(nodes.map(n => n.name)).toEqual(['realFunc']);
	});

	it('analyzeChanges with internally-parsed git ranges only analyzes the changed package', async () => {
		seedMonorepo();
		mockGit({
			revParse: () => '/repo-mono\n',
			diff: () => [
				'+++ b/src/x.ts',
				'@@ -1,5 +1,5 @@',
			].join('\n'),
		});

		const analysis = await analyzeChanges(store, [realFile], undefined, workspace);
		expect(analysis.risks.map(r => r.node.name)).toEqual(['realFunc']);
		expect(analysis.risks.every(r => r.node.file_path === realFile)).toBe(true);
	});
});
