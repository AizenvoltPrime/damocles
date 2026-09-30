import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { extractFile } from '../extractors/index';
import { setGrammarDir, languageForExtension } from '../parser-manager';
import { isBunTestImport } from '../extractors/lang-maps';

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
		const { edges } = await extractFile(path.join(FIXTURES, 'sample_vue.vue'), FIXTURES);
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

	it('classifies #[test]-annotated functions as Test despite ordinary name and non-test filename', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_rust.rs'), FIXTURES);
		const validates = nodes.find(n => n.name === 'validates_input');
		expect(validates).toBeDefined();
		expect(validates!.kind).toBe('Test');
		expect(validates!.is_test).toBe(true);
	});

	it('classifies #[tokio::test] functions as Test', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_rust.rs'), FIXTURES);
		const asyncCheck = nodes.find(n => n.name === 'async_check');
		expect(asyncCheck).toBeDefined();
		expect(asyncCheck!.kind).toBe('Test');
	});

	it('leaves un-annotated helpers in a test module as ordinary Functions', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_rust.rs'), FIXTURES);
		const helper = nodes.find(n => n.name === 'build_default_repo');
		expect(helper).toBeDefined();
		expect(helper!.kind).toBe('Function');
	});

	it('records the attribute on the node modifiers field', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_rust.rs'), FIXTURES);
		const validates = nodes.find(n => n.name === 'validates_input');
		expect(validates!.modifiers).toContain('#[test]');
	});

	it('detects #[test] even when a doc comment sits between the attribute and the fn', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_rust.rs'), FIXTURES);
		const documented = nodes.find(n => n.name === 'documented_test');
		expect(documented).toBeDefined();
		expect(documented!.kind).toBe('Test');
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

describe('Java method name extraction (java-method-name.java)', () => {
	it('extracts getName as a Function/Method, not the return type String', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'java-method-name.java'), FIXTURES);
		const names = new Set(nodes.filter(n => n.kind === 'Function').map(n => n.name));
		expect(names.has('getName')).toBe(true);
		expect(names.has('setName')).toBe(true);
		expect(names.has('buildAll')).toBe(true);
		expect(names.has('identity')).toBe(true);
		expect(names.has('String')).toBe(false);
		expect(names.has('void')).toBe(false);
	});

	it('extracts the constructor by class name', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'java-method-name.java'), FIXTURES);
		const ctor = nodes.find(n => n.kind === 'Function' && n.name === 'MethodNameSample');
		expect(ctor).toBeDefined();
	});
});

describe('Java extends/implements extraction (java-extends-implements.java)', () => {
	it('emits INHERITS edges with bare base class names (no "implements ..." prefix, no generics)', async () => {
		const { edges } = await extractFile(path.join(FIXTURES, 'java-extends-implements.java'), FIXTURES);
		const targets = new Set(
			edges.filter(e => e.kind === 'INHERITS' || e.kind === 'IMPLEMENTS').map(e => e.target),
		);
		expect(targets.has('BaseRepository')).toBe(true);
		expect(targets.has('UserRepository')).toBe(true);
		expect(targets.has('Comparable')).toBe(true);
		expect([...targets].some(t => t.includes('implements'))).toBe(false);
		expect([...targets].some(t => t.includes('<'))).toBe(false);
	});

	it('skips wildcard imports (import java.util.*;)', async () => {
		const { edges } = await extractFile(path.join(FIXTURES, 'java-extends-implements.java'), FIXTURES);
		const importTargets = new Set(edges.filter(e => e.kind === 'IMPORTS_FROM').map(e => e.target));
		expect(importTargets.has('*')).toBe(false);
		expect(importTargets.has('java.util')).toBe(false);
		expect([...importTargets].some(t => t.endsWith('.*'))).toBe(false);
	});

	it('strips trailing member from static imports', async () => {
		const { edges } = await extractFile(path.join(FIXTURES, 'java-extends-implements.java'), FIXTURES);
		const importTargets = new Set(edges.filter(e => e.kind === 'IMPORTS_FROM').map(e => e.target));
		expect(importTargets.has('java.util.Map')).toBe(true);
		expect(importTargets.has('java.util.Map.entry')).toBe(false);
	});

	it('emits dotted-name IMPORTS_FROM for non-wildcard imports', async () => {
		const { edges } = await extractFile(path.join(FIXTURES, 'java-extends-implements.java'), FIXTURES);
		const importTargets = new Set(edges.filter(e => e.kind === 'IMPORTS_FROM').map(e => e.target));
		expect(importTargets.has('java.util.List')).toBe(true);
		expect(importTargets.has('java.util.ArrayList')).toBe(true);
		expect(importTargets.has('com.example.auth.User')).toBe(true);
	});
});

