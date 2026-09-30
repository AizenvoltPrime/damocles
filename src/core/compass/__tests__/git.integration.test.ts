import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

/**
 * Compass's git calls against a real repository, with no mock in the way.
 *
 * The sibling unit suite fakes `child_process`, so it can only pin what Compass ASKS git. Whether the
 * override actually reaches git, and so whether the repository's own `core.fsmonitor` command runs, is
 * something only git can answer.
 */

import { getChangedFiles, parseGitDiffRanges, resetRepoRootCacheForTests } from '../git';

function gitIsAvailable(): boolean {
	try {
		execFileSync('git', ['--version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

const HAS_GIT = gitIsAvailable();

/**
 * `os.tmpdir()` is a symlink on macOS, and on Windows it can carry an 8.3 short name. Git answers with
 * the long, resolved form either way, and these tests compare absolute paths.
 */
const TMP_BASE = HAS_GIT ? fs.realpathSync.native(os.tmpdir()) : os.tmpdir();

let sandbox: string;
let neutralConfig: string;
const savedEnv: Record<string, string | undefined> = {};

function git(args: string[], cwd: string): void {
	execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** A repository with two commits, so `HEAD~1` resolves and the default diff compares to the worktree. */
function makeRepo(): string {
	const root = fs.mkdtempSync(path.join(sandbox, 'repo-'));
	git(['init', '--quiet'], root);
	git(['config', 'user.email', 'tests@damocles.invalid'], root);
	git(['config', 'user.name', 'Damocles Tests'], root);
	git(['config', 'commit.gpgsign', 'false'], root);
	fs.mkdirSync(path.join(root, 'src'), { recursive: true });
	fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n', 'utf-8');
	git(['add', '.'], root);
	git(['commit', '--quiet', '-m', 'first'], root);
	fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 2;\n', 'utf-8');
	git(['add', '.'], root);
	git(['commit', '--quiet', '-m', 'second'], root);
	return root;
}

const forwardSlashed = (target: string): string => target.replace(/\\/g, '/');

/** Point the repository's `core.fsmonitor` at a script that records having run. */
function armFsmonitor(root: string, name: string): string {
	const hook = path.join(sandbox, `${name}-hook.js`);
	const sentinel = path.join(sandbox, `${name}-ran.txt`);
	fs.writeFileSync(hook, 'require("fs").writeFileSync(process.argv[2], "ran");\n', 'utf-8');
	git(['config', 'core.fsmonitor', `"${forwardSlashed(process.execPath)}" "${forwardSlashed(hook)}" "${forwardSlashed(sentinel)}"`], root);
	return sentinel;
}

beforeAll(() => {
	if (!HAS_GIT) return;
	sandbox = fs.mkdtempSync(path.join(TMP_BASE, 'dam-compass-git-'));
	neutralConfig = path.join(sandbox, 'neutral.gitconfig');
	fs.writeFileSync(neutralConfig, '', 'utf-8');

	// The answer must come from the temp repo alone, so the developer's own git config, any inherited
	// GIT_DIR, and the checkpoint engine's variables are all taken out of the picture.
	for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CEILING_DIRECTORIES']) {
		savedEnv[key] = process.env[key];
	}
	process.env['GIT_CONFIG_GLOBAL'] = neutralConfig;
	process.env['GIT_CONFIG_SYSTEM'] = neutralConfig;
	process.env['GIT_CONFIG_NOSYSTEM'] = '1';
	delete process.env['GIT_DIR'];
	delete process.env['GIT_WORK_TREE'];
	delete process.env['GIT_INDEX_FILE'];
	// Without this git walks out of the sandbox and can find an enclosing repository.
	process.env['GIT_CEILING_DIRECTORIES'] = sandbox;
});

beforeEach(() => {
	resetRepoRootCacheForTests();
});

afterAll(() => {
	if (!HAS_GIT) return;
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe.skipIf(!HAS_GIT)('compass git against a real repository', { timeout: 60_000 }, () => {
	it('reads changed files back from a real diff', () => {
		const root = makeRepo();

		const files = getChangedFiles(root);

		expect(files).toEqual([path.resolve(root, 'src/a.ts').replace(/\\/g, '/')]);
	});

	it('does not let the repository own core.fsmonitor command run during getChangedFiles', (ctx) => {
		const root = makeRepo();
		const sentinel = armFsmonitor(root, 'changed-files');

		// Run the same query without the override first. If git does not invoke the hook in this
		// environment the assertion below would pass for the wrong reason, so skip instead of pretending.
		fs.rmSync(sentinel, { force: true });
		try {
			git(['diff', '--name-only', 'HEAD~1', '--'], root);
		} catch {
			// Only whether the hook fired matters here, not what git answered.
		}
		if (!fs.existsSync(sentinel)) ctx.skip();

		fs.rmSync(sentinel, { force: true });
		getChangedFiles(root);

		expect(fs.existsSync(sentinel)).toBe(false);
	});

	it('does not let the repository own core.fsmonitor command run during parseGitDiffRanges', (ctx) => {
		const root = makeRepo();
		const sentinel = armFsmonitor(root, 'diff-ranges');

		fs.rmSync(sentinel, { force: true });
		try {
			git(['diff', '--unified=0', 'HEAD~1', '--'], root);
		} catch {
			// Only whether the hook fired matters here, not what git answered.
		}
		if (!fs.existsSync(sentinel)) ctx.skip();

		fs.rmSync(sentinel, { force: true });
		parseGitDiffRanges(root);

		expect(fs.existsSync(sentinel)).toBe(false);
	});
});
