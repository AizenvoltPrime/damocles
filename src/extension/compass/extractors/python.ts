import type { ExtractionContext } from '../extractor-base';
import { makeId, addNode, addEdge, nodeText } from '../extractor-base';

interface AstNode {
	type: string;
	children: AstNode[];
	childForFieldName(name: string): AstNode | null;
	startPosition: { row: number; column: number };
	startIndex: number;
	endIndex: number;
}

export function extractPython(ctx: ExtractionContext, root: unknown): void {
	const fileNid = ctx.fileId;
	addNode(ctx, fileNid, ctx.stem, 1);

	walk(ctx, root as AstNode, fileNid, null);
}

function walk(
	ctx: ExtractionContext,
	node: AstNode,
	fileNid: string,
	parentClassNid: string | null,
): void {
	switch (node.type) {
		case 'import_statement':
			handleImport(ctx, node, fileNid);
			break;

		case 'import_from_statement':
			handleImportFrom(ctx, node, fileNid);
			break;

		case 'class_definition':
			handleClass(ctx, node, fileNid);
			return;

		case 'function_definition':
			handleFunction(ctx, node, fileNid, parentClassNid);
			return;
	}

	for (const child of node.children) {
		walk(ctx, child, fileNid, parentClassNid);
	}
}

function handleImport(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	for (const child of node.children) {
		if (child.type === 'dotted_name') {
			const moduleName = nodeText(ctx.source, child);
			const moduleNid = makeId(moduleName);
			addEdge(ctx, fileNid, moduleNid, 'imports', node.startPosition.row + 1);
		}
	}
}

function handleImportFrom(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	const moduleNode = node.childForFieldName('module_name');

	let moduleName: string | null = null;
	if (moduleNode) {
		moduleName = nodeText(ctx.source, moduleNode);
	} else {
		for (const child of node.children) {
			if (child.type === 'dotted_name' || child.type === 'relative_import') {
				moduleName = nodeText(ctx.source, child);
				break;
			}
		}
	}

	if (moduleName) {
		const moduleNid = makeId(moduleName);
		addEdge(ctx, fileNid, moduleNid, 'imports_from', node.startPosition.row + 1);
	}
}

function handleClass(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const className = nodeText(ctx.source, nameNode);
	const classNid = makeId(ctx.stem, className);
	const line = node.startPosition.row + 1;

	addNode(ctx, classNid, className, line);
	addEdge(ctx, fileNid, classNid, 'contains', line);

	const superclasses = node.childForFieldName('superclasses');
	if (superclasses) {
		for (const child of superclasses.children) {
			if (child.type === 'identifier' || child.type === 'attribute') {
				const baseName = nodeText(ctx.source, child);
				const baseNid = makeId(baseName);
				if (!ctx.seenIds.has(baseNid)) {
					ctx.seenIds.add(baseNid);
					ctx.nodes.push({
						id: baseNid,
						label: baseName,
						file_type: 'code',
						source_file: '',
						source_location: `L${line}`,
					});
				}
				addEdge(ctx, classNid, baseNid, 'inherits', line);
			}
		}
	}

	const body = node.childForFieldName('body');
	if (body) {
		for (const child of body.children) {
			walk(ctx, child, fileNid, classNid);
		}
	}
}

function handleFunction(
	ctx: ExtractionContext,
	node: AstNode,
	fileNid: string,
	parentClassNid: string | null,
): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const funcName = nodeText(ctx.source, nameNode);
	const line = node.startPosition.row + 1;

	if (parentClassNid) {
		const methodNid = makeId(parentClassNid, funcName);
		addNode(ctx, methodNid, `.${funcName}()`, line);
		addEdge(ctx, parentClassNid, methodNid, 'method', line);
		collectBody(ctx, node, methodNid);
	} else {
		const funcNid = makeId(ctx.stem, funcName);
		addNode(ctx, funcNid, `${funcName}()`, line);
		addEdge(ctx, fileNid, funcNid, 'contains', line);
		collectBody(ctx, node, funcNid);
	}
}

function collectBody(ctx: ExtractionContext, node: AstNode, callerNid: string): void {
	const body = node.childForFieldName('body');
	if (body) {
		ctx.functionBodies.push({ callerNid, bodyNode: body });
	}
}
