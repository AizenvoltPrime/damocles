import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import type { CacheEntry } from './types';

export function fileHash(filePath: string): string {
	const content = fs.readFileSync(filePath);
	return crypto.createHash('sha256').update(content).digest('hex');
}

export function workspaceHash(workspacePath: string): string {
	return crypto.createHash('sha256').update(workspacePath).digest('hex').slice(0, 16);
}

function ensureCacheDir(cacheRoot: string): string {
	fs.mkdirSync(cacheRoot, { recursive: true });
	return cacheRoot;
}

export function getCacheDir(damoclesDir: string, wsPath: string): string {
	return path.join(damoclesDir, 'compass-cache', workspaceHash(wsPath));
}

export function loadCachedByHash(hash: string, cacheDir: string): CacheEntry | null {
	try {
		const entryPath = path.join(cacheDir, `${hash}.json`);
		if (!fs.existsSync(entryPath)) return null;
		const raw = fs.readFileSync(entryPath, 'utf8');
		return JSON.parse(raw) as CacheEntry;
	} catch {
		return null;
	}
}

export function saveCachedWithHash(hash: string, result: CacheEntry, cacheDir: string): void {
	ensureCacheDir(cacheDir);
	const entryPath = path.join(cacheDir, `${hash}.json`);
	fs.writeFileSync(entryPath, JSON.stringify(result));
}

export function saveCached(filePath: string, result: CacheEntry, cacheDir: string): void {
	saveCachedWithHash(fileHash(filePath), result, cacheDir);
}

export function cachedHashes(cacheDir: string): Set<string> {
	try {
		const files = fs.readdirSync(cacheDir);
		return new Set(
			files
				.filter(f => f.endsWith('.json'))
				.map(f => f.replace('.json', ''))
		);
	} catch {
		return new Set();
	}
}

export function clearCache(cacheDir: string): void {
	try {
		const files = fs.readdirSync(cacheDir);
		for (const f of files) {
			if (f.endsWith('.json')) {
				fs.unlinkSync(path.join(cacheDir, f));
			}
		}
	} catch {
		// cache dir doesn't exist yet
	}
}

export function checkCache(
	filePaths: string[],
	cacheDir: string,
): { cached: CacheEntry[]; uncached: Array<{ filePath: string; hash: string }> } {
	const cached: CacheEntry[] = [];
	const uncached: Array<{ filePath: string; hash: string }> = [];

	for (const filePath of filePaths) {
		const hash = fileHash(filePath);
		const entry = loadCachedByHash(hash, cacheDir);
		if (entry) {
			cached.push(entry);
		} else {
			uncached.push({ filePath, hash });
		}
	}

	return { cached, uncached };
}