describe('PHP trait extraction (sample.php)', () => {
	it('extracts trait Loggable as Class node', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample.php'), FIXTURES);
		const classes = nodes.filter(n => n.kind === 'Class');
		const names = new Set(classes.map(n => n.name));
		expect(names.has('Loggable')).toBe(true);
	});

	it('still extracts ApiClient and Cacheable', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample.php'), FIXTURES);
		const classes = nodes.filter(n => n.kind === 'Class');
		const types = nodes.filter(n => n.kind === 'Type');
		const classNames = new Set(classes.map(n => n.name));
		const typeNames = new Set(types.map(n => n.name));
		expect(classNames.has('ApiClient')).toBe(true);
		expect(typeNames.has('Cacheable')).toBe(true);
	});
});

describe('PHP enum extraction (sample_php_enum.php)', () => {
	it('extracts enum Status as Class node', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_php_enum.php'), FIXTURES);
		const classes = nodes.filter(n => n.kind === 'Class');
		const names = new Set(classes.map(n => n.name));
		expect(names.has('Status')).toBe(true);
	});

	it('extracts backed enum Color as Class node', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_php_enum.php'), FIXTURES);
		const classes = nodes.filter(n => n.kind === 'Class');
		const names = new Set(classes.map(n => n.name));
		expect(names.has('Color')).toBe(true);
	});
});

describe('PHP heritage extraction (sample.php)', () => {
	it('extracts IMPLEMENTS: ApiClient -> Cacheable', async () => {
		const { edges } = await extractFile(path.join(FIXTURES, 'sample.php'), FIXTURES);
		const impls = edges.filter(e => e.kind === 'IMPLEMENTS' || e.kind === 'INHERITS');
		expect(impls.some(e =>
			e.source.includes('ApiClient') && e.target.includes('Cacheable'),
		)).toBe(true);
	});
});

describe('PHP nullsafe + global namespace strip (php-nullsafe-namespaced.php)', () => {
	it('emits CALLS edge for $obj?->method() targeting `lookup`', async () => {
		const { edges } = await extractFile(path.join(FIXTURES, 'php-nullsafe-namespaced.php'), FIXTURES);
		const calls = edges.filter(e => e.kind === 'CALLS');
		expect(calls.some(e => e.target.endsWith('::lookup') || e.target === 'lookup')).toBe(true);
	});

	it('strips leading backslash from \\globalFn() so target is `globalFn`', async () => {
		const { edges } = await extractFile(path.join(FIXTURES, 'php-nullsafe-namespaced.php'), FIXTURES);
		const calls = edges.filter(e => e.kind === 'CALLS');
		const targets = calls.map(e => e.target);
		expect(targets.some(t => t.endsWith('::globalFn') || t === 'globalFn')).toBe(true);
		expect(targets.some(t => t.startsWith('\\') || t.includes('::\\'))).toBe(false);
	});

	it('preserves existing scoped_call_expression behaviour for sample.php', async () => {
		const { nodes, edges } = await extractFile(path.join(FIXTURES, 'sample.php'), FIXTURES);
		expect(nodes.some(n => n.kind === 'Class' && n.name === 'ApiClient')).toBe(true);
		const calls = edges.filter(e => e.kind === 'CALLS');
		expect(calls.length).toBeGreaterThan(0);
	});
});

