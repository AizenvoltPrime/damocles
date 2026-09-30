import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GraphStore } from '../database';
import { createTestStore } from './sql-test-helper';


interface IndexLoadCounters {
	getAllFilesCalls: number;
	nodeIndexQueries: number;
	importIndexQueries: number;
}

function instrumentIndexLoads(store: GraphStore): IndexLoadCounters {
	const counters: IndexLoadCounters = { getAllFilesCalls: 0, nodeIndexQueries: 0, importIndexQueries: 0 };
	const originalGetAllFiles = store.getAllFiles.bind(store);
	store.getAllFiles = () => { counters.getAllFilesCalls++; return originalGetAllFiles(); };
	const originalPrepare = store.db.prepare.bind(store.db);
	store.db.prepare = (sql: string) => {
		if (sql.includes('SELECT name, qualified_name, file_path, kind FROM nodes')) counters.nodeIndexQueries++;
		if (sql.includes("SELECT file_path, target_qualified FROM edges WHERE kind = 'IMPORTS_FROM'")) counters.importIndexQueries++;
		return originalPrepare(sql);
	};
	return counters;
}

describe('resolveExternalEdges — known-external pre-filter (US-006)', () => {
	let store: GraphStore;
	afterEach(() => store?.close());

	it('returns 0 without loading any resolution indexes when every unresolved edge targets a permanent external', () => {
		store = createTestStore();
		store.upsertNode({ kind: 'File', name: 'a.ts', file_path: '/src/a.ts', line_start: 1, line_end: 10 });
		store.upsertNode({ kind: 'Function', name: 'doWork', file_path: '/src/a.ts', line_start: 2, line_end: 4 });
		store.upsertEdge({ kind: 'IMPORTS_FROM', source: '/src/a.ts::a.ts', target: 'vscode', file_path: '/src/a.ts', line: 1 });
		store.upsertEdge({ kind: 'IMPORTS_FROM', source: '/src/a.ts::a.ts', target: 'fs', file_path: '/src/a.ts', line: 2 });
		store.upsertEdge({ kind: 'IMPORTS_FROM', source: '/src/a.ts::a.ts', target: 'node:path', file_path: '/src/a.ts', line: 3 });
		store.upsertEdge({ kind: 'IMPORTS_FROM', source: '/src/a.ts::a.ts', target: '@scope/pkg', file_path: '/src/a.ts', line: 4 });
		store.upsertEdge({ kind: 'IMPORTS_FROM', source: '/src/a.ts::a.ts', target: './theme.css', file_path: '/src/a.ts', line: 5 });
		store.upsertEdge({ kind: 'INHERITS', source: '/src/a.ts::doWork', target: 'std::fmt::Display', file_path: '/src/a.ts', line: 6 });
		store.upsertEdge({ kind: 'INHERITS', source: '/src/a.ts::doWork', target: 'Illuminate\\Console\\Command', file_path: '/src/a.ts', line: 7 });

		const counters = instrumentIndexLoads(store);
		const resolved = store.resolveExternalEdges();

		expect(resolved).toBe(0);
		expect(counters.getAllFilesCalls).toBe(0);
		expect(counters.nodeIndexQueries).toBe(0);
		expect(counters.importIndexQueries).toBe(0);

		const fileImports = store.getEdgesBySource('/src/a.ts::a.ts').filter(e => e.kind === 'IMPORTS_FROM');
		expect(new Set(fileImports.map(e => e.target_qualified)))
			.toEqual(new Set(['vscode', 'fs', 'node:path', '@scope/pkg', './theme.css']));
	});

	it('still resolves a bare-name INHERITS target while dropped externals stay untouched', () => {
		store = createTestStore();
		store.upsertNode({ kind: 'File', name: 'base.ts', file_path: '/src/base.ts', line_start: 1, line_end: 10 });
		store.upsertNode({ kind: 'Class', name: 'BaseService', file_path: '/src/base.ts', line_start: 2, line_end: 8 });
		store.upsertNode({ kind: 'File', name: 'svc.ts', file_path: '/src/svc.ts', line_start: 1, line_end: 10 });
		store.upsertNode({ kind: 'Class', name: 'DataService', file_path: '/src/svc.ts', line_start: 2, line_end: 8 });
		store.upsertEdge({ kind: 'INHERITS', source: '/src/svc.ts::DataService', target: 'BaseService', file_path: '/src/svc.ts', line: 2 });
		store.upsertEdge({ kind: 'IMPORTS_FROM', source: '/src/svc.ts::svc.ts', target: 'vscode', file_path: '/src/svc.ts', line: 1 });

		const resolved = store.resolveExternalEdges();

		expect(resolved).toBe(1);
		const inherits = store.getEdgesBySource('/src/svc.ts::DataService').filter(e => e.kind === 'INHERITS');
		expect(inherits).toHaveLength(1);
		expect(inherits[0]!.target_qualified).toBe('/src/base.ts::BaseService');
		const imports = store.getEdgesBySource('/src/svc.ts::svc.ts').filter(e => e.kind === 'IMPORTS_FROM');
		expect(imports[0]!.target_qualified).toBe('vscode');
	});

	it('still resolves scoped-alias imports through tsconfig paths despite their bare-module shape', () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-prefilter-'));
		try {
			fs.mkdirSync(path.join(tmp, 'src'));
			fs.writeFileSync(
				path.join(tmp, 'tsconfig.json'),
				JSON.stringify({ compilerOptions: { paths: { '@app/*': ['./src/*'] } } }),
			);
			fs.writeFileSync(path.join(tmp, 'src', 'lib.ts'), 'export const one = 1;\n');
			const libPath = path.join(tmp, 'src', 'lib.ts').replace(/\\/g, '/');
			const consumerPath = path.join(tmp, 'src', 'consumer.ts').replace(/\\/g, '/');

			store = createTestStore();
			store.upsertNode({ kind: 'File', name: 'lib.ts', file_path: libPath, line_start: 1, line_end: 1 });
			store.upsertNode({ kind: 'File', name: 'consumer.ts', file_path: consumerPath, line_start: 1, line_end: 1 });
			store.upsertEdge({
				kind: 'IMPORTS_FROM', source: `${consumerPath}::consumer.ts`, target: '@app/lib',
				file_path: consumerPath, line: 1,
			});

			const resolved = store.resolveExternalEdges(tmp);

			expect(resolved).toBe(1);
			const imports = store.getEdgesBySource(`${consumerPath}::consumer.ts`).filter(e => e.kind === 'IMPORTS_FROM');
			expect(imports[0]!.target_qualified).toBe(`${libPath}::lib.ts`);
		} finally {
			fs.rmSync(tmp, { recursive: true, force: true });
		}
	});

	it('still resolves namespaced INHERITS via the PHP path-suffix convention when the file exists in-graph', () => {
		store = createTestStore();
		store.upsertNode({ kind: 'File', name: 'Command.php', file_path: '/app/Illuminate/Console/Command.php', line_start: 1, line_end: 20 });
		store.upsertNode({ kind: 'Class', name: 'Command', file_path: '/app/Illuminate/Console/Command.php', line_start: 2, line_end: 18 });
		store.upsertNode({ kind: 'File', name: 'MyCommand.php', file_path: '/app/src/MyCommand.php', line_start: 1, line_end: 20 });
		store.upsertNode({ kind: 'Class', name: 'MyCommand', file_path: '/app/src/MyCommand.php', line_start: 2, line_end: 18 });
		store.upsertEdge({
			kind: 'INHERITS', source: '/app/src/MyCommand.php::MyCommand', target: 'Illuminate\\Console\\Command',
			file_path: '/app/src/MyCommand.php', line: 2,
		});

		const resolved = store.resolveExternalEdges();

		expect(resolved).toBe(1);
		const inherits = store.getEdgesBySource('/app/src/MyCommand.php::MyCommand').filter(e => e.kind === 'INHERITS');
		expect(inherits[0]!.target_qualified).toBe('/app/Illuminate/Console/Command.php::Command');
	});

	it('still resolves asset-suffixed relative imports that map to an indexed file (vanilla-extract style)', () => {
		store = createTestStore();
		store.upsertNode({ kind: 'File', name: 'style.css.ts', file_path: '/src/style.css.ts', line_start: 1, line_end: 5 });
		store.upsertNode({ kind: 'File', name: 'main.ts', file_path: '/src/main.ts', line_start: 1, line_end: 10 });
		store.upsertEdge({
			kind: 'IMPORTS_FROM', source: '/src/main.ts::main.ts', target: './style.css',
			file_path: '/src/main.ts', line: 1,
		});

		const resolved = store.resolveExternalEdges();

		expect(resolved).toBe(1);
		const imports = store.getEdgesBySource('/src/main.ts::main.ts').filter(e => e.kind === 'IMPORTS_FROM');
		expect(imports[0]!.target_qualified).toBe('/src/style.css.ts::style.css.ts');
	});

	it('keeps non-ASCII targets actionable despite SQLite ASCII-only LOWER folding (L1)', () => {
		store = createTestStore();
		store.upsertNode({ kind: 'File', name: 'base.ts', file_path: '/src/base.ts', line_start: 1, line_end: 10 });
		store.upsertNode({ kind: 'Class', name: 'Überklasse', file_path: '/src/base.ts', line_start: 2, line_end: 8 });
		store.upsertNode({ kind: 'File', name: 'svc.ts', file_path: '/src/svc.ts', line_start: 1, line_end: 10 });
		store.upsertNode({ kind: 'Class', name: 'Dienst', file_path: '/src/svc.ts', line_start: 2, line_end: 8 });
		store.upsertEdge({ kind: 'INHERITS', source: '/src/svc.ts::Dienst', target: 'Überklasse', file_path: '/src/svc.ts', line: 2 });

		const resolved = store.resolveExternalEdges();

		expect(resolved).toBe(1);
		const inherits = store.getEdgesBySource('/src/svc.ts::Dienst').filter(e => e.kind === 'INHERITS');
		expect(inherits[0]!.target_qualified).toBe('/src/base.ts::Überklasse');
	});

	it('never pre-filters CALLS edges: unresolvable known-external call targets are still deleted', () => {
		store = createTestStore();
		store.upsertNode({ kind: 'File', name: 'a.ts', file_path: '/src/a.ts', line_start: 1, line_end: 10 });
		store.upsertNode({ kind: 'Function', name: 'caller', file_path: '/src/a.ts', line_start: 2, line_end: 4 });
		store.upsertEdge({ kind: 'CALLS', source: '/src/a.ts::caller', target: 'fs', file_path: '/src/a.ts', line: 3 });

		store.resolveExternalEdges();

		const calls = store.getEdgesBySource('/src/a.ts::caller').filter(e => e.kind === 'CALLS');
		expect(calls).toHaveLength(0);
	});
});
