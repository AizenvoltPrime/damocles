import * as fs from 'fs';
import * as path from 'path';
import type { FileType, DetectionResult } from './types';
import { CODE_EXTENSIONS, DOC_EXTENSIONS, PAPER_EXTENSIONS, IMAGE_EXTENSIONS } from './types';

const SENSITIVE_PATTERNS = [
	/(^|[\\/])\.(env|envrc)(\.|$)/i,
	/\.(pem|key|p12|pfx|cert|crt|der|p8)$/i,
	/(credential|secret|passwd|password|token|private_key)/i,
	/(id_rsa|id_dsa|id_ecdsa|id_ed25519)(\.pub)?$/,
	/(\.netrc|\.pgpass|\.htpasswd)$/i,
	/(aws_credentials|gcloud_credentials|service.account)/i,
];

const PAPER_SIGNALS = [
	/\barxiv\b/i,
	/\bdoi\s*:/i,
	/\babstract\b/i,
	/\bproceedings\b/i,
	/\bjournal\b/i,
	/\bpreprint\b/i,
	/\\cite\{/,
	/\[\d+\]/,
	/eq\.\s*\d+|equation\s+\d+/i,
	/\d{4}\.\d{4,5}/,
	/\bwe propose\b/i,
	/\bliterature\b/i,
];

const PAPER_SIGNAL_THRESHOLD = 3;

const SKIP_DIRS = new Set([
	'venv', '.venv', 'env', '.env',
	'node_modules', '__pycache__', '.git',
	'dist', 'build', 'target', 'out',
	'site-packages', 'lib64',
	'.pytest_cache', '.mypy_cache', '.ruff_cache',
	'.tox', '.eggs',
]);

function isSensitive(filePath: string): boolean {
	const name = path.basename(filePath);
	return SENSITIVE_PATTERNS.some(p => p.test(name) || p.test(filePath));
}

function isNoiseDir(dirName: string): boolean {
	if (SKIP_DIRS.has(dirName)) return true;
	if (dirName.endsWith('_venv') || dirName.endsWith('_env')) return true;
	if (dirName.endsWith('.egg-info')) return true;
	return false;
}

function looksLikePaper(filePath: string): boolean {
	try {
		const fd = fs.openSync(filePath, 'r');
		const buf = Buffer.alloc(3000);
		const bytesRead = fs.readSync(fd, buf, 0, 3000, 0);
		fs.closeSync(fd);
		const text = buf.toString('utf8', 0, bytesRead);
		let hits = 0;
		for (const pattern of PAPER_SIGNALS) {
			if (pattern.test(text)) hits++;
		}
		return hits >= PAPER_SIGNAL_THRESHOLD;
	} catch {
		return false;
	}
}

export function classifyFile(filePath: string): FileType | null {
	const ext = path.extname(filePath).toLowerCase();
	if (CODE_EXTENSIONS.has(ext)) return 'code';
	if (PAPER_EXTENSIONS.has(ext)) return 'paper';
	if (IMAGE_EXTENSIONS.has(ext)) return 'image';
	if (DOC_EXTENSIONS.has(ext)) {
		return looksLikePaper(filePath) ? 'paper' : 'document';
	}
	return null;
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
	maxFiles = 5000,
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
		if (files.length >= maxFiles) return;

		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}

		for (const entry of entries) {
			if (files.length >= maxFiles) return;

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

export function detect(root: string): DetectionResult {
	const files: Record<FileType, string[]> = {
		code: [],
		document: [],
		paper: [],
		image: [],
	};
	const skippedSensitive: string[] = [];

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
				walk(fullPath);
			} else if (entry.isFile()) {
				if (entry.name.startsWith('.')) continue;
				if (isSensitive(fullPath)) {
					skippedSensitive.push(fullPath);
					continue;
				}
				const ftype = classifyFile(fullPath);
				if (ftype) {
					files[ftype].push(fullPath);
				}
			}
		}
	}

	walk(root);

	const totalFiles = Object.values(files).reduce((sum, list) => sum + list.length, 0);

	let warning: string | null = null;
	if (totalFiles === 0) {
		warning = 'No supported files found in workspace.';
	}

	return {
		files,
		total_files: totalFiles,
		total_words: 0,
		needs_graph: totalFiles > 0,
		warning,
		skipped_sensitive: skippedSensitive,
	};
}
