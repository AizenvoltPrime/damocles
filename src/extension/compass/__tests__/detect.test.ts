import { describe, it, expect } from 'vitest';
import { classifyFile, collectFiles, detect } from '../detect';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('classifyFile', () => {
	it('classifies Python as code', () => {
		expect(classifyFile('test.py')).toBe('code');
	});

	it('classifies TypeScript as code', () => {
		expect(classifyFile('test.ts')).toBe('code');
	});

	it('classifies Go as code', () => {
		expect(classifyFile('test.go')).toBe('code');
	});

	it('classifies Rust as code', () => {
		expect(classifyFile('test.rs')).toBe('code');
	});

	it('classifies Java as code', () => {
		expect(classifyFile('test.java')).toBe('code');
	});

	it('classifies markdown as document', () => {
		expect(classifyFile(path.join(FIXTURES_DIR, 'sample.md'))).toBe('document');
	});

	it('classifies PDF as paper', () => {
		expect(classifyFile('paper.pdf')).toBe('paper');
	});

	it('classifies PNG as image', () => {
		expect(classifyFile('logo.png')).toBe('image');
	});

	it('returns null for unknown extensions', () => {
		expect(classifyFile('data.xyz')).toBeNull();
	});
});

describe('collectFiles', () => {
	it('finds code files in fixtures', () => {
		const files = collectFiles(FIXTURES_DIR);
		expect(files.length).toBeGreaterThan(0);
		expect(files.some(f => f.endsWith('.py'))).toBe(true);
	});

	it('respects maxFiles', () => {
		const files = collectFiles(FIXTURES_DIR, [], 2);
		expect(files.length).toBeLessThanOrEqual(2);
	});

	it('skips hidden files', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-test-'));
		fs.writeFileSync(path.join(tmpDir, '.hidden.py'), '# hidden');
		fs.writeFileSync(path.join(tmpDir, 'visible.py'), '# visible');
		const files = collectFiles(tmpDir);
		expect(files.some(f => f.includes('.hidden'))).toBe(false);
		expect(files.some(f => f.includes('visible'))).toBe(true);
		fs.rmSync(tmpDir, { recursive: true });
	});
});

describe('detect', () => {
	it('returns detection result structure', () => {
		const result = detect(FIXTURES_DIR);
		expect(result).toHaveProperty('files');
		expect(result).toHaveProperty('total_files');
		expect(result.total_files).toBeGreaterThan(0);
	});
});
