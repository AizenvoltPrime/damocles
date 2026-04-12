import * as fs from 'fs';
import * as path from 'path';
import { CODE_EXTENSIONS } from './types';

const SENSITIVE_FILE_PATTERNS = [
	/(^|[\\/])\.(env|envrc)(\.|$)/i,
	/\.(pem|key|p12|pfx|cert|crt|der|p8)$/i,
	/(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/,
	/(\.netrc|\.pgpass|\.htpasswd)$/i,
];

const SENSITIVE_NAME_PATTERNS = [
	/(credential|secret|passwd|password|private_key)/i,
	/(aws_credentials|gcloud_credentials|service.account)/i,
];

const SKIP_DIRS = new Set([
	'venv', '.venv', 'env', '.env',
	'node_modules', '__pycache__', '.git',
	'dist', 'build', 'target', 'out',
	'site-packages', 'lib64',
	'.pytest_cache', '.mypy_cache', '.ruff_cache',
	'.tox', '.eggs',
	'vendor', '.bundle', '.gradle',
	'.dart_tool', '.pub-cache',
	'coverage', '.cache',
]);

function isSensitive(filePath: string): boolean {
	const name = path.basename(filePath);
	if (SENSITIVE_FILE_PATTERNS.some(p => p.test(name) || p.test(filePath))) return true;
	return SENSITIVE_NAME_PATTERNS.some(p => p.test(name));
}

function isNoiseDir(dirName: string): boolean {
	if (SKIP_DIRS.has(dirName)) return true;
	if (dirName.endsWith('_venv') || dirName.endsWith('_env')) return true;
	if (dirName.endsWith('.egg-info')) return true;
	return false;
}

const MAX_EXCLUDE_PATTERN_LENGTH = 200;

function compileExcludePatterns(patterns: string[]): RegExp[] {
	const regexes: RegExp[] = [];
	for (const p of patterns) {
		if (p.length > MAX_EXCLUDE_PATTERN_LENGTH) continue;
		try {
			regexes.push(new RegExp(p));
		} catch {
			// skip invalid patterns
		}
	}
	return regexes;
}

function isWithinRoot(resolvedPath: string, rootReal: string): boolean {
	const isWindows = process.platform === 'win32';
	let normalized = resolvedPath.replace(/\\/g, '/');
	let rootNorm = rootReal.replace(/\\/g, '/');
	if (isWindows) {
		normalized = normalized.toLowerCase();
		rootNorm = rootNorm.toLowerCase();
	}
	return normalized.startsWith(rootNorm + '/') || normalized === rootNorm;
}

export function collectFiles(
	root: string,
	excludePatterns: string[] = [],
): string[] {
	const files: string[] = [];
	const excludeRegexes = compileExcludePatterns(excludePatterns);

	let rootReal: string;
	try {
		rootReal = fs.realpathSync(root);
	} catch {
		return files;
	}

	function shouldExclude(filePath: string): boolean {
		const rel = path.relative(root, filePath);
		return excludeRegexes.some(re => re.test(rel));
	}

	function walk(dir: string): void {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {

			if (entry.isSymbolicLink()) continue;

			const fullPath = path.join(dir, entry.name);

			if (entry.isDirectory()) {
				if (entry.name.startsWith('.') || isNoiseDir(entry.name)) continue;
				if (shouldExclude(fullPath)) continue;
				if (!isWithinRoot(fullPath, rootReal)) continue;
				walk(fullPath);
			} else if (entry.isFile()) {
				if (entry.name.startsWith('.')) continue;
				if (isSensitive(fullPath)) continue;
				if (shouldExclude(fullPath)) continue;
				const ext = path.extname(entry.name).toLowerCase();
				if (CODE_EXTENSIONS.has(ext)) {
					files.push(fullPath);
				}
			}
		}
	}

	walk(root);
	return files;
}
