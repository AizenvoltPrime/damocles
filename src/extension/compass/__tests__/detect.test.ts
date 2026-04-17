import { describe, it, expect } from 'vitest';
import { collectFiles } from '../detect';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

describe('collectFiles', () => {
	it('finds .ts files', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-detect-'));
		fs.writeFileSync(path.join(tmpDir, 'foo.ts'), 'export const a = 1;');
		fs.writeFileSync(path.join(tmpDir, 'bar.py'), 'a = 1');
		fs.writeFileSync(path.join(tmpDir, 'baz.txt'), 'text');

		const files = collectFiles(tmpDir);
		expect(files.length).toBe(2);
		expect(files.some(f => f.endsWith('foo.ts'))).toBe(true);
		expect(files.some(f => f.endsWith('bar.py'))).toBe(true);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('skips node_modules', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-detect-'));
		const nmDir = path.join(tmpDir, 'node_modules');
		fs.mkdirSync(nmDir);
		fs.writeFileSync(path.join(nmDir, 'dep.ts'), 'export const a = 1;');
		fs.writeFileSync(path.join(tmpDir, 'main.ts'), 'import {a} from "./dep";');

		const files = collectFiles(tmpDir);
		expect(files.length).toBe(1);
		expect(files[0]).toContain('main.ts');

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('skips sensitive data files but indexes source code with credential-like names', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-detect-'));
		fs.writeFileSync(path.join(tmpDir, 'main.ts'), 'const a = 1;');
		fs.writeFileSync(path.join(tmpDir, 'credentials.ts'), 'export const provider = {};');
		fs.writeFileSync(path.join(tmpDir, 'PasswordInput.vue'), '<template/>');

		const files = collectFiles(tmpDir);
		const names = files.map(f => path.basename(f)).sort();
		expect(names).toEqual(['PasswordInput.vue', 'credentials.ts', 'main.ts']);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('includes .vue files', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-detect-'));
		fs.writeFileSync(path.join(tmpDir, 'App.vue'), '<template><div/></template>');

		const files = collectFiles(tmpDir);
		expect(files.length).toBe(1);
		expect(files[0]).toContain('App.vue');

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('respects exclude patterns', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-detect-'));
		fs.writeFileSync(path.join(tmpDir, 'main.ts'), 'const a = 1;');
		fs.writeFileSync(path.join(tmpDir, 'generated.ts'), 'const b = 2;');

		const files = collectFiles(tmpDir, ['generated']);
		expect(files.length).toBe(1);
		expect(files[0]).toContain('main.ts');

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});
});
