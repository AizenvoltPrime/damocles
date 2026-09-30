import * as fs from 'fs';
import * as path from 'path';

const PROBE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.vue'];
const TSCONFIG_NAMES = ['tsconfig.json', 'tsconfig.app.json'];

interface TsconfigPaths {
	baseUrl?: string;
	paths: Record<string, string[]>;
	tsconfigDir: string;
}

export class TsconfigResolver {
	private _cache = new Map<string, TsconfigPaths | null>();
	private _workspaceRoot: string | null;

	constructor(workspaceRoot?: string) {
		this._workspaceRoot = workspaceRoot ? normalizeRoot(workspaceRoot) : null;
	}

	resolveAlias(importStr: string, filePath: string): string | null {
		try {
			const config = this._loadForFile(filePath);
			if (!config || Object.keys(config.paths).length === 0) return null;

			const baseDir = config.baseUrl
				? path.resolve(config.tsconfigDir, config.baseUrl)
				: config.tsconfigDir;

			const resolved = this._matchAndProbe(importStr, config.paths, baseDir);
			if (resolved && !this._withinWorkspace(resolved)) return null;
			return resolved;
		} catch {
			return null;
		}
	}

	private _withinWorkspace(candidate: string): boolean {
		if (!this._workspaceRoot) return true;
		const normalized = path.resolve(candidate).replace(/\\/g, '/').toLowerCase();
		return normalized === this._workspaceRoot || normalized.startsWith(this._workspaceRoot + '/');
	}

	private _loadForFile(filePath: string): TsconfigPaths | null {
		let current = path.dirname(path.resolve(filePath));
		const visited: string[] = [];

		while (true) {
			const cached = this._cache.get(current);
			if (cached !== undefined) {
				for (const dir of visited) this._cache.set(dir, cached);
				return cached;
			}

			visited.push(current);

			for (const name of TSCONFIG_NAMES) {
				const candidate = path.join(current, name);
				if (fs.existsSync(candidate)) {
					const config = this._parseTsconfig(candidate);
					config.tsconfigDir = current;
					for (const dir of visited) this._cache.set(dir, config);
					return config;
				}
			}

			const parent = path.dirname(current);
			if (parent === current) {
				for (const dir of visited) this._cache.set(dir, null);
				return null;
			}
			current = parent;
		}
	}

	private _parseTsconfig(tsconfigPath: string): TsconfigPaths {
		const seen = new Set<string>();
		return this._resolveExtends(tsconfigPath, seen);
	}

	private _resolveExtends(tsconfigPath: string, seen: Set<string>): TsconfigPaths {
		const canonical = path.resolve(tsconfigPath);
		if (seen.has(canonical)) return { paths: {}, tsconfigDir: '' };
		seen.add(canonical);

		let raw: string;
		try {
			raw = fs.readFileSync(tsconfigPath, 'utf8');
		} catch {
			return { paths: {}, tsconfigDir: '' };
		}

		const stripped = stripJsoncComments(raw);
		let data: Record<string, unknown>;
		try {
			data = JSON.parse(stripped);
		} catch {
			return { paths: {}, tsconfigDir: '' };
		}

		const result: TsconfigPaths = { paths: {}, tsconfigDir: '' };

		const extendsValue = data['extends'];
		if (typeof extendsValue === 'string' && extendsValue.startsWith('.')) {
			let parentPath = path.resolve(path.dirname(tsconfigPath), extendsValue);
			if (!path.extname(parentPath)) parentPath += '.json';
			if (fs.existsSync(parentPath)) {
				const parent = this._resolveExtends(parentPath, seen);
				Object.assign(result.paths, parent.paths);
				if (parent.baseUrl) result.baseUrl = parent.baseUrl;
			}
		}

		const compilerOptions = data['compilerOptions'] as Record<string, unknown> | undefined;
		if (compilerOptions) {
			if (typeof compilerOptions['baseUrl'] === 'string') {
				result.baseUrl = compilerOptions['baseUrl'];
			}
			const paths = compilerOptions['paths'] as Record<string, string[]> | undefined;
			if (paths) Object.assign(result.paths, paths);
		}

		return result;
	}

	private _matchAndProbe(
		importStr: string,
		paths: Record<string, string[]>,
		baseDir: string,
	): string | null {
		const sorted = Object.entries(paths).sort((a, b) => {
			const aPrefix = a[0].split('*')[0] ?? '';
			const bPrefix = b[0].split('*')[0] ?? '';
			return bPrefix.length - aPrefix.length;
		});

		for (const [pattern, replacements] of sorted) {
			const suffix = matchPattern(pattern, importStr);
			if (suffix === null) continue;

			for (const replacement of replacements) {
				const mapped = replacement.includes('*') ? replacement.replace('*', suffix) : replacement;
				const candidateBase = path.resolve(baseDir, mapped);
				const found = probePath(candidateBase);
				if (found) return found;
			}
		}

		return null;
	}
}

function matchPattern(pattern: string, importStr: string): string | null {
	if (!pattern.includes('*')) {
		return importStr === pattern ? '' : null;
	}

	const [prefix, suffixPat] = pattern.split('*') as [string, string];
	if (!importStr.startsWith(prefix)) return null;
	if (suffixPat && !importStr.endsWith(suffixPat)) return null;

	const end = suffixPat ? importStr.length - suffixPat.length : importStr.length;
	return importStr.slice(prefix.length, end);
}

function probePath(base: string): string | null {
	if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;

	for (const ext of PROBE_EXTENSIONS) {
		const withExt = base.endsWith(ext) ? base : base + ext;
		if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) return withExt;
	}

	if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
		for (const ext of PROBE_EXTENSIONS) {
			const indexFile = path.join(base, `index${ext}`);
			if (fs.existsSync(indexFile)) return indexFile;
		}
	}

	return null;
}

function normalizeRoot(root: string): string {
	const normalized = path.resolve(root).replace(/\\/g, '/').toLowerCase();
	return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

function stripJsoncComments(text: string): string {
	const result: string[] = [];
	let i = 0;
	const n = text.length;

	while (i < n) {
		const ch = text[i]!;

		if (ch === '"') {
			result.push(ch);
			i++;
			while (i < n) {
				const c = text[i]!;
				result.push(c);
				if (c === '\\' && i + 1 < n) {
					i++;
					result.push(text[i]!);
				} else if (c === '"') {
					break;
				}
				i++;
			}
			i++;
			continue;
		}

		if (ch === '/' && i + 1 < n && text[i + 1] === '*') {
			i += 2;
			while (i < n - 1) {
				if (text[i] === '*' && text[i + 1] === '/') {
					i += 2;
					break;
				}
				i++;
			}
			continue;
		}

		if (ch === '/' && i + 1 < n && text[i + 1] === '/') {
			i += 2;
			while (i < n && text[i] !== '\n') i++;
			continue;
		}

		result.push(ch);
		i++;
	}

	return result.join('').replace(/,\s*([\]}])/g, '$1');
}
