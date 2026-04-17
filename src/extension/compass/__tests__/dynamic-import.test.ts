import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { extractFile } from '../extractors';
import { setGrammarDir } from '../parser-manager';

const GRAMMARS = path.join(process.cwd(), 'resources', 'grammars');

beforeAll(() => {
	setGrammarDir(GRAMMARS);
});

describe('dynamic import() extraction', () => {
	it('emits IMPORTS_FROM for bare dynamic import at top level', async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dyn-import-'));
		const file = path.join(tmp, 'loader.ts');
		fs.writeFileSync(file, `const mod = import("./Foo.vue");\n`);

		const result = await extractFile(file, tmp);
		const edges = result.edges.filter(e => e.kind === 'IMPORTS_FROM');
		const targets = edges.map(e => e.target);
		expect(targets).toContain('./Foo.vue');

		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('emits IMPORTS_FROM for dynamic imports inside anonymous arrow functions (Vue lazy router pattern)', async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dyn-import-'));
		const file = path.join(tmp, 'router.ts');
		fs.writeFileSync(file, `export const routes = [
  {
    path: "/home",
    component: () => import("./Pages/Home.vue"),
  },
  {
    path: "/admin",
    component: () => import("./Pages/Admin.vue"),
  },
];
`);

		const result = await extractFile(file, tmp);
		const edges = result.edges.filter(e => e.kind === 'IMPORTS_FROM');
		const targets = new Set(edges.map(e => e.target));
		expect(targets.has('./Pages/Home.vue')).toBe(true);
		expect(targets.has('./Pages/Admin.vue')).toBe(true);

		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('emits IMPORTS_FROM from file qualified name (not enclosing function)', async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dyn-import-'));
		const file = path.join(tmp, 'router.ts');
		fs.writeFileSync(file, `function loadComponent() {
  return import("./lazy.ts");
}
`);

		const result = await extractFile(file, tmp);
		const dynImports = result.edges.filter(e => e.kind === 'IMPORTS_FROM' && e.target === './lazy.ts');
		expect(dynImports.length).toBe(1);
		expect(dynImports[0]?.source).toContain('router.ts::router.ts');

		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('does not emit for non-string arguments (template strings with expressions)', async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dyn-import-'));
		const file = path.join(tmp, 'router.ts');
		fs.writeFileSync(file, `const name = "Foo";
const mod = import(\`./Pages/\${name}.vue\`);
`);

		const result = await extractFile(file, tmp);
		const dynImports = result.edges.filter(e => e.kind === 'IMPORTS_FROM');
		expect(dynImports.length).toBe(0);

		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('works for .tsx files', async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dyn-import-'));
		const file = path.join(tmp, 'loader.tsx');
		fs.writeFileSync(file, `const Foo = React.lazy(() => import("./Widget.tsx"));\n`);

		const result = await extractFile(file, tmp);
		const targets = result.edges.filter(e => e.kind === 'IMPORTS_FROM').map(e => e.target);
		expect(targets).toContain('./Widget.tsx');

		fs.rmSync(tmp, { recursive: true, force: true });
	});
});