describe('Bash extraction (bash-script.sh)', () => {
	it('extracts File node with language=bash', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'bash-script.sh'), FIXTURES);
		const fileNode = nodes.find(n => n.kind === 'File');
		expect(fileNode).toBeDefined();
		expect(fileNode!.language).toBe('bash');
	});

	it('extracts function definitions (greet, say_hello) by name only — body excluded', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'bash-script.sh'), FIXTURES);
		const funcs = nodes.filter(n => n.kind === 'Function');
		const names = new Set(funcs.map(n => n.name));
		expect(names.has('greet')).toBe(true);
		expect(names.has('say_hello')).toBe(true);
		for (const f of funcs) {
			expect(f.name).not.toContain('echo');
			expect(f.name).not.toContain('{');
		}
	});

	it('emits CALLS edges for user-defined function invocations (say_hello, greet)', async () => {
		const { edges } = await extractFile(path.join(FIXTURES, 'bash-script.sh'), FIXTURES);
		const calls = edges.filter(e => e.kind === 'CALLS');
		const targets = new Set(calls.map(e => e.target.split('::').pop()!));
		expect(targets.has('say_hello') || targets.has('greet')).toBe(true);
	});

	it('does not emit CALLS edges for shell builtins (echo, printf) or source/.', async () => {
		const { edges } = await extractFile(path.join(FIXTURES, 'bash-script.sh'), FIXTURES);
		const calls = edges.filter(e => e.kind === 'CALLS');
		const targets = new Set(calls.map(e => e.target.split('::').pop()!));
		expect(targets.has('echo')).toBe(false);
		expect(targets.has('printf')).toBe(false);
		expect(targets.has('source')).toBe(false);
		expect(targets.has('.')).toBe(false);
	});

	it('emits IMPORTS_FROM edges with raw specifier for `source ./bash-source-target.sh` and `. ./bash-source-target.sh`', async () => {
		const { edges } = await extractFile(path.join(FIXTURES, 'bash-script.sh'), FIXTURES);
		const imports = edges.filter(e => e.kind === 'IMPORTS_FROM');
		const matching = imports.filter(e => e.target === './bash-source-target.sh');
		expect(matching.length).toBeGreaterThanOrEqual(2);
	});

	it('languageForExtension maps .sh, .bash, .zsh, .ksh to bash', async () => {
		const { languageForExtension: forExt } = await import('../parser-manager');
		expect(forExt('.sh')).toBe('bash');
		expect(forExt('.bash')).toBe('bash');
		expect(forExt('.zsh')).toBe('bash');
		expect(forExt('.ksh')).toBe('bash');
	});

	it('emits CALLS edges for command names, not for prefix variable assignments (FOO=bar say_hello)', async () => {
		const { edges } = await extractFile(path.join(FIXTURES, 'bash-prefix-assignment.sh'), FIXTURES);
		const calls = edges.filter(e => e.kind === 'CALLS');
		const targets = new Set(calls.map(e => e.target.split('::').pop()!));
		expect(targets.has('say_hello')).toBe(true);
		for (const t of targets) {
			expect(t.includes('=')).toBe(false);
			expect(t.startsWith('FOO')).toBe(false);
			expect(t.startsWith('PATH=')).toBe(false);
		}
	});
});

describe('TS barrel re-export extraction (sample_barrel.ts)', () => {
	it('produces IMPORTS_FROM edges for re-exports', async () => {
		const { edges } = await extractFile(path.join(FIXTURES, 'sample_barrel.ts'), FIXTURES);
		const imports = edges.filter(e => e.kind === 'IMPORTS_FROM');
		const targets = new Set(imports.map(e => e.target));
		expect(targets.has('./UserService')).toBe(true);
		expect(targets.has('./AuthManager')).toBe(true);
		expect(targets.has('./utils')).toBe(true);
	});

	it('still extracts exported class and function', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_barrel.ts'), FIXTURES);
		const classes = nodes.filter(n => n.kind === 'Class');
		const funcs = nodes.filter(n => n.kind === 'Function');
		expect(classes.some(n => n.name === 'LocalClass')).toBe(true);
		expect(funcs.some(n => n.name === 'localFunction')).toBe(true);
	});
});

describe('Ruby nested class extraction (sample.rb)', () => {
	it('qualifies class ApiClient with enclosing module Networking', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample.rb'), FIXTURES);
		const apiClient = nodes.find(n => n.kind === 'Class' && n.name === 'ApiClient');
		expect(apiClient).toBeDefined();
		expect(apiClient!.parent_name).toBe('Networking');
	});

	it('chains parent path for methods inside module > class', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample.rb'), FIXTURES);
		const initialize = nodes.find(n => n.kind === 'Function' && n.name === 'initialize');
		expect(initialize).toBeDefined();
		expect(initialize!.parent_name).toBe('Networking::ApiClient');
	});

	it('emits CONTAINS edge from class to each method (no orphans)', async () => {
		const { nodes, edges } = await extractFile(path.join(FIXTURES, 'sample.rb'), FIXTURES);
		const apiClient = nodes.find(n => n.kind === 'Class' && n.name === 'ApiClient');
		const apiClientQualified = `${apiClient!.file_path.replace(/\\/g, '/')}::${apiClient!.parent_name}::${apiClient!.name}`;

		const contains = edges.filter(e => e.kind === 'CONTAINS' && e.source === apiClientQualified);
		const targets = new Set(contains.map(e => e.target));

		expect(targets.has(`${apiClientQualified}::initialize`)).toBe(true);
		expect(targets.has(`${apiClientQualified}::get`)).toBe(true);
		expect(targets.has(`${apiClientQualified}::post`)).toBe(true);
		expect(targets.has(`${apiClientQualified}::fetch`)).toBe(true);
	});
});

