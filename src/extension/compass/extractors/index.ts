import * as path from 'path';
import * as fs from 'fs';
import type { ExtractionResult } from '../extractor-base';
import { createExtractionContext, addNode, cleanEdges, runCallGraphPass, markFileNodeIfNoCallables } from '../extractor-base';
import { languageForFile, getParser } from '../parser-manager';
import { extractFromTree } from './walker';
import { extractVueFile } from './vue';
import { isTestFile, isBunTestImport } from './lang-maps';
import type { TreeNode } from './ast-helpers';

const MAX_FILE_SIZE = 5 * 1024 * 1024;

export async function extractFile(filePath: string, workspaceRoot: string): Promise<ExtractionResult> {
	const ext = path.extname(filePath).toLowerCase();

	let source: string;
	try {
		const stat = fs.statSync(filePath);
		if (stat.size > MAX_FILE_SIZE) return { nodes: [], edges: [] };
		source = fs.readFileSync(filePath, 'utf8');
	} catch {
		return { nodes: [], edges: [] };
	}

	if (ext === '.vue') {
		return extractVueFile(filePath, source, workspaceRoot);
	}

	const language = languageForFile(filePath);
	if (!language) return { nodes: [], edges: [] };

	let parser;
	try {
		parser = await getParser(language);
	} catch {
		return { nodes: [], edges: [] };
	}
	const tree = parser.parse(source);

	try {
		const ctx = createExtractionContext(filePath, source, workspaceRoot, language);
		const lineCount = source.split('\n').length;
		const isTest = isTestFile(filePath) || isBunTestImport(source);

		addNode(ctx, 'File', path.basename(filePath), 1, lineCount, {
			language,
			isTest,
		});

		extractFromTree(tree.rootNode as unknown as TreeNode, ctx, language);
		ctx.rootNode = tree.rootNode;
		runCallGraphPass(ctx);
		markFileNodeIfNoCallables(ctx);
		return cleanEdges(ctx);
	} finally {
		tree.delete();
	}
}

export function getSupportedLanguages(): string[] {
	return [
		'python', 'javascript', 'typescript', 'tsx', 'vue',
		'go', 'rust', 'java', 'c', 'cpp', 'ruby',
		'csharp', 'kotlin', 'scala', 'php',
	];
}
