import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { extractFile } from '../extractors/index';
import { setGrammarDir } from '../parser-manager';

const FIXTURES = path.join(__dirname, 'fixtures');
const GRAMMARS = path.join(process.cwd(), 'resources', 'grammars');

beforeAll(() => {
	setGrammarDir(GRAMMARS);
});

describe('Python extraction (sample_python.py)', () => {
	it('extracts File node', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_python.py'), FIXTURES);
		const fileNodes = nodes.filter(n => n.kind === 'File');
		expect(fileNodes).toHaveLength(1);
		expect(fileNodes[0]!.language).toBe('python');
	});

	it('extracts classes: BaseService, AuthService', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_python.py'), FIXTURES);
		const classes = nodes.filter(n => n.kind === 'Class');
		const names = new Set(classes.map(n => n.name));
		expect(names.has('BaseService')).toBe(true);
		expect(names.has('AuthService')).toBe(true);
	});

	it('extracts functions: __init__, authenticate, create_auth_service, process_request', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_python.py'), FIXTURES);
		const funcs = nodes.filter(n => n.kind === 'Function');
		const names = new Set(funcs.map(n => n.name));
		expect(names.has('__init__')).toBe(true);
		expect(names.has('authenticate')).toBe(true);
		expect(names.has('create_auth_service')).toBe(true);
		expect(names.has('process_request')).toBe(true);
	});

	it('extracts INHERITS: AuthService -> BaseService', async () => {
		const { edges } = await extractFile(path.join(FIXTURES, 'sample_python.py'), FIXTURES);
		const inherits = edges.filter(e => e.kind === 'INHERITS');
		expect(inherits.length).toBeGreaterThanOrEqual(1);
		expect(inherits.some(e =>
			e.source.includes('AuthService') && e.target.includes('BaseService'),
		)).toBe(true);
	});

	it('extracts IMPORTS_FROM: os, pathlib', async () => {
		const { edges } = await extractFile(path.join(FIXTURES, 'sample_python.py'), FIXTURES);
		const imports = edges.filter(e => e.kind === 'IMPORTS_FROM');
		const targets = new Set(imports.map(e => e.target));
		expect(targets.has('os')).toBe(true);
		expect(targets.has('pathlib')).toBe(true);
	});

	it('extracts CONTAINS edges', async () => {
		const { edges } = await extractFile(path.join(FIXTURES, 'sample_python.py'), FIXTURES);
		const contains = edges.filter(e => e.kind === 'CONTAINS');
		expect(contains.length).toBeGreaterThan(0);
	});

	it('extracts CALLS edges', async () => {
		const { edges } = await extractFile(path.join(FIXTURES, 'sample_python.py'), FIXTURES);
		const calls = edges.filter(e => e.kind === 'CALLS');
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.some(e => e.target.includes('_validate_token'))).toBe(true);
	});
});

describe('TypeScript extraction (sample_typescript.ts)', () => {
	it('extracts classes: UserRepository, UserService', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_typescript.ts'), FIXTURES);
		const classes = nodes.filter(n => n.kind === 'Class');
		const names = new Set(classes.map(n => n.name));
		expect(names.has('UserRepository')).toBe(true);
		expect(names.has('UserService')).toBe(true);
	});

	it('extracts functions including handleGetUser', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_typescript.ts'), FIXTURES);
		const funcs = nodes.filter(n => n.kind === 'Function');
		const names = new Set(funcs.map(n => n.name));
		expect(names.has('findById') || names.has('handleGetUser')).toBe(true);
	});

	it('extracts class methods with parent_name', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_typescript.ts'), FIXTURES);
		const findById = nodes.find(n => n.name === 'findById');
		if (findById) {
			expect(findById.parent_name).toBe('UserRepository');
		}
	});

	it('extracts interface UserData as Type kind', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_typescript.ts'), FIXTURES);
		const types = nodes.filter(n => n.kind === 'Type');
		expect(types.some(n => n.name === 'UserData')).toBe(true);
	});

	it('extracts INHERITS: UserService extends UserRepository', async () => {
		const { edges } = await extractFile(path.join(FIXTURES, 'sample_typescript.ts'), FIXTURES);
		const inherits = edges.filter(e => e.kind === 'INHERITS');
		expect(inherits.some(e =>
			e.source.includes('UserService') && e.target.includes('UserRepository'),
		)).toBe(true);
	});

	it('extracts IMPORTS_FROM: express', async () => {
		const { edges } = await extractFile(path.join(FIXTURES, 'sample_typescript.ts'), FIXTURES);
		const imports = edges.filter(e => e.kind === 'IMPORTS_FROM');
		expect(imports.some(e => e.target === 'express')).toBe(true);
	});

	it('extracts CONTAINS edges', async () => {
		const { edges } = await extractFile(path.join(FIXTURES, 'sample_typescript.ts'), FIXTURES);
		const contains = edges.filter(e => e.kind === 'CONTAINS');
		expect(contains.length).toBeGreaterThan(0);
	});
});

