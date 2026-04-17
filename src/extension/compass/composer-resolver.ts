import * as fs from 'fs';
import * as path from 'path';

interface ComposerPsr4 {
	prefixes: Array<{ namespace: string; dirs: string[] }>;
	rootDir: string;
}

export class ComposerPsr4Resolver {
	private _cache = new Map<string, ComposerPsr4 | null>();
	private _workspaceRoot: string | null;

	constructor(workspaceRoot?: string) {
		this._workspaceRoot = workspaceRoot ? normalizeRoot(workspaceRoot) : null;
	}

	resolveNamespace(fqcn: string, sourceFilePath: string): string | null {
		const normalized = fqcn.replace(/^\\+/, '').replace(/\//g, '\\');
		if (!normalized.includes('\\')) return null;

		const config = this._loadForFile(sourceFilePath);
		if (!config || config.prefixes.length === 0) return null;

		for (const { namespace, dirs } of config.prefixes) {
			if (!normalized.startsWith(namespace)) continue;
			const suffix = normalized.slice(namespace.length).replace(/\\/g, '/');
			for (const dir of dirs) {
				const absolute = path.resolve(config.rootDir, dir, suffix + '.php');
				if (!this._withinWorkspace(absolute)) continue;
				if (fs.existsSync(absolute) && fs.statSync(absolute).isFile()) {
					return absolute;
				}
			}
		}
		return null;
	}

	private _withinWorkspace(candidate: string): boolean {
		if (!this._workspaceRoot) return true;
		const normalized = path.resolve(candidate).replace(/\\/g, '/').toLowerCase();
		return normalized === this._workspaceRoot || normalized.startsWith(this._workspaceRoot + '/');
	}

	private _loadForFile(filePath: string): ComposerPsr4 | null {
		let current = path.dirname(path.resolve(filePath));
		const visited: string[] = [];

		while (true) {
			const cached = this._cache.get(current);
			if (cached !== undefined) {
				for (const dir of visited) this._cache.set(dir, cached);
				return cached;
			}
			visited.push(current);

			const composerPath = path.join(current, 'composer.json');
			if (fs.existsSync(composerPath)) {
				const parsed = this._parseComposer(composerPath, current);
				for (const dir of visited) this._cache.set(dir, parsed);
				return parsed;
			}

			const parent = path.dirname(current);
			if (parent === current) {
				for (const dir of visited) this._cache.set(dir, null);
				return null;
			}
			current = parent;
		}
	}

	private _parseComposer(filePath: string, configDir: string): ComposerPsr4 | null {
		let raw: string;
		try {
			raw = fs.readFileSync(filePath, 'utf8');
		} catch {
			return null;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return null;
		}

		if (!parsed || typeof parsed !== 'object') return null;
		const obj = parsed as Record<string, unknown>;

		const prefixMap = new Map<string, string[]>();
		collectPsr4(obj['autoload'], prefixMap);
		collectPsr4(obj['autoload-dev'], prefixMap);

		if (prefixMap.size === 0) return null;

		const prefixes = Array.from(prefixMap, ([namespace, dirs]) => ({ namespace, dirs }));
		prefixes.sort((a, b) => b.namespace.length - a.namespace.length);

		return { prefixes, rootDir: configDir };
	}
}

function collectPsr4(section: unknown, out: Map<string, string[]>): void {
	if (!section || typeof section !== 'object') return;
	const psr4 = (section as Record<string, unknown>)['psr-4'];
	if (!psr4 || typeof psr4 !== 'object') return;

	for (const [rawNs, rawDirs] of Object.entries(psr4 as Record<string, unknown>)) {
		const namespace = rawNs.endsWith('\\') ? rawNs : rawNs + '\\';
		const dirs = Array.isArray(rawDirs) ? rawDirs.filter((d): d is string => typeof d === 'string')
			: typeof rawDirs === 'string' ? [rawDirs]
			: [];
		if (dirs.length === 0) continue;
		const existing = out.get(namespace);
		if (existing) existing.push(...dirs);
		else out.set(namespace, [...dirs]);
	}
}

function normalizeRoot(root: string): string {
	const normalized = path.resolve(root).replace(/\\/g, '/').toLowerCase();
	return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}
