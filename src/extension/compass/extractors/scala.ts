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

export function extractScala(ctx: ExtractionContext, root: unknown): void {
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
		case 'import_declaration':
			handleImport(ctx, node, fileNid);
			break;

		case 'class_definition':
			handleClass(ctx, node, fileNid);
			return;

		case 'object_definition':
			handleObject(ctx, node, fileNid);
			return;

		case 'trait_definition':
			handleTrait(ctx, node, fileNid);
			return;

		case 'function_definition':
			handleFunction(ctx, node, fileNid, parentClassNid);
			return;

		case 'val_definition':
		case 'var_definition':
			handleValDef(ctx, node, fileNid, parentClassNid);
			break;
	}

	for (const child of node.children) {
		walk(ctx, child, fileNid, parentClassNid);
	}
}

function handleImport(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	const pathNode = node.childForFieldName('path');
	if (pathNode) {
		const importPath = nodeText(ctx.source, pathNode);
		const moduleNid = makeId(importPath);
		addEdge(ctx, fileNid, moduleNid, 'imports', node.startPosition.row + 1);
		return;
	}

	for (const child of node.children) {
		if (child.type === 'stable_identifier' || child.type === 'identifier') {
			const raw = nodeText(ctx.source, child);
			const parts = raw.split('.');
			const moduleName = parts.length > 1 ? parts.slice(0, -1).join('.') : raw;
			const moduleNid = makeId(moduleName);
			addEdge(ctx, fileNid, moduleNid, 'imports_from', node.startPosition.row + 1);
			break;
		}
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

	handleExtends(ctx, node, classNid, line);

	const body = node.childForFieldName('body') ?? findChildByType(node, 'template_body');
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

	addNode(ctx, objectNid, `${objectName} [object]`, line);
	addEdge(ctx, fileNid, objectNid, 'contains', line);

	handleExtends(ctx, node, objectNid, line);

	const body = node.childForFieldName('body') ?? findChildByType(node, 'template_body');
	if (body) {
		for (const child of body.children) {
			walk(ctx, child, fileNid, objectNid);
		}
	}
}

function handleTrait(ctx: ExtractionContext, node: AstNode, fileNid: string): void {
	const nameNode = node.childForFieldName('name');
	if (!nameNode) return;

	const traitName = nodeText(ctx.source, nameNode);
	const traitNid = makeId(ctx.stem, traitName);
	const line = node.startPosition.row + 1;

	addNode(ctx, traitNid, traitName, line);
	addEdge(ctx, fileNid, traitNid, 'contains', line);

	handleExtends(ctx, node, traitNid, line);

	const body = node.childForFieldName('body') ?? findChildByType(node, 'template_body');
	if (body) {
		for (const child of body.children) {
			walk(ctx, child, fileNid, traitNid);
		}
	}
}

function handleExtends(
	ctx: ExtractionContext,
	node: AstNode,
	classNid: string,
	line: number,
): void {
	const extendsClause = node.childForFieldName('extends')
		?? findChildByType(node, 'extends_clause');

	if (!extendsClause) {
		for (const child of node.children) {
			if (child.type === 'extends_clause') {
				extractParentTypes(ctx, child, classNid, line);
			}
		}
		return;
	}

	extractParentTypes(ctx, extendsClause, classNid, line);
}

function extractParentTypes(
	ctx: ExtractionContext,
	node: AstNode,
	classNid: string,
	line: number,
): void {
	for (const child of node.children) {
		if (child.type === 'type_identifier' || child.type === 'identifier') {
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
		} else if (child.type === 'generic_type' || child.type === 'parameterized_type') {
			const typeId = findChildByType(child, 'type_identifier') ?? findChildByType(child, 'identifier');
			if (typeId) {
				const baseName = nodeText(ctx.source, typeId);
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

function handleValDef(
	ctx: ExtractionContext,
	node: AstNode,
	fileNid: string,
	parentClassNid: string | null,
): void {
	const nameNode = node.childForFieldName('name')
		?? node.childForFieldName('pattern');
	if (!nameNode) return;

	const hasLambdaBody = findChildByType(node, 'lambda_expression')
		?? findChildByType(node, 'function_expression');
	if (!hasLambdaBody) return;

	const valName = nodeText(ctx.source, nameNode);
	const line = node.startPosition.row + 1;

	if (parentClassNid) {
		const methodNid = makeId(parentClassNid, valName);
		addNode(ctx, methodNid, `.${valName}()`, line);
		addEdge(ctx, parentClassNid, methodNid, 'method', line);
		ctx.functionBodies.push({ callerNid: methodNid, bodyNode: hasLambdaBody });
	} else {
		const funcNid = makeId(ctx.stem, valName);
		addNode(ctx, funcNid, `${valName}()`, line);
		addEdge(ctx, fileNid, funcNid, 'contains', line);
		ctx.functionBodies.push({ callerNid: funcNid, bodyNode: hasLambdaBody });
	}
}

function collectBody(ctx: ExtractionContext, node: AstNode, callerNid: string): void {
	const body = node.childForFieldName('body')
		?? findChildByType(node, 'block')
		?? findChildByType(node, 'indented_block');
	if (body) {
		ctx.functionBodies.push({ callerNid, bodyNode: body });
	}
}

function findChildByType(node: AstNode, type: string): AstNode | null {
	for (const child of node.children) {
		if (child.type === type) return child;
	}
	return null;
}
