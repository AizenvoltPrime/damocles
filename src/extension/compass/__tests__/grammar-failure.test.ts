import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractFile, GrammarLoadError } from '../extractors';
import { setGrammarDir } from '../parser-manager';
import { fullBuild } from '../incremental';
import type { GraphStore } from '../database';
import { createTestStore } from './sql-test-helper';
import { log } from '../../logger';

vi.mock('../../logger', () => ({ log: vi.fn() }));

let workspace: string;

beforeAll(async () => {
	setGrammarDir(fs.mkdtempSync(path.join(os.tmpdir(), 'compass-empty-grammars-')));

	workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-grammar-failure-'));
	fs.writeFileSync(path.join(workspace, 'alpha.py'), 'def alpha():\n    return 1\n');
	fs.writeFileSync(path.join(workspace, 'beta.py'), 'def beta():\n    return 2\n');
	fs.writeFileSync(path.join(workspace, 'gamma.js'), 'function gamma() { return 3; }\n');
});

describe('extractFile with a missing grammar WASM', () => {
	it('throws GrammarLoadError carrying the language', async () => {
		const error = await extractFile(path.join(workspace, 'alpha.py'), workspace).then(
			() => null,
			(err: unknown) => err,
		);
		expect(error).toBeInstanceOf(GrammarLoadError);
		expect((error as GrammarLoadError).language).toBe('python');
		expect((error as GrammarLoadError).message).toContain('python');
	});
});

describe('fullBuild with a missing grammar WASM', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('records a per-file error for every file instead of silently extracting nothing', async () => {
		store = createTestStore();
		vi.mocked(log).mockClear();

		const result = await fullBuild(store, workspace, { excludePatterns: [], autoReindex: true });

		expect(result.errors).toHaveLength(3);
		const erroredFiles = result.errors.map(e => path.basename(e.file)).sort();
		expect(erroredFiles).toEqual(['alpha.py', 'beta.py', 'gamma.js']);
		for (const entry of result.errors) {
			expect(entry.error).toContain('grammar');
		}
		expect(result.totalNodes).toBe(0);
		expect(result.totalEdges).toBe(0);
	});

	it('logs one grammar warning per failed language per build', async () => {
		store = createTestStore();
		vi.mocked(log).mockClear();

		await fullBuild(store, workspace, { excludePatterns: [], autoReindex: true });

		const grammarWarnings = vi.mocked(log).mock.calls.filter(
			call => typeof call[1] === 'string' && call[1].includes('grammar'),
		);
		expect(grammarWarnings).toHaveLength(2);
		const languages = grammarWarnings.map(call => call[2]).sort();
		expect(languages).toEqual(['javascript', 'python']);
	});
});