describe('CommonJS module.exports extraction (sample_cjs.js)', () => {
	it('extracts top-level arrow function from module.exports object literal', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_cjs.js'), FIXTURES);
		const greet = nodes.find(n => n.kind === 'Function' && n.name === 'greet');
		expect(greet).toBeDefined();
		expect(greet!.parent_name).toBeUndefined();
	});

	it('extracts nested namespace as Type with child Function', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_cjs.js'), FIXTURES);
		const ns = nodes.find(n => n.kind === 'Type' && n.name === 'namespace');
		const helper = nodes.find(n => n.kind === 'Function' && n.name === 'helper');
		expect(ns).toBeDefined();
		expect(helper).toBeDefined();
		expect(helper!.parent_name).toBe('namespace');
	});

	it('extracts deeply nested function with chained parent path', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_cjs.js'), FIXTURES);
		const compute = nodes.find(n => n.kind === 'Function' && n.name === 'compute');
		expect(compute).toBeDefined();
		expect(compute!.parent_name).toBe('namespace::deep');
	});

	it('extracts module.exports.named single-property assignment', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_cjs.js'), FIXTURES);
		const named = nodes.find(n => n.kind === 'Function' && n.name === 'named');
		expect(named).toBeDefined();
	});

	it('extracts exports.shortcut single-property assignment', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample_cjs.js'), FIXTURES);
		const shortcut = nodes.find(n => n.kind === 'Function' && n.name === 'shortcut');
		expect(shortcut).toBeDefined();
	});

	it('emits CONTAINS edges from File to top-level CJS exports', async () => {
		const { nodes, edges } = await extractFile(path.join(FIXTURES, 'sample_cjs.js'), FIXTURES);
		const file = nodes.find(n => n.kind === 'File')!;
		const fileQualified = `${file.file_path.replace(/\\/g, '/')}::${file.name}`;
		const containedFromFile = new Set(
			edges.filter(e => e.kind === 'CONTAINS' && e.source === fileQualified).map(e => e.target),
		);
		expect([...containedFromFile].some(t => t.endsWith('::greet'))).toBe(true);
		expect([...containedFromFile].some(t => t.endsWith('::namespace'))).toBe(true);
		expect([...containedFromFile].some(t => t.endsWith('::shortcut'))).toBe(true);
	});
});

describe('C++ header extension mapping (.hh)', () => {
	it('maps .hh to cpp', () => {
		expect(languageForExtension('.hh')).toBe('cpp');
	});

	it('keeps .h mapped to c (regression)', () => {
		expect(languageForExtension('.h')).toBe('c');
	});

	it('extracts class Connection from cpp-header.hh', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'cpp-header.hh'), FIXTURES);
		const fileNode = nodes.find(n => n.kind === 'File');
		expect(fileNode).toBeDefined();
		expect(fileNode!.language).toBe('cpp');

		const classes = nodes.filter(n => n.kind === 'Class');
		expect(classes.some(n => n.name === 'Connection')).toBe(true);
	});
});

describe('Mocha TDD test runner detection (mocha-tdd.spec-fixture.ts)', () => {
	it('parses suite/setup/teardown without crashing', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'mocha-tdd.spec-fixture.ts'), FIXTURES);
		const fileNode = nodes.find(n => n.kind === 'File');
		expect(fileNode).toBeDefined();
		expect(fileNode!.language).toBe('typescript');
	});
});

describe('Bun test runtime detection', () => {
	it('isBunTestImport matches single-quoted import', () => {
		expect(isBunTestImport(`import { test } from 'bun:test'`)).toBe(true);
	});

	it('isBunTestImport matches double-quoted default import', () => {
		expect(isBunTestImport(`import test from "bun:test"`)).toBe(true);
	});

	it('isBunTestImport matches namespace import', () => {
		expect(isBunTestImport(`import * as bun from 'bun:test'`)).toBe(true);
	});

	it('isBunTestImport matches bare import without binding', () => {
		expect(isBunTestImport(`import 'bun:test'`)).toBe(true);
	});

	it('isBunTestImport ignores string literals containing the specifier', () => {
		const source = `const note = "see 'bun:test' docs";\nconst other = 'bun:test';`;
		expect(isBunTestImport(source)).toBe(false);
	});

	it('isBunTestImport ignores unrelated imports', () => {
		expect(isBunTestImport(`import { test } from 'vitest'`)).toBe(false);
	});

	it('flags bun-runtime fixture as a test file', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'bun-runtime.bun.ts'), FIXTURES);
		const fileNode = nodes.find(n => n.kind === 'File');
		expect(fileNode).toBeDefined();
		expect(fileNode!.is_test).toBe(true);
	});
});

