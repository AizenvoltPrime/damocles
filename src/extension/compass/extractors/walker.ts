import { addNode, addEdge, markArrowWrapperRegistered } from '../extractor-base';
import { qualifyName } from '../schema';
import type { ExtractionContext, NodeKind } from '../types';
import { CLASS_TYPES, TYPE_TYPES, FUNCTION_TYPES, IMPORT_TYPES, JS_LANGUAGES, isTestFunction } from './lang-maps';
import type { TreeNode } from './ast-helpers';
import { getName, getParams, getReturnType, getBases, getModifiers, getBody, getImportTarget, buildSignature, getGoReceiverType, getRustAttributes } from './ast-helpers';

const MAX_AST_DEPTH = 180;

const _typeSetCache = new Map<string, { classTypes: Set<string>; typeTypes: Set<string>; funcTypes: Set<string>; importTypes: Set<string> }>();

function getTypeSets(language: string) {
	let cached = _typeSetCache.get(language);
	if (!cached) {
		cached = {
			classTypes: new Set(CLASS_TYPES[language] ?? []),
			typeTypes: new Set(TYPE_TYPES[language] ?? []),
			funcTypes: new Set(FUNCTION_TYPES[language] ?? []),
			importTypes: new Set(IMPORT_TYPES[language] ?? []),
		};
		_typeSetCache.set(language, cached);
	}
	return cached;
}

