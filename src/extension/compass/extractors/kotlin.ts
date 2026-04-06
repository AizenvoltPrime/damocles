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

export function extractKotlin(ctx: ExtractionContext, root: unknown): void {
	const fileNid = ctx.fileId;
	addNode(ctx, fileNid, ctx.stem, 1, 'file');

	walk(ctx, root as AstNode, fileNid, null);
}

function walk(
	ctx: ExtractionContext,
	node: AstNode,
	fileNid: string,
	parentClassNid: string | null,
): void {
	switch (node.type) {
		case 'import_header':
			handleImport(ctx, node, fileNid);
			break;

		case 'class_declaration':
			handleClass(ctx, node, fileNid);
			return;

		case 'object_declaration':
			handleObject(ctx, node, fileNid);
			return;

		case 'function_declaration':
			handleFunction(ctx, node, fileNid, parentClassNid);
			return;
	}

	for (const child of node.children) {
		walk(ctx, child, fileNid, parentClassNid);
	}
}

function handleImport(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	const identifierNode = node.childForFieldName('identifier');
	if (identifierNode) {
		const importPath = nodeText(ctx.source, identifierNode);
		const moduleNid = makeId(importPath);
		addEdge(ctx, fileNid, moduleNid, 'imports', node.startPosition.row + 1);
		return;
	}

	for (const child of node.children) {
		if (child.type === 'identifier' || child.type === 'navigation_expression') {
			const importPath = nodeText(ctx.source, child);
			const moduleNid = makeId(importPath);
			addEdge(ctx, fileNid, moduleNid, 'imports', node.startPosition.row + 1);
			break;
		}
	}
}

function handleClass(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) {
		const typeId = findChildByType(node, 'type_identifier');
		if (!typeId) return;
		processClass(ctx, node, fileNid, nodeText(ctx.source, typeId), isDataClass(node));
		return;
	}

	const className = nodeText(ctx.source, nameNode);
	processClass(ctx, node, fileNid, className, isDataClass(node));
}

function processClass(
	ctx: ExtractionContext,
	node: AstNode,
	fileNid: string,
	className: string,
	dataClass: boolean,
): void {
	const classNid = makeId(ctx.stem, className);
	const line = node.startPosition.row + 1;
	const label = dataClass ? `${className} [data]` : className;

	addNode(ctx, classNid, label, line, 'class');
	addEdge(ctx, fileNid, classNid, 'contains', line);

	handleDelegationSpecifiers(ctx, node, classNid, line);

	const body = node.childForFieldName('body') ?? findChildByType(node, 'class_body');
	if (body) {
		for (const child of body.children) {
			walk(ctx, child, fileNid, classNid);
		}
	}
}

function handleObject(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const objectName = nodeText(ctx.source, nameNode);
	const objectNid = makeId(ctx.stem, objectName);
	const line = node.startPosition.row + 1;

	addNode(ctx, objectNid, `${objectName} [object]`, line, 'type');
	addEdge(ctx, fileNid, objectNid, 'contains', line);

	handleDelegationSpecifiers(ctx, node, objectNid, line);

	const body = node.childForFieldName('body') ?? findChildByType(node, 'class_body');
	if (body) {
		for (const child of body.children) {
			walk(ctx, child, fileNid, objectNid);
		}
	}
}

function handleDelegationSpecifiers(
	ctx: ExtractionContext,
	node: AstNode,
	classNid: string,
	line: number,
): void {
	const specifiers = node.childForFieldName('supertypes')
		?? findChildByType(node, 'delegation_specifier');

	if (!specifiers) {
		for (const child of node.children) {
			if (child.type === 'delegation_specifier' || child.type === 'delegation_specifiers') {
				extractSuperTypes(ctx, child, classNid, line);
			}
		}
		return;
	}

	extractSuperTypes(ctx, specifiers, classNid, line);
}

function extractSuperTypes(
	ctx: ExtractionContext,
	node: AstNode,
	classNid: string,
	line: number,
): void {
	for (const child of node.children) {
		if (child.type === 'user_type' || child.type === 'type_identifier') {
			const baseName = extractSimpleTypeName(ctx, child);
			const baseNid = makeId(baseName);
			if (!ctx.seenIds.has(baseNid)) {
				ctx.seenIds.add(baseNid);
				ctx.nodes.push({
					id: baseNid,
					label: baseName,
					file_type: 'code',
					source_file: '',
					source_location: `L${line}`,
					kind: 'class',
				});
			}
			addEdge(ctx, classNid, baseNid, 'inherits', line);
		} else if (child.type === 'delegation_specifier') {
			extractSuperTypes(ctx, child, classNid, line);
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
	if (!nameNode) {
		const idNode = findChildByType(node, 'simple_identifier');
		if (!idNode) return;
		processFunction(ctx, node, fileNid, parentClassNid, nodeText(ctx.source, idNode));
		return;
	}

	processFunction(ctx, node, fileNid, parentClassNid, nodeText(ctx.source, nameNode));
}

function processFunction(
	ctx: ExtractionContext,
	node: AstNode,
	fileNid: string,
	parentClassNid: string | null,
	funcName: string,
): void {
	const line = node.startPosition.row + 1;

	if (parentClassNid) {
		const methodNid = makeId(parentClassNid, funcName);
		addNode(ctx, methodNid, `.${funcName}()`, line, 'method');
		addEdge(ctx, parentClassNid, methodNid, 'method', line);
		collectBody(ctx, node, methodNid);
	} else {
		const funcNid = makeId(ctx.stem, funcName);
		addNode(ctx, funcNid, `${funcName}()`, line, 'function');
		addEdge(ctx, fileNid, funcNid, 'contains', line);
		collectBody(ctx, node, funcNid);
	}
}

function collectBody(ctx: ExtractionContext, node: AstNode, callerNid: string): void {
	const body = node.childForFieldName('body') ?? findChildByType(node, 'function_body');
	if (body) {
		ctx.functionBodies.push({ callerNid, bodyNode: body });
	}
}

function isDataClass(node: AstNode): boolean {
	for (const child of node.children) {
		if (child.type === 'modifiers' || child.type === 'modifier') {
			const text = child.children.map(c => c.type).join(' ');
			if (text.includes('data')) return true;
			for (const mod of child.children) {
				if (mod.type === 'data') return true;
			}
		}
		if (child.type === 'data') return true;
	}
	return false;
}

function findChildByType(node: AstNode, type: string): AstNode | null {
	for (const child of node.children) {
		if (child.type === type) return child;
	}
	return null;
}

function extractSimpleTypeName(ctx: ExtractionContext, node: AstNode): string {
	if (node.type === 'user_type') {
		const typeId = findChildByType(node, 'type_identifier');
		if (typeId) return nodeText(ctx.source, typeId);
	}
	return nodeText(ctx.source, node);
}