describe('C++ scoped/destructor/operator method names (cpp-scoped.cpp)', () => {
	it('extracts plain scoped method name: Foo::bar -> bar', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'cpp-scoped.cpp'), FIXTURES);
		const fn = nodes.find(n =>
			(n.kind === 'Function' || n.kind === 'Test')
			&& n.name === 'bar'
			&& n.line_start >= 16,
		);
		expect(fn).toBeDefined();
	});

	it('extracts destructor name: Foo::~Foo -> ~Foo', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'cpp-scoped.cpp'), FIXTURES);
		const dtor = nodes.find(n =>
			(n.kind === 'Function' || n.kind === 'Test')
			&& n.name === '~Foo'
			&& n.line_start >= 16,
		);
		expect(dtor).toBeDefined();
	});

	it('extracts operator overload: operator==', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'cpp-scoped.cpp'), FIXTURES);
		const op = nodes.find(n =>
			(n.kind === 'Function' || n.kind === 'Test')
			&& n.name === 'operator=='
			&& n.line_start >= 16,
		);
		expect(op).toBeDefined();
	});

	it('extracts deeply nested scoped method: A::B::C::deep -> deep', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'cpp-scoped.cpp'), FIXTURES);
		const deep = nodes.find(n =>
			(n.kind === 'Function' || n.kind === 'Test')
			&& n.name === 'deep'
			&& n.line_start >= 16,
		);
		expect(deep).toBeDefined();
	});

	it('preserves existing non-scoped C++ extraction (sample.cpp)', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'sample.cpp'), FIXTURES);
		const fileNode = nodes.find(n => n.kind === 'File');
		expect(fileNode).toBeDefined();
		expect(fileNode!.language).toBe('cpp');
		expect(nodes.some(n => n.kind === 'Class' && n.name === 'HttpClient')).toBe(true);
	});
});

describe('Shebang-based language detection (parser-manager)', () => {
	it('resolves bash from "#!/bin/bash"', async () => {
		const { languageForShebang } = await import('../parser-manager');
		const file = path.join(FIXTURES, 'script-bash');
		expect(languageForShebang(file)).toBe('bash');
	});

	it('resolves python from "#!/usr/bin/env python3"', async () => {
		const { languageForShebang } = await import('../parser-manager');
		const file = path.join(FIXTURES, 'script-python');
		expect(languageForShebang(file)).toBe('python');
	});

	it('resolves javascript from "#!/usr/bin/env -S node ..."', async () => {
		const { languageForShebang } = await import('../parser-manager');
		const file = path.join(FIXTURES, 'script-node');
		expect(languageForShebang(file)).toBe('javascript');
	});

	it('returns null for binary files with NUL byte in first 256 bytes', async () => {
		const { languageForShebang } = await import('../parser-manager');
		const file = path.join(FIXTURES, 'script-binary.bin');
		expect(languageForShebang(file)).toBeNull();
	});

	it('languageForFile prefers extension over shebang', async () => {
		const { languageForFile } = await import('../parser-manager');
		expect(languageForFile(path.join(FIXTURES, 'sample_python.py'))).toBe('python');
	});

	it('languageForFile falls back to shebang for extension-less scripts', async () => {
		const { languageForFile } = await import('../parser-manager');
		expect(languageForFile(path.join(FIXTURES, 'script-bash'))).toBe('bash');
		expect(languageForFile(path.join(FIXTURES, 'script-python'))).toBe('python');
	});
});

describe('unsupported files', () => {
	it('returns empty for markdown', async () => {
		const result = await extractFile(path.join(FIXTURES, 'sample.md'), FIXTURES);
		expect(result.nodes).toHaveLength(0);
	});

	it('throws for nonexistent file', async () => {
		await expect(extractFile('/nonexistent/file.py', FIXTURES)).rejects.toThrow();
	});
});