export function extractFromTree(
	node: TreeNode,
	ctx: ExtractionContext,
	language: string,
	enclosingClass?: string,
	depth = 0,
): void {
	if (depth > MAX_AST_DEPTH) return;

	const { classTypes, typeTypes, funcTypes, importTypes } = getTypeSets(language);

	for (const child of node.children) {
		const t = child.type;

		if (JS_LANGUAGES.has(language) && (t === 'lexical_declaration' || t === 'variable_declaration')) {
			if (handleJsVarFunction(child, ctx, language, enclosingClass, depth)) continue;
		}

		if (JS_LANGUAGES.has(language) && t === 'public_field_definition' && enclosingClass) {
			if (handleJsFieldFunction(child, ctx, language, enclosingClass, depth)) continue;
		}

		if (JS_LANGUAGES.has(language) && t === 'expression_statement') {
			if (handleJsCjsExport(child, ctx, language, enclosingClass, depth)) continue;
		}

		if (JS_LANGUAGES.has(language) && t === 'call_expression') {
			handleJsDynamicImport(child, ctx);
		}

		if (language === 'bash' && t === 'command') {
			handleBashSourceImport(child, ctx);
		}

		if (JS_LANGUAGES.has(language) && t === 'export_statement') {
			const source = child.childForFieldName('source');
			if (source) {
				const target = source.text.replace(/['"]/g, '');
				if (target) {
					addEdge(ctx, 'IMPORTS_FROM', ctx.fileQualified, target, child.startPosition.row + 1);
				}
			}
			extractFromTree(child, ctx, language, enclosingClass, depth + 1);
			continue;
		}

		if (classTypes.has(t)) {
			handleClass(child, ctx, language, 'Class', enclosingClass, depth);
			continue;
		}

		if (typeTypes.has(t)) {
			handleClass(child, ctx, language, 'Type', enclosingClass, depth);
			continue;
		}

		if (funcTypes.has(t)) {
			handleFunction(child, ctx, language, enclosingClass, depth);
			continue;
		}

		if (importTypes.has(t)) {
			if (language === 'ruby' && t === 'call') {
				if (isRubyRequire(child)) {
					handleImport(child, ctx, language);
					continue;
				}
			} else if (language === 'java' && t === 'import_declaration') {
				handleJavaImport(child, ctx);
				continue;
			} else {
				handleImport(child, ctx, language);
				continue;
			}
		}

		if (language === 'python' && t === 'decorated_definition') {
			extractFromTree(child, ctx, language, enclosingClass, depth + 1);
			continue;
		}

		extractFromTree(child, ctx, language, enclosingClass, depth + 1);
	}
}

function isRubyRequire(node: TreeNode): boolean {
	const method = node.childForFieldName('method');
	return method !== null && (method.text === 'require' || method.text === 'require_relative');
}

const BASH_SOURCE_COMMANDS = new Set(['source', '.']);

function handleBashSourceImport(commandNode: TreeNode, ctx: ExtractionContext): void {
	const namedChildren = commandNode.namedChildren;
	if (namedChildren.length === 0) return;

	const head = namedChildren[0]!;
	const headText = head.text.trim();
	if (!BASH_SOURCE_COMMANDS.has(headText)) return;

	const argNode = namedChildren[1];
	if (!argNode) return;

	const rawArg = argNode.text.replace(/^['"`]|['"`]$/g, '').trim();
	if (!rawArg) return;

	addEdge(ctx, 'IMPORTS_FROM', ctx.fileQualified, rawArg, commandNode.startPosition.row + 1);
}

function handleJsDynamicImport(
	callNode: TreeNode,
	ctx: ExtractionContext,
): void {
	const funcNode = callNode.childForFieldName('function');
	if (!funcNode || funcNode.type !== 'import') return;

	const argsNode = callNode.childForFieldName('arguments');
	if (!argsNode) return;

	for (const arg of argsNode.namedChildren) {
		if (arg.type !== 'string' && arg.type !== 'string_literal') continue;
		const target = arg.text.replace(/^['"`]|['"`]$/g, '');
		if (!target) continue;
		addEdge(ctx, 'IMPORTS_FROM', ctx.fileQualified, target, callNode.startPosition.row + 1);
	}
}

function emitContainsEdge(ctx: ExtractionContext, qualified: string, enclosingClass: string | undefined, line: number): void {
	if (enclosingClass) {
		const parentQ = qualifyName(enclosingClass, ctx.filePath);
		addEdge(ctx, 'CONTAINS', parentQ, qualified, line);
	} else if (ctx.seenQualified.has(ctx.fileQualified)) {
		addEdge(ctx, 'CONTAINS', ctx.fileQualified, qualified, line);
	}
}

function handleClass(
	node: TreeNode,
	ctx: ExtractionContext,
	language: string,
	kind: NodeKind,
	enclosingClass: string | undefined,
	depth: number,
): void {
	const name = getName(node, language);
	if (!name) return;

	const lineStart = node.startPosition.row + 1;
	const lineEnd = node.endPosition.row + 1;
	const modifiers = getModifiers(node);

	const qualified = addNode(ctx, kind, name, lineStart, lineEnd, {
		language,
		...(enclosingClass ? { parentName: enclosingClass } : {}),
		...(modifiers ? { modifiers } : {}),
	});

	emitContainsEdge(ctx, qualified, enclosingClass, lineStart);

	const bases = getBases(node, language);
	for (const base of bases) {
		const edgeKind = kind === 'Type' ? 'IMPLEMENTS' : 'INHERITS';
		addEdge(ctx, edgeKind, qualified, base, lineStart);
	}

	const childEnclosing = enclosingClass ? `${enclosingClass}::${name}` : name;
	const body = getBody(node);
	if (body) {
		extractFromTree(body, ctx, language, childEnclosing, depth + 1);
	} else {
		extractFromTree(node, ctx, language, childEnclosing, depth + 1);
	}
}

function combineModifiers(modifiers: string | null, annotations?: string[]): string | null {
	if (!annotations || annotations.length === 0) return modifiers;
	const attrText = annotations.map(a => `#[${a}]`).join(' ');
	return modifiers ? `${modifiers} ${attrText}` : attrText;
}

function handleFunction(
	node: TreeNode,
	ctx: ExtractionContext,
	language: string,
	enclosingClass: string | undefined,
	_depth: number,
): void {
	const name = getName(node, language);
	if (!name) return;

	let effectiveEnclosingClass = enclosingClass;
	if (language === 'go' && node.type === 'method_declaration') {
		const receiverType = getGoReceiverType(node);
		if (receiverType) effectiveEnclosingClass = receiverType;
	}

	const lineStart = node.startPosition.row + 1;
	const lineEnd = node.endPosition.row + 1;
	const params = getParams(node);
	const returnType = getReturnType(node, language);
	const annotations = language === 'rust' ? getRustAttributes(node) : undefined;
	const modifiers = combineModifiers(getModifiers(node), annotations);
	const isTest = isTestFunction(name, ctx.filePath, annotations);
	const kind: NodeKind = isTest ? 'Test' : 'Function';
	const signature = buildSignature(name, params, returnType);

	const qualified = addNode(ctx, kind, name, lineStart, lineEnd, {
		language,
		...(effectiveEnclosingClass ? { parentName: effectiveEnclosingClass } : {}),
		...(params ? { params } : {}),
		...(returnType ? { returnType } : {}),
		...(modifiers ? { modifiers } : {}),
		...(signature ? { signature } : {}),
		isTest,
	});

	emitContainsEdge(ctx, qualified, effectiveEnclosingClass, lineStart);

	const body = getBody(node);
	if (body) {
		ctx.functionBodies.push({ callerQualified: qualified, bodyNode: body, lineOffset: ctx.lineOffset });
	}
}

function handleImport(
	node: TreeNode,
	ctx: ExtractionContext,
	language: string,
): void {
	const target = getImportTarget(node, language);
	if (!target) return;

	const lineStart = node.startPosition.row + 1;
	if (Array.isArray(target)) {
		for (const t of target) {
			addEdge(ctx, 'IMPORTS_FROM', ctx.fileQualified, t, lineStart);
		}
	} else {
		addEdge(ctx, 'IMPORTS_FROM', ctx.fileQualified, target, lineStart);
	}
}

function handleJavaImport(node: TreeNode, ctx: ExtractionContext): void {
	if (hasJavaWildcardChild(node)) return;

	const scopedNode = findJavaScopedIdentifier(node);
	if (!scopedNode) return;

	const isStatic = hasJavaStaticModifier(node);
	const fullSpec = scopedNode.text;
	if (!fullSpec) return;

	const resolved = isStatic ? stripJavaStaticMember(fullSpec) : fullSpec;
	if (!resolved) return;

	addEdge(ctx, 'IMPORTS_FROM', ctx.fileQualified, resolved, node.startPosition.row + 1);
}

function hasJavaWildcardChild(node: TreeNode): boolean {
	for (const child of node.children) {
		if (child.type === 'asterisk') return true;
	}
	return false;
}

function hasJavaStaticModifier(node: TreeNode): boolean {
	for (const child of node.children) {
		if (child.type === 'static') return true;
	}
	return false;
}

function findJavaScopedIdentifier(node: TreeNode): TreeNode | null {
	for (const child of node.namedChildren) {
		if (child.type === 'scoped_identifier' || child.type === 'identifier') return child;
	}
	return null;
}

function stripJavaStaticMember(spec: string): string | null {
	const lastDot = spec.lastIndexOf('.');
	if (lastDot <= 0) return null;
	return spec.slice(0, lastDot);
}

function handleJsVarFunction(
	node: TreeNode,
	ctx: ExtractionContext,
	language: string,
	enclosingClass: string | undefined,
	depth: number,
): boolean {
	let handled = false;

	for (const child of node.namedChildren) {
		if (child.type !== 'variable_declarator') continue;

		const nameNode = child.childForFieldName('name');
		const valueNode = child.childForFieldName('value');
		if (!nameNode || !valueNode) continue;

		if (valueNode.type !== 'arrow_function' && valueNode.type !== 'function_expression'
			&& valueNode.type !== 'function') continue;

		const name = nameNode.text;
		const lineStart = node.startPosition.row + 1;
		const lineEnd = node.endPosition.row + 1;
		const params = getParams(valueNode);
		const returnType = getReturnType(valueNode, language);
		const isTest = isTestFunction(name, ctx.filePath);
		const kind: NodeKind = isTest ? 'Test' : 'Function';
		const signature = buildSignature(name, params, returnType);

		const qualified = addNode(ctx, kind, name, lineStart, lineEnd, {
			language,
			...(enclosingClass ? { parentName: enclosingClass } : {}),
			...(params ? { params } : {}),
			...(returnType ? { returnType } : {}),
			...(signature ? { signature } : {}),
			isTest,
		});

		emitContainsEdge(ctx, qualified, enclosingClass, lineStart);

		const body = getBody(valueNode);
		if (body) {
			markArrowWrapperRegistered(ctx, valueNode);
			ctx.functionBodies.push({ callerQualified: qualified, bodyNode: body, lineOffset: ctx.lineOffset });
		}

		handled = true;
	}

	if (!handled) {
		extractFromTree(node, ctx, language, enclosingClass, depth + 1);
	}

	return handled;
}

function handleJsFieldFunction(
	node: TreeNode,
	ctx: ExtractionContext,
	language: string,
	enclosingClass: string,
	depth: number,
): boolean {
	const nameNode = node.childForFieldName('name') ?? node.childForFieldName('property');
	const valueNode = node.childForFieldName('value');
	if (!nameNode || !valueNode) return false;

	if (valueNode.type !== 'arrow_function' && valueNode.type !== 'function_expression') return false;

	const name = nameNode.text;
	const lineStart = node.startPosition.row + 1;
	const lineEnd = node.endPosition.row + 1;
	const params = getParams(valueNode);
	const returnType = getReturnType(valueNode, language);
	const signature = buildSignature(name, params, returnType);

	const qualified = addNode(ctx, 'Function', name, lineStart, lineEnd, {
		language,
		parentName: enclosingClass,
		...(params ? { params } : {}),
		...(returnType ? { returnType } : {}),
		...(signature ? { signature } : {}),
	});

	addEdge(ctx, 'CONTAINS', qualifyName(enclosingClass, ctx.filePath), qualified, lineStart);

	const body = getBody(valueNode);
	if (body) {
		markArrowWrapperRegistered(ctx, valueNode);
		ctx.functionBodies.push({ callerQualified: qualified, bodyNode: body, lineOffset: ctx.lineOffset });
	} else {
		extractFromTree(valueNode, ctx, language, enclosingClass, depth + 1);
	}

	return true;
}

type CjsTarget = { kind: 'exports' } | { kind: 'named'; name: string };

function parseCjsTarget(left: TreeNode): CjsTarget | null {
	if (left.type !== 'member_expression') return null;

	const obj = left.childForFieldName('object');
	const prop = left.childForFieldName('property');
	if (!obj || !prop) return null;

	if (obj.type === 'identifier' && obj.text === 'module' && prop.text === 'exports') {
		return { kind: 'exports' };
	}

	if (obj.type === 'identifier' && obj.text === 'exports') {
		return { kind: 'named', name: prop.text };
	}

	if (obj.type === 'member_expression') {
		const innerObj = obj.childForFieldName('object');
		const innerProp = obj.childForFieldName('property');
		if (innerObj?.type === 'identifier' && innerObj.text === 'module' && innerProp?.text === 'exports') {
			return { kind: 'named', name: prop.text };
		}
	}

	return null;
}

function cjsPropertyKey(keyNode: TreeNode): string | null {
	if (keyNode.type === 'property_identifier' || keyNode.type === 'identifier') {
		return keyNode.text;
	}
	if (keyNode.type === 'string' || keyNode.type === 'string_literal') {
		return keyNode.text.replace(/^['"`]|['"`]$/g, '');
	}
	return null;
}

function handleJsCjsExport(
	stmtNode: TreeNode,
	ctx: ExtractionContext,
	language: string,
	enclosingClass: string | undefined,
	depth: number,
): boolean {
	let assignment: TreeNode | null = null;
	for (const c of stmtNode.namedChildren) {
		if (c.type === 'assignment_expression') {
			assignment = c;
			break;
		}
	}
	if (!assignment) return false;

	const left = assignment.childForFieldName('left');
	const right = assignment.childForFieldName('right');
	if (!left || !right) return false;

	const target = parseCjsTarget(left);
	if (!target) return false;

	const line = stmtNode.startPosition.row + 1;

	if (target.kind === 'exports') {
		if (right.type !== 'object') return false;
		extractCjsObjectMembers(right, ctx, language, enclosingClass, depth);
		return true;
	}

	registerCjsMember(target.name, right, line, ctx, language, enclosingClass, depth);
	return true;
}

function extractCjsObjectMembers(
	objNode: TreeNode,
	ctx: ExtractionContext,
	language: string,
	enclosingClass: string | undefined,
	depth: number,
): void {
	for (const pair of objNode.namedChildren) {
		if (pair.type !== 'pair') continue;

		const keyNode = pair.childForFieldName('key');
		const valueNode = pair.childForFieldName('value');
		if (!keyNode || !valueNode) continue;

		const name = cjsPropertyKey(keyNode);
		if (!name) continue;

		registerCjsMember(name, valueNode, pair.startPosition.row + 1, ctx, language, enclosingClass, depth);
	}
}

function registerCjsMember(
	name: string,
	valueNode: TreeNode,
	line: number,
	ctx: ExtractionContext,
	language: string,
	enclosingClass: string | undefined,
	depth: number,
): void {
	const vt = valueNode.type;

	if (vt === 'arrow_function' || vt === 'function_expression' || vt === 'function') {
		const lineEnd = valueNode.endPosition.row + 1;
		const params = getParams(valueNode);
		const returnType = getReturnType(valueNode, language);
		const isTest = isTestFunction(name, ctx.filePath);
		const kind: NodeKind = isTest ? 'Test' : 'Function';
		const signature = buildSignature(name, params, returnType);

		const qualified = addNode(ctx, kind, name, line, lineEnd, {
			language,
			...(enclosingClass ? { parentName: enclosingClass } : {}),
			...(params ? { params } : {}),
			...(returnType ? { returnType } : {}),
			...(signature ? { signature } : {}),
			isTest,
		});

		emitContainsEdge(ctx, qualified, enclosingClass, line);

		const body = getBody(valueNode);
		if (body) {
			markArrowWrapperRegistered(ctx, valueNode);
			ctx.functionBodies.push({ callerQualified: qualified, bodyNode: body, lineOffset: ctx.lineOffset });
		}
		return;
	}

	if (vt === 'class' || vt === 'class_declaration') {
		const lineEnd = valueNode.endPosition.row + 1;
		const modifiers = getModifiers(valueNode);

		const qualified = addNode(ctx, 'Class', name, line, lineEnd, {
			language,
			...(enclosingClass ? { parentName: enclosingClass } : {}),
			...(modifiers ? { modifiers } : {}),
		});

		emitContainsEdge(ctx, qualified, enclosingClass, line);

		for (const base of getBases(valueNode, language)) {
			addEdge(ctx, 'INHERITS', qualified, base, line);
		}

		const childEnclosing = enclosingClass ? `${enclosingClass}::${name}` : name;
		const body = getBody(valueNode);
		if (body) {
			extractFromTree(body, ctx, language, childEnclosing, depth + 1);
		} else {
			extractFromTree(valueNode, ctx, language, childEnclosing, depth + 1);
		}
		return;
	}

	if (vt === 'object') {
		const lineEnd = valueNode.endPosition.row + 1;
		const qualified = addNode(ctx, 'Type', name, line, lineEnd, {
			language,
			...(enclosingClass ? { parentName: enclosingClass } : {}),
		});

		emitContainsEdge(ctx, qualified, enclosingClass, line);

		const childEnclosing = enclosingClass ? `${enclosingClass}::${name}` : name;
		extractCjsObjectMembers(valueNode, ctx, language, childEnclosing, depth + 1);
	}
}