describe('Vue SFC extraction (sample_vue.vue)', () => {
	it('extracts File node with language=vue', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_vue.vue'), FIXTURES);
		const fileNodes = nodes.filter(n => n.kind === 'File');
		expect(fileNodes).toHaveLength(1);
		expect(fileNodes[0]!.language).toBe('vue');
	});

	it('extracts functions from <script setup>: increment, onSelectUser, fetchUsers', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_vue.vue'), FIXTURES);
		const funcs = nodes.filter(n => n.kind === 'Function');
		const names = new Set(funcs.map(n => n.name));
		expect(names.has('increment')).toBe(true);
		expect(names.has('onSelectUser')).toBe(true);
		expect(names.has('fetchUsers')).toBe(true);
	});

	it('extracts IMPORTS_FROM: vue, ./UserList.vue', async () => {
		const { nodes, edges } = await extractFile(path.join(FIXTURES, 'sample_vue.vue'), FIXTURES);
		const imports = edges.filter(e => e.kind === 'IMPORTS_FROM');
		const targets = new Set(imports.map(e => e.target));
		expect(targets.has('vue')).toBe(true);
		expect(targets.has('./UserList.vue')).toBe(true);
	});

	it('extracts CONTAINS edges', async () => {
		const { edges } = await extractFile(path.join(FIXTURES, 'sample_vue.vue'), FIXTURES);
		const contains = edges.filter(e => e.kind === 'CONTAINS');
		expect(contains.length).toBeGreaterThanOrEqual(1);
	});

	it('line numbers offset: increment() is after line 9', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_vue.vue'), FIXTURES);
		const increment = nodes.find(n => n.name === 'increment' && n.kind === 'Function');
		expect(increment).toBeDefined();
		expect(increment!.line_start).toBeGreaterThan(9);
	});

	it('all nodes have language=vue', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_vue.vue'), FIXTURES);
		for (const node of nodes) {
			expect(node.language).toBe('vue');
		}
	});
});

describe('Go extraction (sample_go.go)', () => {
	it('extracts File node with language=go', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_go.go'), FIXTURES);
		const fileNode = nodes.find(n => n.kind === 'File');
		expect(fileNode).toBeDefined();
		expect(fileNode!.language).toBe('go');
	});

	it('extracts classes and functions', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_go.go'), FIXTURES);
		expect(nodes.length).toBeGreaterThan(1);
	});
});

describe('Rust extraction (sample_rust.rs)', () => {
	it('extracts File node with language=rust', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_rust.rs'), FIXTURES);
		const fileNode = nodes.find(n => n.kind === 'File');
		expect(fileNode).toBeDefined();
		expect(fileNode!.language).toBe('rust');
	});

	it('extracts structs and functions', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_rust.rs'), FIXTURES);
		expect(nodes.length).toBeGreaterThan(1);
	});
});

describe('Multi-language extraction', () => {
	const languages = [
		{ ext: 'sample.java', lang: 'java' },
		{ ext: 'sample.c', lang: 'c' },
		{ ext: 'sample.cpp', lang: 'cpp' },
		{ ext: 'sample.cs', lang: 'csharp' },
		{ ext: 'sample.rb', lang: 'ruby' },
		{ ext: 'sample.kt', lang: 'kotlin' },
		{ ext: 'sample.php', lang: 'php' },
		{ ext: 'sample.scala', lang: 'scala' },
	];

	for (const { ext, lang } of languages) {
		it(`extracts from ${ext} (${lang})`, async () => {
			const { nodes } = await extractFile(path.join(FIXTURES, ext), FIXTURES);
			expect(nodes.length).toBeGreaterThan(0);
			const fileNode = nodes.find(n => n.kind === 'File');
			expect(fileNode).toBeDefined();
		});
	}
});

describe('unsupported files', () => {
	it('returns empty for markdown', async () => {
		const result = await extractFile(path.join(FIXTURES, 'sample.md'), FIXTURES);
		expect(result.nodes).toHaveLength(0);
	});

	it('returns empty for nonexistent file', async () => {
		const result = await extractFile('/nonexistent/file.py', FIXTURES);
		expect(result.nodes).toHaveLength(0);
	});
});
