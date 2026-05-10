import * as fs from 'fs';
import * as path from 'path';

const JAVA_SOURCE_ROOT_SUFFIXES: string[] = [
	path.join('src', 'main', 'java'),
	path.join('src', 'test', 'java'),
	path.join('app', 'src', 'main', 'java'),
	path.join('app', 'src', 'test', 'java'),
];

const PATH_CASE_INSENSITIVE = process.platform === 'win32';

interface JavaSourceRoots {
	roots: string[];
}

export class JavaResolver {
	private _cache = new Map<string, JavaSourceRoots | null>();
	private _workspaceRoot: string | null;

	constructor(workspaceRoot?: string) {
		this._workspaceRoot = workspaceRoot ? normalizeRoot(workspaceRoot) : null;
	}

	resolveImport(spec: string, sourceFilePath: string): string | null {
		const normalized = normalizeJavaSpec(spec);
		if (!normalized) return null;

		const roots = this._loadForFile(sourceFilePath);
		if (!roots || roots.roots.length === 0) return null;

		const relative = normalized.replace(/\./g, path.sep) + '.java';
		for (const root of roots.roots) {
			const candidate = path.resolve(root, relative);
			const realCandidate = realPathOrNull(candidate);
			if (!realCandidate) continue;
			if (!this._withinWorkspace(realCandidate)) continue;
			if (fs.existsSync(realCandidate) && fs.statSync(realCandidate).isFile()) {
				return realCandidate;
			}
		}
		return null;
	}

	private _withinWorkspace(resolvedCandidate: string): boolean {
		if (!this._workspaceRoot) return true;
		const candidateNormalized = normalizeForCompare(path.resolve(resolvedCandidate));
		const relative = path.relative(this._workspaceRoot, candidateNormalized);
		if (relative === '') return true;
		if (relative.startsWith('..')) return false;
		if (path.isAbsolute(relative)) return false;
		return true;
	}

	private _loadForFile(filePath: string): JavaSourceRoots | null {
		const start = path.dirname(path.resolve(filePath));
		const cached = this._cache.get(start);
		if (cached !== undefined) return cached;

		const accumulated: string[] = [];
		const seen = new Set<string>();
		const visited: string[] = [];

		const collect = (dir: string): void => {
			for (const root of discoverSourceRoots(dir)) {
				if (!seen.has(root)) {
					seen.add(root);
					accumulated.push(root);
				}
			}
		};

		let current = start;
		let topReached = current;
		while (true) {
			visited.push(current);
			collect(current);
			topReached = current;

			const parent = path.dirname(current);
			if (parent === current) break;
			if (this._workspaceRoot) {
				const normalizedCurrent = normalizeForCompare(current);
				if (normalizedCurrent === this._workspaceRoot) break;
				const relative = path.relative(this._workspaceRoot, normalizedCurrent);
				if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) break;
			}
			current = parent;
		}

		discoverSiblingSourceRoots(topReached).forEach(collect);

		const result: JavaSourceRoots | null = accumulated.length > 0 ? { roots: accumulated } : null;
		for (const dir of visited) this._cache.set(dir, result);
		return result;
	}
}

function discoverSiblingSourceRoots(repoRoot: string): string[] {
	let entries: string[];
	try {
		entries = fs.readdirSync(repoRoot);
	} catch {
		return [];
	}
	const siblings: string[] = [];
	for (const entry of entries) {
		const candidate = path.join(repoRoot, entry);
		try {
			if (fs.statSync(candidate).isDirectory()) siblings.push(candidate);
		} catch {
			// ignore unreadable entries
		}
	}
	return siblings;
}

export function normalizeJavaSpec(spec: string): string | null {
	const trimmed = spec.trim().replace(/;$/, '').trim();
	if (!trimmed) return null;

	const withoutImport = trimmed.replace(/^import\s+/, '').trim();
	const staticStripped = withoutImport.replace(/^static\s+/, '').trim();
	const wasStatic = staticStripped !== withoutImport;

	if (staticStripped.endsWith('.*') || staticStripped === '*') return null;

	if (wasStatic) {
		const lastDot = staticStripped.lastIndexOf('.');
		if (lastDot <= 0) return null;
		return staticStripped.slice(0, lastDot);
	}

	return staticStripped;
}

export function isJavaWildcardImport(spec: string): boolean {
	const trimmed = spec.trim().replace(/;$/, '').trim();
	const withoutImport = trimmed.replace(/^import\s+/, '').replace(/^static\s+/, '').trim();
	return withoutImport.endsWith('.*') || withoutImport === '*';
}

function discoverSourceRoots(dir: string): string[] {
	const found: string[] = [];
	for (const suffix of JAVA_SOURCE_ROOT_SUFFIXES) {
		const candidate = path.join(dir, suffix);
		if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
			found.push(candidate);
		}
	}
	return found;
}

function normalizeRoot(root: string): string {
	const resolved = realPathOrNull(path.resolve(root)) ?? path.resolve(root);
	const normalized = normalizeForCompare(resolved);
	return normalized.endsWith(path.sep) && normalized.length > 1
		? normalized.slice(0, -1)
		: normalized;
}

function normalizeForCompare(p: string): string {
	return PATH_CASE_INSENSITIVE ? p.toLowerCase() : p;
}

function realPathOrNull(p: string): string | null {
	try {
		return fs.realpathSync(p);
	} catch {
		return null;
	}
}
