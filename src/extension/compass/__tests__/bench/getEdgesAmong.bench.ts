import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { performance } from 'perf_hooks';
import Module from 'module';

const NODE_COUNT = 18_000;
const EDGE_COUNT = 70_000;
const FILE_COUNT = 360;
const QUERY_SET_SIZE = 500;
const WARMUP_ITERATIONS = 10;
const MEASURE_ITERATIONS = 100;
const ZIPF_S = 1.07;
const SEED = 0xC0FFEE;

const ModuleAny = Module as unknown as {
	_resolveFilename(request: string, parent: unknown, ...rest: unknown[]): string;
};
const originalResolve = ModuleAny._resolveFilename;
const vscodeMockPath = path.join(__dirname, '_vscode-mock.cjs');
ModuleAny._resolveFilename = function (request: string, parent: unknown, ...rest: unknown[]): string {
	if (request === 'vscode') return vscodeMockPath;
	return originalResolve.call(this, request, parent, ...rest);
};

function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return function (): number {
		a = (a + 0x6D2B79F5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function buildZipfCdf(n: number, s: number): Float64Array {
	const cdf = new Float64Array(n);
	let sum = 0;
	for (let i = 0; i < n; i++) {
		sum += 1 / Math.pow(i + 1, s);
		cdf[i] = sum;
	}
	for (let i = 0; i < n; i++) cdf[i] = cdf[i]! / sum;
	return cdf;
}

function zipfSample(rng: () => number, cdf: Float64Array): number {
	const r = rng();
	let lo = 0;
	let hi = cdf.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (cdf[mid]! < r) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
	return sorted[idx]!;
}

interface BenchStats {
	p50: number;
	p99: number;
	mean: number;
	min: number;
	max: number;
}

function summarize(durations: number[]): BenchStats {
	const sorted = [...durations].sort((a, b) => a - b);
	const mean = durations.reduce((acc, v) => acc + v, 0) / durations.length;
	return {
		p50: percentile(sorted, 0.5),
		p99: percentile(sorted, 0.99),
		mean,
		min: sorted[0]!,
		max: sorted[sorted.length - 1]!,
	};
}

async function main(): Promise<void> {
	const databaseModule = await import('../../database');
	const GraphStoreCtor = databaseModule.GraphStore;
	type SqlJsStaticT = import('../../database').SqlJsStatic;

	const wasmPath = path.join(process.cwd(), 'node_modules', 'sql.js-fts5', 'dist', 'sql-wasm.wasm');
	const wasmBinary = fs.readFileSync(wasmPath);
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const initSqlJs = require('sql.js-fts5');
	const engine = (await initSqlJs({ wasmBinary })) as SqlJsStaticT;

	const store = new GraphStoreCtor(path.join(os.tmpdir(), `compass-bench-${Date.now()}.db`));
	store.openFromEngine(engine);

	const rng = mulberry32(SEED);

	const functionNames: string[] = [];
	const filePaths: string[] = [];
	for (let f = 0; f < FILE_COUNT; f++) {
		filePaths.push(`/src/pkg${Math.floor(f / 40)}/mod${Math.floor(f / 8)}/file${f}.ts`);
	}

	const NON_FILE_NODE_COUNT = NODE_COUNT - FILE_COUNT;
	const functionsPerFile = Math.ceil(NON_FILE_NODE_COUNT / FILE_COUNT);

	const seedStart = performance.now();
	store.withTransaction(() => {
		const insertNode = store.db.prepare(`
			INSERT INTO nodes
				(kind, name, name_tokens, qualified_name, file_path, line_start, line_end,
				 language, parent_name, params, return_type, modifiers, signature,
				 is_test, file_hash, extra, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);

		const now = Date.now() / 1000;

		for (let f = 0; f < FILE_COUNT; f++) {
			const filePath = filePaths[f]!;
			insertNode.run(
				'File', `file${f}.ts`, `file ${f} ts`, `${filePath}::file${f}.ts`,
				filePath, 1, functionsPerFile * 15 + 10,
				'typescript', null, null, null, null, null,
				0, null, '{}', now,
			);
		}

		let totalInserted = 0;
		outer: for (let f = 0; f < FILE_COUNT; f++) {
			const filePath = filePaths[f]!;
			for (let fn = 0; fn < functionsPerFile; fn++) {
				if (totalInserted >= NON_FILE_NODE_COUNT) break outer;
				const kindIdx = (f + fn) % 3;
				const kind = kindIdx === 0 ? 'Function' : kindIdx === 1 ? 'Class' : 'Type';
				const name = `${kind.toLowerCase()}_${f}_${fn}`;
				const qn = `${filePath}::${name}`;
				functionNames.push(qn);
				const lineStart = fn * 15 + 5;
				insertNode.run(
					kind, name, `${kind.toLowerCase()} ${f} ${fn}`, qn,
					filePath, lineStart, lineStart + 12,
					'typescript', null,
					kind === 'Function' ? '(x: number)' : null,
					kind === 'Function' ? 'void' : null,
					null, null,
					0, null, '{}', now,
				);
				totalInserted++;
			}
		}

		const insertEdge = store.db.prepare(`
			INSERT INTO edges (kind, source_qualified, target_qualified, file_path, line, extra, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?)
		`);

		const callableCount = functionNames.length;
		const cdf = buildZipfCdf(callableCount, ZIPF_S);

		const edgeKinds = ['CALLS', 'CALLS', 'CALLS', 'CALLS', 'REFERENCES', 'CONTAINS', 'IMPORTS_FROM'];

		for (let e = 0; e < EDGE_COUNT; e++) {
			const srcIdx = zipfSample(rng, cdf);
			let dstIdx = zipfSample(rng, cdf);
			if (dstIdx === srcIdx) dstIdx = (dstIdx + 1) % callableCount;

			const src = functionNames[srcIdx]!;
			const dst = functionNames[dstIdx]!;
			const kind = edgeKinds[Math.floor(rng() * edgeKinds.length)]!;
			const srcFile = src.split('::')[0]!;

			insertEdge.run(kind, src, dst, srcFile, Math.floor(rng() * 1000), '{}', now);
		}
	});
	const seedEnd = performance.now();

	const nodeCount = store.getNodeCount();
	const edgeCount = store.getEdgeCount();

	const querySet = new Set<string>();
	for (let i = 0; i < QUERY_SET_SIZE && i < functionNames.length; i++) {
		querySet.add(functionNames[i]!);
	}

	function runInPath(qnSet: Set<string>): number {
		const list = [...qnSet];
		const placeholders = list.map(() => '?').join(',');
		const rows = store.db.prepare(
			`SELECT * FROM edges WHERE source_qualified IN (${placeholders}) AND target_qualified IN (${placeholders})`,
		).all(...list, ...list);
		return rows.length;
	}

	for (let i = 0; i < WARMUP_ITERATIONS; i++) {
		runInPath(querySet);
		store.getEdgesAmong(querySet);
	}

	const inPathDurations: number[] = [];
	let inPathSize = 0;
	for (let i = 0; i < MEASURE_ITERATIONS; i++) {
		const t0 = performance.now();
		const size = runInPath(querySet);
		const t1 = performance.now();
		inPathDurations.push(t1 - t0);
		inPathSize = size;
	}

	const tempPathDurations: number[] = [];
	let tempPathSize = 0;
	for (let i = 0; i < MEASURE_ITERATIONS; i++) {
		const t0 = performance.now();
		const res = store.getEdgesAmong(querySet);
		const t1 = performance.now();
		tempPathDurations.push(t1 - t0);
		tempPathSize = res.length;
	}

	const inStats = summarize(inPathDurations);
	const tempStats = summarize(tempPathDurations);

	const cpuModel = os.cpus()[0]?.model ?? 'unknown';
	const cpuCount = os.cpus().length;

	console.log('==== getEdgesAmong benchmark ====');
	console.log(`Machine        : ${os.platform()} ${os.release()} | ${cpuModel} x${cpuCount}`);
	console.log(`Node           : ${process.version}`);
	console.log(`Fixture size   : ${nodeCount} nodes, ${edgeCount} edges (seeded in ${(seedEnd - seedStart).toFixed(0)} ms)`);
	console.log(`Files          : ${FILE_COUNT}`);
	console.log(`Distribution   : Zipf(s=${ZIPF_S}) over ${functionNames.length} callables`);
	console.log(`Query set size : ${querySet.size}`);
	console.log(`Warmup iters   : ${WARMUP_ITERATIONS}`);
	console.log(`Measure iters  : ${MEASURE_ITERATIONS}`);
	console.log('---- IN-path (baseline) ----');
	console.log(`Result size : ${inPathSize}`);
	console.log(`p50   : ${inStats.p50.toFixed(3)} ms`);
	console.log(`p99   : ${inStats.p99.toFixed(3)} ms`);
	console.log(`mean  : ${inStats.mean.toFixed(3)} ms`);
	console.log(`min   : ${inStats.min.toFixed(3)} ms`);
	console.log(`max   : ${inStats.max.toFixed(3)} ms`);
	console.log('---- Temp-table path (getEdgesAmong) ----');
	console.log(`Result size : ${tempPathSize}`);
	console.log(`p50   : ${tempStats.p50.toFixed(3)} ms`);
	console.log(`p99   : ${tempStats.p99.toFixed(3)} ms`);
	console.log(`mean  : ${tempStats.mean.toFixed(3)} ms`);
	console.log(`min   : ${tempStats.min.toFixed(3)} ms`);
	console.log(`max   : ${tempStats.max.toFixed(3)} ms`);

	store.close();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
