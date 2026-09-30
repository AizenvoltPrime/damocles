import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TsconfigResolver } from '../tsconfig-resolver';

let tmpDir: string;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsconfig-test-'));

	fs.mkdirSync(path.join(tmpDir, 'src', 'components'), { recursive: true });
	fs.mkdirSync(path.join(tmpDir, 'src', 'utils'), { recursive: true });

	fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({
		compilerOptions: {
			baseUrl: '.',
			paths: {
				'@/*': ['src/*'],
				'@components/*': ['src/components/*'],
				'~utils': ['src/utils/index'],
			},
		},
	}));

	fs.writeFileSync(path.join(tmpDir, 'src', 'components', 'Button.vue'), '<template></template>');
	fs.writeFileSync(path.join(tmpDir, 'src', 'components', 'Card.ts'), 'export class Card {}');
	fs.writeFileSync(path.join(tmpDir, 'src', 'utils', 'index.ts'), 'export function helper() {}');
	fs.writeFileSync(path.join(tmpDir, 'src', 'app.ts'), 'import {} from "@/components/Card"');
});

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('TsconfigResolver', () => {
	it('resolves wildcard alias @/ to src/', () => {
		const resolver = new TsconfigResolver();
		const result = resolver.resolveAlias(
			'@/components/Card',
			path.join(tmpDir, 'src', 'app.ts'),
		);
		expect(result).toBeDefined();
		expect(result!.replace(/\\/g, '/')).toContain('src/components/Card.ts');
	});

	it('resolves @components/ alias', () => {
		const resolver = new TsconfigResolver();
		const result = resolver.resolveAlias(
			'@components/Button',
			path.join(tmpDir, 'src', 'app.ts'),
		);
		expect(result).toBeDefined();
		expect(result!).toContain('Button.vue');
	});

	it('resolves exact match alias', () => {
		const resolver = new TsconfigResolver();
		const result = resolver.resolveAlias(
			'~utils',
			path.join(tmpDir, 'src', 'app.ts'),
		);
		expect(result).toBeDefined();
		expect(result!).toContain('utils');
	});

	it('probes .vue extension', () => {
		const resolver = new TsconfigResolver();
		const result = resolver.resolveAlias(
			'@/components/Button',
			path.join(tmpDir, 'src', 'app.ts'),
		);
		expect(result).toBeDefined();
		expect(result!).toContain('.vue');
	});

	it('returns null for unmatched alias', () => {
		const resolver = new TsconfigResolver();
		const result = resolver.resolveAlias(
			'unknown/path',
			path.join(tmpDir, 'src', 'app.ts'),
		);
		expect(result).toBeNull();
	});

	it('returns null for npm package imports (non-aliased)', () => {
		const resolver = new TsconfigResolver();
		const result = resolver.resolveAlias(
			'express',
			path.join(tmpDir, 'src', 'app.ts'),
		);
		expect(result).toBeNull();
	});

	it('returns null when no tsconfig exists', () => {
		const resolver = new TsconfigResolver();
		const result = resolver.resolveAlias(
			'@/something',
			'/nonexistent/dir/file.ts',
		);
		expect(result).toBeNull();
	});

	it('caches tsconfig lookups per directory', () => {
		const resolver = new TsconfigResolver();
		const result1 = resolver.resolveAlias('@/components/Card', path.join(tmpDir, 'src', 'app.ts'));
		const result2 = resolver.resolveAlias('@/components/Card', path.join(tmpDir, 'src', 'other.ts'));
		expect(result1).toBe(result2);
		expect(result1).not.toBeNull();
	});
});

describe('TsconfigResolver JSONC support', () => {
	let jsoncDir: string;

	beforeAll(() => {
		jsoncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsconfig-jsonc-'));
		fs.mkdirSync(path.join(jsoncDir, 'src'), { recursive: true });

		fs.writeFileSync(path.join(jsoncDir, 'tsconfig.json'), `{
  // This is a comment
  "compilerOptions": {
    "baseUrl": ".",
    /* block comment */
    "paths": {
      "@/*": ["src/*"], // trailing comma
    }
  }
}`);
		fs.writeFileSync(path.join(jsoncDir, 'src', 'foo.ts'), 'export const x = 1;');
	});

	afterAll(() => {
		fs.rmSync(jsoncDir, { recursive: true, force: true });
	});

	it('handles JSONC comments and trailing commas', () => {
		const resolver = new TsconfigResolver();
		const result = resolver.resolveAlias(
			'@/foo',
			path.join(jsoncDir, 'src', 'bar.ts'),
		);
		expect(result).toBeDefined();
		expect(result!).toContain('foo.ts');
	});
});

describe('TsconfigResolver extends', () => {
	let extendsDir: string;

	beforeAll(() => {
		extendsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsconfig-extends-'));
		fs.mkdirSync(path.join(extendsDir, 'src'), { recursive: true });

		fs.writeFileSync(path.join(extendsDir, 'tsconfig.base.json'), JSON.stringify({
			compilerOptions: {
				baseUrl: '.',
				paths: { '@/*': ['src/*'] },
			},
		}));

		fs.writeFileSync(path.join(extendsDir, 'tsconfig.json'), JSON.stringify({
			extends: './tsconfig.base.json',
		}));

		fs.writeFileSync(path.join(extendsDir, 'src', 'mod.ts'), 'export const y = 2;');
	});

	afterAll(() => {
		fs.rmSync(extendsDir, { recursive: true, force: true });
	});

	it('inherits paths from extended config', () => {
		const resolver = new TsconfigResolver();
		const result = resolver.resolveAlias(
			'@/mod',
			path.join(extendsDir, 'src', 'app.ts'),
		);
		expect(result).toBeDefined();
		expect(result!).toContain('mod.ts');
	});
});

describe('TsconfigResolver workspace-root bounds', () => {
	it('blocks alias targets that probe outside the workspace root', () => {
		const escapeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tsconfig-escape-'));
		try {
			fs.mkdirSync(path.join(escapeRoot, 'workspace', 'src'), { recursive: true });
			fs.mkdirSync(path.join(escapeRoot, 'outside'), { recursive: true });
			fs.writeFileSync(path.join(escapeRoot, 'outside', 'leak.ts'), 'export const x = 1');
			fs.writeFileSync(path.join(escapeRoot, 'workspace', 'tsconfig.json'), JSON.stringify({
				compilerOptions: {
					baseUrl: '.',
					paths: {
						'@escape/*': ['../outside/*'],
					},
				},
			}));

			const source = path.join(escapeRoot, 'workspace', 'src', 'entry.ts');
			fs.writeFileSync(source, '');

			const unconstrained = new TsconfigResolver();
			expect(unconstrained.resolveAlias('@escape/leak', source)).not.toBeNull();

			const constrained = new TsconfigResolver(path.join(escapeRoot, 'workspace'));
			expect(constrained.resolveAlias('@escape/leak', source)).toBeNull();
		} finally {
			fs.rmSync(escapeRoot, { recursive: true, force: true });
		}
	});
});
