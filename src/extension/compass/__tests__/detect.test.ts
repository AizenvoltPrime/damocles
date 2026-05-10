import { describe, it, expect } from 'vitest';
import { collectFiles, shouldProbeShebang } from '../detect';
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

	it('includes extension-less shebang scripts only inside script directories', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-detect-'));
		const binDir = path.join(tmpDir, 'bin');
		fs.mkdirSync(binDir);
		fs.writeFileSync(path.join(binDir, 'deploy'), '#!/bin/bash\necho hi\n');

		fs.writeFileSync(path.join(tmpDir, 'README'), '#!/bin/bash\nthis is not actually a script\n');

		const files = collectFiles(tmpDir);
		const names = files.map(f => path.basename(f)).sort();
		expect(names).toEqual(['deploy']);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('skips extension-less binary files even when in script dirs', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-detect-'));
		const binDir = path.join(tmpDir, 'bin');
		fs.mkdirSync(binDir);
		const buf = Buffer.alloc(64);
		buf.write('#!/bin/something\n', 0, 'utf8');
		buf[20] = 0;
		fs.writeFileSync(path.join(binDir, 'native-binary'), buf);

		const files = collectFiles(tmpDir);
		expect(files).toHaveLength(0);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('skips extension-less files with unknown shebang interpreters', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-detect-'));
		const binDir = path.join(tmpDir, 'bin');
		fs.mkdirSync(binDir);
		fs.writeFileSync(path.join(binDir, 'mystery'), '#!/usr/bin/env nonsense-interp\n');

		const files = collectFiles(tmpDir);
		expect(files).toHaveLength(0);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it('does not full-scan: extension-less data files outside script dirs are skipped', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-detect-'));
		fs.writeFileSync(path.join(tmpDir, 'CHANGELOG'), 'release notes\n');
		fs.writeFileSync(path.join(tmpDir, 'LICENSE'), 'MIT\n');
		fs.writeFileSync(path.join(tmpDir, 'looks-like-a-script'), '#!/bin/bash\necho yo\n');

		const files = collectFiles(tmpDir);

		if (process.platform === 'win32') {
			expect(files).toHaveLength(0);
		} else {
			const stat = fs.statSync(path.join(tmpDir, 'looks-like-a-script'));
			if ((stat.mode & 0o100) === 0) expect(files).toHaveLength(0);
		}

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});
});

describe('shouldProbeShebang', () => {
	it('returns true for files inside bin/', () => {
		expect(shouldProbeShebang('/repo/bin/deploy', 0o644)).toBe(true);
	});

	it('returns true for files inside scripts/', () => {
		expect(shouldProbeShebang('/repo/scripts/run', 0o644)).toBe(true);
	});

	it('returns true for files inside .git/hooks/', () => {
		expect(shouldProbeShebang('/repo/.git/hooks/pre-commit', 0o644)).toBe(true);
	});

	it('returns true for files inside hooks/', () => {
		expect(shouldProbeShebang('/repo/hooks/post-merge', 0o644)).toBe(true);
	});

	it('handles Windows backslashes by normalizing path', () => {
		expect(shouldProbeShebang('C:\\repo\\bin\\deploy', 0o644)).toBe(true);
		expect(shouldProbeShebang('C:\\repo\\scripts\\run', 0o644)).toBe(true);
	});

	it('returns false on Windows for non-script-dir paths regardless of mode', () => {
		const original = process.platform;
		Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
		try {
			expect(shouldProbeShebang('/repo/random/file', 0o755)).toBe(false);
		} finally {
			Object.defineProperty(process, 'platform', { value: original, configurable: true });
		}
	});

	it('on POSIX, honors user-executable bit outside script dirs', () => {
		const original = process.platform;
		Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
		try {
			expect(shouldProbeShebang('/repo/random/file', 0o755)).toBe(true);
			expect(shouldProbeShebang('/repo/random/file', 0o644)).toBe(false);
		} finally {
			Object.defineProperty(process, 'platform', { value: original, configurable: true });
		}
	});
});
