import * as path from 'path';
import type { ExtractionContext } from '../types';
import { createExtractionContext, addNode, cleanEdges, runCallGraphPass, markFileNodeIfNoCallables } from '../extractor-base';
import type { ExtractionResult } from '../extractor-base';
import { getParser } from '../parser-manager';
import { extractFromTree } from './walker';
import type { TreeNode } from './ast-helpers';

export async function extractVueFile(filePath: string, source: string, workspaceRoot: string): Promise<ExtractionResult> {
	const ctx = createExtractionContext(filePath, source, workspaceRoot, 'vue');
	const lineCount = source.split('\n').length;

	addNode(ctx, 'File', path.basename(filePath), 1, lineCount, { language: 'vue' });

	let vueParser;
	try {
		vueParser = await getParser('vue');
	} catch {
		return fallbackExtractScripts(filePath, source, ctx);
	}

	const tree = vueParser.parse(source);
	const scriptTrees: Array<{ delete(): void }> = [];

	try {
		const root = tree.rootNode as unknown as TreeNode;

		for (const child of root.children) {
			if (child.type !== 'script_element') continue;

			const { scriptLang, scriptSource, lineOffset } = parseScriptElement(child);
			if (!scriptSource) continue;

			const savedOffset = ctx.lineOffset;
			ctx.lineOffset = lineOffset;

			try {
				const scriptParser = await getParser(scriptLang);
				const scriptTree = scriptParser.parse(scriptSource);
				scriptTrees.push(scriptTree);
				extractFromTree(scriptTree.rootNode as unknown as TreeNode, ctx, scriptLang);
			} catch {
				// skip unparseable script blocks
			}

			ctx.lineOffset = savedOffset;
		}

		for (const node of ctx.nodes) {
			if (node.kind !== 'File') node.language = 'vue';
		}

		runCallGraphPass(ctx);
		markFileNodeIfNoCallables(ctx);
		return cleanEdges(ctx);
	} finally {
		for (const st of scriptTrees) st.delete();
		tree.delete();
	}
}

interface ScriptBlockInfo {
	scriptLang: string;
	scriptSource: string | null;
	lineOffset: number;
}

function parseScriptElement(element: TreeNode): ScriptBlockInfo {
	let scriptLang = 'javascript';
	let rawTextNode: TreeNode | null = null;

	for (const sub of element.children) {
		if (sub.type === 'start_tag') {
			for (const attr of sub.children) {
				if (attr.type !== 'attribute') continue;
				let attrName: string | null = null;
				let attrValue: string | null = null;
				for (const a of attr.children) {
					if (a.type === 'attribute_name') attrName = a.text;
					if (a.type === 'quoted_attribute_value') {
						for (const v of a.children) {
							if (v.type === 'attribute_value') attrValue = v.text;
						}
					}
				}
				if (attrName === 'lang' && (attrValue === 'ts' || attrValue === 'typescript')) {
					scriptLang = 'typescript';
				}
			}
		}
		if (sub.type === 'raw_text') {
			rawTextNode = sub;
		}
	}

	if (!rawTextNode) {
		return { scriptLang, scriptSource: null, lineOffset: 0 };
	}

	return {
		scriptLang,
		scriptSource: rawTextNode.text,
		lineOffset: rawTextNode.startPosition.row,
	};
}

async function fallbackExtractScripts(
	_filePath: string,
	source: string,
	ctx: ExtractionContext,
): Promise<ExtractionResult> {
	const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
	let match;

	while ((match = scriptRegex.exec(source)) !== null) {
		const attrs = match[1] ?? '';
		const content = match[2] ?? '';
		if (!content.trim()) continue;

		const lang = /lang=["'](ts|typescript)["']/i.test(attrs) ? 'typescript' : 'javascript';
		const lineOffset = source.slice(0, match.index).split('\n').length;

		ctx.lineOffset = lineOffset;

		try {
			const parser = await getParser(lang);
			const tree = parser.parse(content);
			try {
				extractFromTree(tree.rootNode as unknown as TreeNode, ctx, lang);
			} finally {
				tree.delete();
			}
		} catch {
			// skip
		}
	}

	ctx.lineOffset = 0;
	for (const node of ctx.nodes) {
		if (node.kind !== 'File') node.language = 'vue';
	}

	runCallGraphPass(ctx);
	markFileNodeIfNoCallables(ctx);
	return cleanEdges(ctx);
}
