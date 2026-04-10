import * as path from 'path';
import type Parser from 'web-tree-sitter';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let treeSitterModule: any = null;
let initPromise: Promise<void> | null = null;

const parserCache = new Map<string, Parser>();

let grammarDir = '';

export function setGrammarDir(dir: string): void {
	grammarDir = dir;
}

const WASM_FILES: Record<string, string> = {
	python: 'tree-sitter-python.wasm',
	javascript: 'tree-sitter-javascript.wasm',
	typescript: 'tree-sitter-typescript.wasm',
	tsx: 'tree-sitter-tsx.wasm',
	go: 'tree-sitter-go.wasm',
	rust: 'tree-sitter-rust.wasm',
	java: 'tree-sitter-java.wasm',
	c: 'tree-sitter-c.wasm',
	cpp: 'tree-sitter-cpp.wasm',
	ruby: 'tree-sitter-ruby.wasm',
	csharp: 'tree-sitter-c_sharp.wasm',
	kotlin: 'tree-sitter-kotlin.wasm',
	scala: 'tree-sitter-scala.wasm',
	php: 'tree-sitter-php.wasm',
	vue: 'tree-sitter-vue.wasm',
};

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
	'.py': 'python',
	'.js': 'javascript',
	'.ts': 'typescript',
	'.tsx': 'tsx',
	'.jsx': 'javascript',
	'.go': 'go',
	'.rs': 'rust',
	'.java': 'java',
	'.c': 'c',
	'.h': 'c',
	'.cpp': 'cpp',
	'.cc': 'cpp',
	'.cxx': 'cpp',
	'.hpp': 'cpp',
	'.rb': 'ruby',
	'.cs': 'csharp',
	'.kt': 'kotlin',
	'.kts': 'kotlin',
	'.scala': 'scala',
	'.php': 'php',
};

export function languageForExtension(ext: string): string | null {
	return EXTENSION_TO_LANGUAGE[ext.toLowerCase()] ?? null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function ensureTreeSitter(): Promise<any> {
	if (treeSitterModule) return treeSitterModule;
	if (!initPromise) {
		initPromise = (async () => {
			const mod = await import('web-tree-sitter');
			const TreeSitter = mod.default;
			await TreeSitter.init();
			treeSitterModule = TreeSitter;
		})();
	}
	await initPromise;
	return treeSitterModule;
}

export async function getParser(language: string): Promise<Parser> {
	const cached = parserCache.get(language);
	if (cached) return cached;

	const TreeSitter = await ensureTreeSitter();
	const parser = new TreeSitter();

	const wasmFile = WASM_FILES[language];
	if (!wasmFile) throw new Error(`No grammar WASM for language: ${language}`);
	if (!grammarDir) throw new Error('Grammar directory not configured. Call setGrammarDir() first.');

	const wasmPath = path.join(grammarDir, wasmFile);
	const lang = await TreeSitter.Language.load(wasmPath);
	parser.setLanguage(lang);
	parserCache.set(language, parser);
	return parser;
}

export function clearParsers(): void {
	for (const parser of parserCache.values()) {
		parser.delete();
	}
	parserCache.clear();
	treeSitterModule = null;
	initPromise = null;
}

export function getSupportedExtensions(): string[] {
	return Object.keys(EXTENSION_TO_LANGUAGE);
}
