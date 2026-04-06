import * as path from 'path';
import type { ExtractionResult } from '../types';
import { languageForExtension, getParser } from '../parser-manager';
import { createExtractionContext, cleanEdges, runCallGraphPass } from '../extractor-base';
import type { ExtractionContext } from '../extractor-base';
import { extractPython } from './python';
import { extractJavaScript } from './javascript';
import { extractGo } from './go';
import { extractRust } from './rust';
import { extractJava } from './java';
import { extractC } from './c';
import { extractCpp } from './cpp';
import { extractRuby } from './ruby';
import { extractCSharp } from './csharp';
import { extractKotlin } from './kotlin';
import { extractScala } from './scala';
import { extractPhp } from './php';
import * as fs from 'fs';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

type AstWalker = (ctx: ExtractionContext, root: unknown) => void;

const LANGUAGE_EXTRACTORS: Record<string, AstWalker> = {
	python: extractPython,
	javascript: extractJavaScript,
	typescript: extractJavaScript,
	tsx: extractJavaScript,
	go: extractGo,
	rust: extractRust,
	java: extractJava,
	c: extractC,
	cpp: extractCpp,
	ruby: extractRuby,
	csharp: extractCSharp,
	kotlin: extractKotlin,
	scala: extractScala,
	php: extractPhp,
};

export async function extractFile(filePath: string, workspaceRoot?: string): Promise<ExtractionResult> {
	const ext = path.extname(filePath).toLowerCase();
	const language = languageForExtension(ext);

	if (!language) {
		return { nodes: [], edges: [] };
	}

	const walker = LANGUAGE_EXTRACTORS[language];
	if (!walker) {
		return { nodes: [], edges: [] };
	}

	let source: string;
	try {
		const stat = fs.statSync(filePath);
		if (stat.size > MAX_FILE_SIZE) return { nodes: [], edges: [] };
		source = fs.readFileSync(filePath, 'utf8');
	} catch {
		return { nodes: [], edges: [] };
	}

	const parser = await getParser(language);
	const tree = parser.parse(source);

	try {
		const ctx = createExtractionContext(filePath, source, workspaceRoot);
		walker(ctx, tree.rootNode);
		runCallGraphPass(ctx);
		return cleanEdges(ctx);
	} finally {
		tree.delete();
	}
}

export function getSupportedLanguages(): string[] {
	return Object.keys(LANGUAGE_EXTRACTORS);
}
