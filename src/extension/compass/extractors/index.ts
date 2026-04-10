import * as path from 'path';
import * as fs from 'fs';
import type { ExtractionResult } from '../extractor-base';
import { createExtractionContext, addNode, cleanEdges, runCallGraphPass } from '../extractor-base';
import { languageForExtension, getParser } from '../parser-manager';
import { extractFromTree } from './walker';
import { extractVueFile } from './vue';
import { isTestFile } from './lang-maps';
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

	const language = languageForExtension(ext);
	if (!language) return { nodes: [], edges: [] };

	const parser = await getParser(language);
	const tree = parser.parse(source);

	try {
		const ctx = createExtractionContext(filePath, source, workspaceRoot);
		const lineCount = source.split('\n').length;
		const isTest = isTestFile(filePath);

		addNode(ctx, 'File', path.basename(filePath), 1, lineCount, {
			language,
			isTest,
		});

		extractFromTree(tree.rootNode as unknown as TreeNode, ctx, language);
		runCallGraphPass(ctx);
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
