import * as fs from 'fs';
import * as path from 'path';
import type Parser from 'web-tree-sitter';

interface TreeSitterModule {
	new (): Parser;
	init(): Promise<void>;
	Language: { load(path: string): Promise<Parser.Language> };
}

let treeSitterModule: TreeSitterModule | null = null;
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
	bash: 'tree-sitter-bash.wasm',
};

/**
 * Shell extensions reuse the bash grammar; zsh/ksh share enough syntax with bash
 * that the bash grammar handles them acceptably for graph extraction purposes.
 */
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
	'.hh': 'cpp',
	'.rb': 'ruby',
	'.cs': 'csharp',
	'.kt': 'kotlin',
	'.kts': 'kotlin',
	'.scala': 'scala',
	'.php': 'php',
	'.sh': 'bash',
	'.bash': 'bash',
	'.zsh': 'bash',
	'.ksh': 'bash',
};

export function languageForExtension(ext: string): string | null {
	return EXTENSION_TO_LANGUAGE[ext.toLowerCase()] ?? null;
}

const SHEBANG_INTERPRETER_TO_LANGUAGE: Record<string, string> = {
	bash: 'bash',
	sh: 'bash',
	zsh: 'bash',
	ksh: 'bash',
	python: 'python',
	python2: 'python',
	python3: 'python',
	node: 'javascript',
	nodejs: 'javascript',
	ruby: 'ruby',
	php: 'php',
};

const SHEBANG_HEAD_BYTES = 256;
const SHEBANG_PATTERN = /^#!\s*(?:\/usr\/bin\/env\s+)?(?:-S\s+)?(\S+)(?:\s+(.*))?$/;

export function languageForShebang(filePath: string): string | null {
	let fd: number;
	try {
		fd = fs.openSync(filePath, 'r');
	} catch {
		return null;
	}

	const buffer = Buffer.alloc(SHEBANG_HEAD_BYTES);
	let bytesRead = 0;
	try {
		bytesRead = fs.readSync(fd, buffer, 0, SHEBANG_HEAD_BYTES, 0);
	} catch {
		return null;
	} finally {
		fs.closeSync(fd);
	}

	if (bytesRead === 0) return null;

	const head = buffer.subarray(0, bytesRead);
	if (head.includes(0)) return null;

	const text = head.toString('utf8');
	const newlineIndex = text.indexOf('\n');
	const firstLine = (newlineIndex === -1 ? text : text.slice(0, newlineIndex)).replace(/\r$/, '');

	return interpreterFromShebangLine(firstLine);
}

function interpreterFromShebangLine(line: string): string | null {
	const match = SHEBANG_PATTERN.exec(line);
	if (!match) return null;

	const firstToken = match[1]!;
	const remainder = match[2] ?? '';

	let interpreter = path.basename(firstToken);
	if (interpreter === 'env') {
		const envTokens = remainder.split(/\s+/).filter(Boolean);
		const realInterpreter = envTokens.find(token => !token.startsWith('-'));
		if (!realInterpreter) return null;
		interpreter = path.basename(realInterpreter);
	}

	return SHEBANG_INTERPRETER_TO_LANGUAGE[interpreter] ?? null;
}

export function languageForFile(filePath: string): string | null {
	const ext = path.extname(filePath).toLowerCase();
	const fromExt = EXTENSION_TO_LANGUAGE[ext];
	if (fromExt) return fromExt;
	return languageForShebang(filePath);
}

async function ensureTreeSitter(): Promise<TreeSitterModule> {
	if (treeSitterModule) return treeSitterModule;
	if (!initPromise) {
		initPromise = (async () => {
			const mod = await import('web-tree-sitter');
			const TreeSitter = mod.default as unknown as TreeSitterModule;
			await TreeSitter.init();
			treeSitterModule = TreeSitter;
		})();
	}
	await initPromise;
	if (!treeSitterModule) throw new Error('Tree-sitter initialization failed');
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
