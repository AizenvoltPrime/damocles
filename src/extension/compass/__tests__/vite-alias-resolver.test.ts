import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ViteAliasResolver } from '../vite-alias-resolver';

let tmpDir: string;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vite-alias-test-'));

	fs.mkdirSync(path.join(tmpDir, 'src', 'webview', 'components', 'ui', 'button'), { recursive: true });
	fs.mkdirSync(path.join(tmpDir, 'src', 'webview', 'stores'), { recursive: true });
	fs.mkdirSync(path.join(tmpDir, 'src', 'shared', 'types'), { recursive: true });

	fs.writeFileSync(
		path.join(tmpDir, 'vite.config.ts'),
		[
			"import { defineConfig } from 'vite';",
			"import { resolve } from 'path';",
			"export default defineConfig({",
			"  resolve: {",
			"    alias: {",
			"      '@shared': resolve(__dirname, 'src/shared'),",
			"      '@': resolve(__dirname, 'src/webview'),",
			"    },",
			"  },",
			"});",
		].join('\n'),
	);

	fs.writeFileSync(path.join(tmpDir, 'src', 'webview', 'components', 'ui', 'button', 'index.ts'), 'export const Button = 1');
	fs.writeFileSync(path.join(tmpDir, 'src', 'webview', 'stores', 'useSessionStore.ts'), 'export const useSessionStore = () => null');
	fs.writeFileSync(path.join(tmpDir, 'src', 'shared', 'types', 'index.ts'), 'export type T = string');
	fs.writeFileSync(path.join(tmpDir, 'src', 'webview', 'App.vue'), '<script setup></script>');
});

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('ViteAliasResolver', () => {
	it('resolves @ alias to src/webview directory', () => {
		const resolver = new ViteAliasResolver();
		const result = resolver.resolveAlias(
			'@/components/ui/button',
			path.join(tmpDir, 'src', 'webview', 'App.vue'),
		);
		expect(result).not.toBeNull();
		expect(result!.replace(/\\/g, '/')).toContain('src/webview/components/ui/button/index.ts');
	});

	it('resolves @ alias against a direct .ts file (with extension probing)', () => {
		const resolver = new ViteAliasResolver();
		const result = resolver.resolveAlias(
			'@/stores/useSessionStore',
			path.join(tmpDir, 'src', 'webview', 'App.vue'),
		);
		expect(result).not.toBeNull();
		expect(result!.replace(/\\/g, '/')).toContain('src/webview/stores/useSessionStore.ts');
	});

	it('resolves longer alias before shorter (@shared beats @ for @shared/types)', () => {
		const resolver = new ViteAliasResolver();
		const result = resolver.resolveAlias(
			'@shared/types',
			path.join(tmpDir, 'src', 'webview', 'App.vue'),
		);
		expect(result).not.toBeNull();
		expect(result!.replace(/\\/g, '/')).toContain('src/shared/types/index.ts');
	});

	it('returns null for unknown alias', () => {
		const resolver = new ViteAliasResolver();
		const result = resolver.resolveAlias(
			'@nonexistent/foo',
			path.join(tmpDir, 'src', 'webview', 'App.vue'),
		);
		expect(result).toBeNull();
	});

	it('returns null for relative imports (not alias business)', () => {
		const resolver = new ViteAliasResolver();
		const result = resolver.resolveAlias(
			'./sibling',
			path.join(tmpDir, 'src', 'webview', 'App.vue'),
		);
		expect(result).toBeNull();
	});

	it('caches config per directory (second call from same dir is instant)', () => {
		const resolver = new ViteAliasResolver();
		const src = path.join(tmpDir, 'src', 'webview', 'App.vue');
		const r1 = resolver.resolveAlias('@/components/ui/button', src);
		const r2 = resolver.resolveAlias('@/components/ui/button', src);
		expect(r1).toBe(r2);
	});

	it('blocks aliases that probe outside the workspace root', () => {
		const escapeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vite-alias-escape-'));
		try {
			fs.mkdirSync(path.join(escapeRoot, 'workspace', 'src'), { recursive: true });
			fs.writeFileSync(path.join(escapeRoot, 'outside.ts'), 'export const x = 1');
			fs.writeFileSync(
				path.join(escapeRoot, 'workspace', 'vite.config.ts'),
				[
					"import { defineConfig } from 'vite';",
					"import { resolve } from 'path';",
					"export default defineConfig({",
					"  resolve: {",
					"    alias: {",
					"      '@escape': resolve(__dirname, '../outside'),",
					"    },",
					"  },",
					"});",
				].join('\n'),
			);

			const sourceFile = path.join(escapeRoot, 'workspace', 'src', 'entry.ts');
			fs.writeFileSync(sourceFile, '');

			const unconstrained = new ViteAliasResolver();
			expect(unconstrained.resolveAlias('@escape', sourceFile)).not.toBeNull();

			const constrained = new ViteAliasResolver(path.join(escapeRoot, 'workspace'));
			expect(constrained.resolveAlias('@escape', sourceFile)).toBeNull();
		} finally {
			fs.rmSync(escapeRoot, { recursive: true, force: true });
		}
	});
});
