import * as fs from 'fs';
import * as path from 'path';
import { CODE_EXTENSIONS } from './types';
import { languageForShebang } from './parser-manager';
import { isWithinRoot } from './util';

const CREDENTIAL_DATA_EXTENSIONS = new Set([
	'.env', '.envrc', '.ini', '.conf', '.cfg', '.properties',
	'.json', '.yaml', '.yml', '.toml',
	'.txt', '.csv', '.tsv',
]);

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

export function isSensitive(filePath: string): boolean {
	const name = path.basename(filePath);
	if (SENSITIVE_FILE_PATTERNS.some(p => p.test(name) || p.test(filePath))) return true;

	const ext = path.extname(name).toLowerCase();
	if (!CREDENTIAL_DATA_EXTENSIONS.has(ext)) return false;

	return SENSITIVE_NAME_PATTERNS.some(p => p.test(name));
}

function isNoiseDir(dirName: string): boolean {
	if (SKIP_DIRS.has(dirName)) return true;
	if (dirName.endsWith('_venv') || dirName.endsWith('_env')) return true;
	if (dirName.endsWith('.egg-info')) return true;
	return false;
}

const SCRIPT_DIR_PATTERN = /(^|\/)(bin|scripts|hooks|\.git\/hooks)(\/|$)/;

function isScriptDirPath(filePath: string): boolean {
	const normalized = filePath.replace(/\\/g, '/');
	return SCRIPT_DIR_PATTERN.test(normalized);
}

export function shouldProbeShebang(filePath: string, mode: number): boolean {
	if (isScriptDirPath(filePath)) return true;
	if (process.platform === 'win32') return false;
	return (mode & 0o100) !== 0;
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

function shouldExcludePath(root: string, filePath: string, excludeRegexes: RegExp[]): boolean {
	const rel = path.relative(root, filePath).replace(/\\/g, '/');
	return excludeRegexes.some(re => re.test(rel));
}

function hasHiddenOrNoiseDirSegment(root: string, filePath: string): boolean {
	const rel = path.relative(root, filePath).replace(/\\/g, '/');
	const dirSegments = rel.split('/').slice(0, -1);
	return dirSegments.some(s => s.startsWith('.') || isNoiseDir(s));
}

function includeExtensionlessByShebang(filePath: string, dir: string, name: string): boolean {
	let mode = 0;
	try {
		mode = fs.statSync(path.join(dir, name)).mode;
	} catch {
		return false;
	}
	if (!shouldProbeShebang(filePath, mode)) return false;
	return languageForShebang(filePath) !== null;
}

export function createFileFilter(root: string, excludePatterns: string[] = []): (filePath: string) => boolean {
	const excludeRegexes = compileExcludePatterns(excludePatterns);
	return (filePath: string): boolean => {
		const name = path.basename(filePath);
		if (name.startsWith('.')) return false;
		if (hasHiddenOrNoiseDirSegment(root, filePath)) return false;
		if (isSensitive(filePath)) return false;
		if (shouldExcludePath(root, filePath, excludeRegexes)) return false;
		if (name.endsWith('.blade.php')) return false;
		const ext = path.extname(name).toLowerCase();
		if (CODE_EXTENSIONS.has(ext)) return true;
		if (ext !== '') return false;
		return includeExtensionlessByShebang(filePath, path.dirname(filePath), name);
	};
}

export function createWatcherFileFilter(root: string, excludePatterns: string[] = []): (filePath: string) => boolean {
	const isIndexableFile = createFileFilter(root, excludePatterns);
	let rootReal: string;
	try {
		rootReal = fs.realpathSync(root);
	} catch {
		rootReal = path.resolve(root);
	}
	return (filePath: string): boolean => {
		if (!isIndexableFile(filePath)) return false;
		try {
			if (fs.lstatSync(filePath).isSymbolicLink()) return false;
		} catch {
			return true;
		}
		try {
			return isWithinRoot(fs.realpathSync(filePath), rootReal);
		} catch {
			return true;
		}
	};
}

export function collectFiles(
	root: string,
	excludePatterns: string[] = [],
): string[] {
	const files: string[] = [];
	const excludeRegexes = compileExcludePatterns(excludePatterns);
	const isIndexableFile = createFileFilter(root, excludePatterns);

	let rootReal: string;
	try {
		rootReal = fs.realpathSync(root);
	} catch {
		return files;
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
				if (shouldExcludePath(root, fullPath, excludeRegexes)) continue;
				if (!isWithinRoot(fullPath, rootReal)) continue;
				walk(fullPath);
			} else if (entry.isFile()) {
				if (isIndexableFile(fullPath)) files.push(fullPath);
			}
		}
	}

	walk(root);
	return files;
}
