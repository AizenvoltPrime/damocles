import { isKnownExternal } from './known-externals';
import { TsconfigResolver } from './tsconfig-resolver';
import { ViteAliasResolver } from './vite-alias-resolver';
import { ComposerPsr4Resolver } from './composer-resolver';
import { JavaResolver } from './java-resolver';

export function getLanguageFamily(filePath: string): string | null {
	const dot = filePath.lastIndexOf('.');
	if (dot === -1) return null;
	const ext = filePath.slice(dot + 1).toLowerCase();
	switch (ext) {
		case 'ts': case 'tsx': case 'js': case 'jsx': case 'vue': return 'js';
		case 'php': return 'php';
		case 'py': return 'python';
		case 'go': return 'go';
		case 'rs': return 'rust';
		case 'java': return 'java';
		case 'cs': return 'csharp';
		case 'rb': return 'ruby';
		case 'kt': return 'kotlin';
		case 'scala': return 'scala';
		case 'c': case 'cpp': case 'cc': case 'cxx': case 'h': case 'hpp': return 'c';
		case 'kts': return 'kotlin';
		default: return null;
	}
}

const IMPORT_RESOLVE_EXTENSIONS = [
	'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue',
	'.py', '.go', '.rs', '.java', '.cs', '.rb', '.kt', '.kts',
	'.scala', '.php', '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp',
];

export interface AliasResolver {
	resolve(spec: string, sourceFilePath: string): string | null;
}

export function createAliasResolver(workspaceRoot?: string): AliasResolver {
	const tsResolver = new TsconfigResolver(workspaceRoot);
	const viteResolver = new ViteAliasResolver(workspaceRoot);
	const composerResolver = new ComposerPsr4Resolver(workspaceRoot);
	const javaResolver = new JavaResolver(workspaceRoot);
	return {
		resolve(spec: string, sourceFilePath: string): string | null {
			return tsResolver.resolveAlias(spec, sourceFilePath)
				?? viteResolver.resolveAlias(spec, sourceFilePath)
				?? composerResolver.resolveNamespace(spec, sourceFilePath)
				?? javaResolver.resolveImport(spec, sourceFilePath);
		},
	};
}

export function buildRelativeImportPathCandidates(trimmed: string, sourceFilePath: string): string[] {
	const normalizedSource = sourceFilePath.replace(/\\/g, '/');
	const lastSlash = normalizedSource.lastIndexOf('/');
	const sourceDir = lastSlash >= 0 ? normalizedSource.substring(0, lastSlash) : '';
	const sourceIsUnixAbsolute = normalizedSource.startsWith('/');

	const exactLower: string[] = [];

	if (trimmed.startsWith('./') || trimmed.startsWith('../') || trimmed.startsWith('/')) {
		const rootAnchored = trimmed.startsWith('/');
		const parts = rootAnchored ? [] : sourceDir.split('/').filter(Boolean);
		const rel = trimmed.split('/').filter(s => s !== '');
		for (const p of rel) {
			if (p === '.') continue;
			if (p === '..') parts.pop();
			else parts.push(p);
		}
		const prefix = rootAnchored || sourceIsUnixAbsolute ? '/' : '';
		const resolved = (prefix + parts.join('/')).toLowerCase();
		exactLower.push(resolved);
		for (const ext of IMPORT_RESOLVE_EXTENSIONS) {
			exactLower.push(resolved + ext);
			exactLower.push(resolved + '/index' + ext);
		}
	} else if (trimmed.startsWith('.')) {
		const dotMatch = trimmed.match(/^(\.+)(.*)$/);
		if (!dotMatch) return exactLower;
		const dots = dotMatch[1]!;
		const rest = dotMatch[2]!;
		const parts = sourceDir.split('/').filter(Boolean);
		for (let i = 0; i < dots.length - 1; i++) parts.pop();
		if (rest) {
			for (const p of rest.split('.').filter(Boolean)) parts.push(p);
		}
		const prefix = sourceIsUnixAbsolute ? '/' : '';
		const resolved = (prefix + parts.join('/')).toLowerCase();
		exactLower.push(resolved);
		for (const ext of IMPORT_RESOLVE_EXTENSIONS) {
			exactLower.push(resolved + ext);
			exactLower.push(resolved + '/index' + ext);
			exactLower.push(resolved + '/__init__' + ext);
		}
	}

	return exactLower;
}

export function resolveImportSpecToFiles(
	spec: string,
	sourceFilePath: string,
	fileLowerIndex: Array<{ lower: string; original: string }>,
	aliasResolver?: AliasResolver,
): string[] {
	const trimmed = spec.trim();
	if (!trimmed) return [];

	if (aliasResolver) {
		const resolvedAbs = aliasResolver.resolve(trimmed, sourceFilePath);
		if (resolvedAbs) {
			const lowerResolved = resolvedAbs.replace(/\\/g, '/').toLowerCase();
			for (const f of fileLowerIndex) {
				if (f.lower === lowerResolved) return [f.original];
			}
		}
	}

	const isRelativeSpec = trimmed.startsWith('./')
		|| trimmed.startsWith('../')
		|| trimmed.startsWith('/')
		|| trimmed.startsWith('.');
	if (!isRelativeSpec && isKnownExternal(trimmed)) return [];

	const exactLower = isRelativeSpec ? buildRelativeImportPathCandidates(trimmed, sourceFilePath) : [];
	const suffixes: string[] = [];

	if (!isRelativeSpec) {
		const aliasStripped = trimmed.replace(/^@[^/]+\//, '').toLowerCase();
		const normalized = aliasStripped.replace(/[.\\]/g, '/');
		for (const ext of IMPORT_RESOLVE_EXTENSIONS) {
			suffixes.push('/' + normalized + ext);
			suffixes.push('/' + normalized + '/index' + ext);
			suffixes.push('/' + normalized + '/__init__' + ext);
		}
	}

	const matches: string[] = [];
	for (const f of fileLowerIndex) {
		let matched = false;
		for (const e of exactLower) {
			if (f.lower === e) { matches.push(f.original); matched = true; break; }
		}
		if (matched) continue;
		for (const s of suffixes) {
			if (f.lower.endsWith(s)) { matches.push(f.original); break; }
		}
	}
	return matches;
}
