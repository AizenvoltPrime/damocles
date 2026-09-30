import * as fs from 'fs';
import * as path from 'path';

const PROBE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.vue'];
const VITE_CONFIG_NAMES = ['vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.cjs'];

interface ViteAliases {
	aliases: Record<string, string>;
	configDir: string;
}

export class ViteAliasResolver {
	private _cache = new Map<string, ViteAliases | null>();
	private _workspaceRoot: string | null;

	constructor(workspaceRoot?: string) {
		this._workspaceRoot = workspaceRoot ? normalizeRoot(workspaceRoot) : null;
	}

	resolveAlias(importStr: string, filePath: string): string | null {
		try {
			const config = this._loadForFile(filePath);
			if (!config || Object.keys(config.aliases).length === 0) return null;

			const entries = Object.entries(config.aliases).sort((a, b) => b[0].length - a[0].length);
			for (const [key, target] of entries) {
				const matched = this._matchAlias(key, importStr);
				if (matched === null) continue;
				const candidate = matched ? path.join(target, matched) : target;
				const resolved = this._probe(candidate);
				if (resolved && this._withinWorkspace(resolved)) return resolved;
			}
			return null;
		} catch {
			return null;
		}
	}

	private _withinWorkspace(candidate: string): boolean {
		if (!this._workspaceRoot) return true;
		const normalized = path.resolve(candidate).replace(/\\/g, '/').toLowerCase();
		return normalized === this._workspaceRoot || normalized.startsWith(this._workspaceRoot + '/');
	}

	private _matchAlias(key: string, importStr: string): string | null {
		if (importStr === key) return '';
		if (importStr.startsWith(key + '/')) return importStr.slice(key.length + 1);
		return null;
	}

	private _probe(base: string): string | null {
		if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
		for (const ext of PROBE_EXTENSIONS) {
			const withExt = base + ext;
			if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) return withExt;
		}
		if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
			for (const ext of PROBE_EXTENSIONS) {
				const indexFile = path.join(base, 'index' + ext);
				if (fs.existsSync(indexFile)) return indexFile;
			}
		}
		return null;
	}

	private _loadForFile(filePath: string): ViteAliases | null {
		let current = path.dirname(path.resolve(filePath));
		const visited: string[] = [];

		while (true) {
			const cached = this._cache.get(current);
			if (cached !== undefined) {
				for (const dir of visited) this._cache.set(dir, cached);
				return cached;
			}
			visited.push(current);

			for (const name of VITE_CONFIG_NAMES) {
				const candidate = path.join(current, name);
				if (fs.existsSync(candidate)) {
					const parsed = this._parseViteConfig(candidate, current);
					for (const dir of visited) this._cache.set(dir, parsed);
					return parsed;
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

	private _parseViteConfig(filePath: string, configDir: string): ViteAliases {
		let raw: string;
		try {
			raw = fs.readFileSync(filePath, 'utf8');
		} catch {
			return { aliases: {}, configDir: '' };
		}

		const aliases: Record<string, string> = {};

		const objectRe = /['"]([^'"]+)['"]\s*:\s*(?:path\.)?resolve\s*\(\s*__dirname\s*,\s*['"]([^'"]+)['"]\s*\)/g;
		let m: RegExpExecArray | null;
		while ((m = objectRe.exec(raw)) !== null) {
			aliases[m[1]!] = path.resolve(configDir, m[2]!);
		}

		const fileUrlRe = /['"]([^'"]+)['"]\s*:\s*fileURLToPath\s*\(\s*new\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)\s*\)/g;
		while ((m = fileUrlRe.exec(raw)) !== null) {
			aliases[m[1]!] = path.resolve(configDir, m[2]!);
		}

		return { aliases, configDir };
	}
}

function normalizeRoot(root: string): string {
	const normalized = path.resolve(root).replace(/\\/g, '/').toLowerCase();
	return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}
