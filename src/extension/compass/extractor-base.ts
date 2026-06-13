import type { NodeInfo, EdgeInfo, NodeKind, EdgeKind, ExtractionContext } from './types';
import { qualifyName } from './schema';

export function createExtractionContext(
	filePath: string,
	source: string,
	workspaceRoot: string,
	language: string,
): ExtractionContext {
	const parts = filePath.replace(/\\/g, '/').split('/');
	const filename = parts[parts.length - 1] ?? '';
	const stem = filename.replace(/\.[^.]+$/, '');

	return {
		filePath,
		stem,
		fileQualified: qualifyName(filename, filePath),
		workspaceRoot,
		source,
		language,
		lineOffset: 0,
		nodes: [],
		edges: [],
		seenQualified: new Set(),
		functionBodies: [],
		typeScopes: [],
		registeredArrowWrappers: new Set(),
	};
}

function wrapperKey(node: { startIndex: number; endIndex: number }): string {
	return `${node.startIndex}:${node.endIndex}`;
}

export function markArrowWrapperRegistered(
	ctx: ExtractionContext,
	node: { startIndex: number; endIndex: number },
): void {
	ctx.registeredArrowWrappers.add(wrapperKey(node));
}

const CALLABLE_KINDS: ReadonlySet<NodeKind> = new Set(['Function', 'Class', 'Type', 'Test']);

export function markFileNodeIfNoCallables(ctx: ExtractionContext): void {
	const fileNode = ctx.nodes.find(n => n.kind === 'File');
	if (!fileNode) return;
	const hasCallables = ctx.nodes.some(n => CALLABLE_KINDS.has(n.kind));
	if (hasCallables) return;
	fileNode.extra = { ...(fileNode.extra ?? {}), no_callable_entities: true };
}

export function addNode(
	ctx: ExtractionContext,
	kind: NodeKind,
	name: string,
	lineStart: number,
	lineEnd: number,
	options?: {
		language?: string;
		parentName?: string;
		params?: string;
		returnType?: string;
		modifiers?: string;
		signature?: string;
		isTest?: boolean;
		extra?: Record<string, unknown>;
	},
): string {
	const qualified = qualifyName(name, ctx.filePath, options?.parentName);
	if (ctx.seenQualified.has(qualified)) return qualified;
	ctx.seenQualified.add(qualified);

	const adjustedStart = lineStart + ctx.lineOffset;
	const adjustedEnd = lineEnd + ctx.lineOffset;

	const node: NodeInfo = {
		kind,
		name,
		file_path: ctx.filePath,
		line_start: adjustedStart,
		line_end: adjustedEnd,
	};
	if (options?.language !== undefined) node.language = options.language;
	if (options?.parentName !== undefined) node.parent_name = options.parentName;
	if (options?.params !== undefined) node.params = options.params;
	if (options?.returnType !== undefined) node.return_type = options.returnType;
	if (options?.modifiers !== undefined) node.modifiers = options.modifiers;
	if (options?.signature !== undefined) node.signature = options.signature;
	if (options?.isTest !== undefined) node.is_test = options.isTest;
	if (options?.extra !== undefined) node.extra = options.extra;
	ctx.nodes.push(node);

	return qualified;
}

export function addEdge(
	ctx: ExtractionContext,
	kind: EdgeKind,
	source: string,
	target: string,
	line: number,
	extra?: Record<string, unknown>,
): void {
	const edge: EdgeInfo = {
		kind,
		source,
		target,
		file_path: ctx.filePath,
		line: line + ctx.lineOffset,
	};
	if (extra !== undefined) edge.extra = extra;
	ctx.edges.push(edge);
}

export function nodeText(source: string, node: { startIndex: number; endIndex: number }): string {
	return source.slice(node.startIndex, node.endIndex);
}

const CALL_BOUNDARY_TYPES = new Set([
	'function_definition', 'function_declaration', 'method_definition', 'function_item',
	'method_declaration', 'constructor_declaration', 'singleton_method',
	'class_declaration', 'class_definition', 'class', 'struct_item', 'impl_item',
	'interface_declaration', 'abstract_class_declaration', 'enum_declaration',
	'type_declaration', 'trait_item', 'module', 'object_declaration',
]);

const CONDITIONAL_BOUNDARY_TYPES = new Set(['arrow_function', 'function_expression']);

function isBoundary(
	ctx: ExtractionContext,
	node: { type: string; startIndex: number; endIndex: number },
): boolean {
	if (CALL_BOUNDARY_TYPES.has(node.type)) return true;
	if (CONDITIONAL_BOUNDARY_TYPES.has(node.type)) {
		return ctx.registeredArrowWrappers.has(wrapperKey(node));
	}
	return false;
}

const CALL_NODE_TYPES = new Set([
	'call', 'call_expression',
	'method_invocation', 'invocation_expression',
	'member_call_expression', 'scoped_call_expression', 'nullsafe_member_call_expression',
	'function_call_expression',
	'macro_invocation',
	'object_creation_expression', 'new_expression', 'instance_expression',
	'navigation_expression',
]);

const BASH_CALL_NODE_TYPE = 'command';
const BASH_IMPORT_COMMANDS = new Set(['source', '.']);

const BASH_BUILTIN_COMMANDS = new Set([
	':', '[', '[[', 'alias', 'bg', 'break', 'builtin', 'caller', 'case', 'cd',
	'command', 'compgen', 'complete', 'continue', 'declare', 'dirs', 'disown',
	'echo', 'enable', 'eval', 'exec', 'exit', 'export', 'false', 'fc', 'fg',
	'getopts', 'hash', 'help', 'history', 'jobs', 'kill', 'let', 'local',
	'logout', 'mapfile', 'popd', 'printf', 'pushd', 'pwd', 'read', 'readarray',
	'readonly', 'return', 'select', 'set', 'shift', 'shopt', 'suspend', 'test',
	'times', 'trap', 'true', 'type', 'typeset', 'ulimit', 'umask', 'unalias',
	'unset', 'wait',
	'awk', 'basename', 'cat', 'chmod', 'chown', 'cp', 'cut', 'date', 'dirname',
	'du', 'env', 'find', 'grep', 'head', 'ls', 'mkdir', 'mv', 'rm', 'rmdir',
	'sed', 'sort', 'tail', 'tar', 'tee', 'touch', 'tr', 'uniq', 'wc', 'which',
	'xargs',
]);

function isBashCallNode(node: { type: string }, language: string): boolean {
	return language === 'bash' && node.type === BASH_CALL_NODE_TYPE;
}

function normalizePhpCallTarget(raw: string, language: string): string {
	return language === 'php' && raw.startsWith('\\') ? raw.slice(1) : raw;
}

function bashCommandName(
	node: { childForFieldName(name: string): unknown | null },
	source: string,
): string | null {
	const nameNode = node.childForFieldName('name') as { startIndex: number; endIndex: number } | null;
	if (!nameNode) return null;
	const raw = nodeText(source, nameNode).trim();
	if (raw.length === 0) return null;
	if (BASH_IMPORT_COMMANDS.has(raw)) return null;
	if (BASH_BUILTIN_COMMANDS.has(raw)) return null;
	return raw;
}

const REFERENCE_SKIP_NAMES = new Set([
	'true', 'false', 'null', 'undefined', 'this', 'self',
	'NaN', 'Infinity', 'arguments', 'super', 'console', 'window', 'document',
	'process', 'module', 'exports', 'require', 'require_relative', 'global',
]);

function isValidCrossFileName(name: string): boolean {
	if (name.length <= 1) return false;
	if (/^[A-Z_][A-Z0-9_]*$/.test(name)) return false;
	if (REFERENCE_SKIP_NAMES.has(name)) return false;
	return true;
}

interface AstNode {
	type: string;
	startIndex: number;
	endIndex: number;
	startPosition: { row: number };
	children?: AstNode[];
	namedChildren?: AstNode[];
	childForFieldName(name: string): AstNode | null;
}

interface CallTarget {
	callee: string | null;
	receiver: string | null;
}

const NO_TARGET: CallTarget = { callee: null, receiver: null };

const MEMBER_FUNCTION_TYPES = new Set([
	'attribute', 'member_expression', 'field_expression', 'member_access_expression', 'selector_expression',
]);

const RECEIVER_HEURISTIC_LANGUAGES = new Set([
	'javascript', 'typescript', 'tsx', 'vue', 'python', 'java', 'csharp', 'scala', 'go', 'kotlin',
]);

const RECEIVER_FIELD_NAMES = ['object', 'expression', 'value', 'operand'];

function lastNamespaceSegment(raw: string): string {
	const idx = raw.lastIndexOf('\\');
	return idx === -1 ? raw : raw.slice(idx + 1);
}

function heuristicReceiver(node: AstNode, language: string, source: string): string | null {
	if (!RECEIVER_HEURISTIC_LANGUAGES.has(language)) return null;
	for (const field of RECEIVER_FIELD_NAMES) {
		const receiverNode = node.childForFieldName(field);
		if (!receiverNode) continue;
		if (receiverNode.type !== 'identifier' && receiverNode.type !== 'simple_identifier') return null;
		const name = nodeText(source, receiverNode);
		return /^[A-Z]/.test(name) ? name : null;
	}
	return null;
}

function memberFunctionTarget(funcNode: AstNode, language: string, source: string): CallTarget {
	const memberNode = funcNode.childForFieldName('attribute')
		?? funcNode.childForFieldName('property')
		?? funcNode.childForFieldName('field')
		?? funcNode.childForFieldName('name');
	return {
		callee: memberNode ? nodeText(source, memberNode) : null,
		receiver: heuristicReceiver(funcNode, language, source),
	};
}

function phpScopedCallTarget(node: AstNode, source: string): CallTarget {
	const methodNode = node.childForFieldName('name');
	if (!methodNode) return NO_TARGET;
	const method = nodeText(source, methodNode);
	const scopeNode = node.childForFieldName('scope');
	if (!scopeNode || scopeNode.type === 'relative_scope') return { callee: method, receiver: null };
	if (scopeNode.type === 'name' || scopeNode.type === 'qualified_name') {
		const scope = lastNamespaceSegment(nodeText(source, scopeNode));
		return { callee: `${scope}::${method}`, receiver: scope };
	}
	return { callee: method, receiver: null };
}

function constructedTypeName(typeNode: AstNode, source: string): string | null {
	if (typeNode.type === 'type_identifier' || typeNode.type === 'identifier') {
		return nodeText(source, typeNode);
	}
	if (typeNode.type === 'generic_type' || typeNode.type === 'generic_name') {
		const inner = (typeNode.namedChildren ?? []).find(
			c => c.type === 'type_identifier' || c.type === 'identifier',
		);
		return inner ? nodeText(source, inner) : null;
	}
	if (typeNode.type === 'qualified_name' || typeNode.type === 'scoped_type_identifier') {
		const children = typeNode.namedChildren ?? [];
		for (let i = children.length - 1; i >= 0; i--) {
			const child = children[i]!;
			if (child.type === 'type_identifier' || child.type === 'identifier') {
				return nodeText(source, child);
			}
		}
	}
	return null;
}

function objectCreationTarget(node: AstNode, source: string): CallTarget {
	const typeNode = node.childForFieldName('type');
	if (typeNode) return { callee: constructedTypeName(typeNode, source), receiver: null };
	for (const child of node.namedChildren ?? []) {
		if (child.type === 'variable_name') return NO_TARGET;
		if (child.type === 'name') return { callee: nodeText(source, child), receiver: null };
		if (child.type === 'qualified_name') {
			return { callee: lastNamespaceSegment(nodeText(source, child)), receiver: null };
		}
	}
	return NO_TARGET;
}

function innermostQualifiedPair(qualifiedNode: AstNode): { scopeNode: AstNode | null; nameNode: AstNode | null } {
	let current = qualifiedNode;
	let nameNode = current.childForFieldName('name');
	while (nameNode && nameNode.type === 'qualified_identifier') {
		current = nameNode;
		nameNode = current.childForFieldName('name');
	}
	return { scopeNode: current.childForFieldName('scope'), nameNode };
}

function cppQualifiedCallTarget(funcNode: AstNode, source: string): CallTarget {
	const { scopeNode, nameNode } = innermostQualifiedPair(funcNode);
	if (!nameNode) return NO_TARGET;
	const method = nodeText(source, nameNode);
	if (!scopeNode) return { callee: method, receiver: null };
	const scope = nodeText(source, scopeNode);
	return { callee: `${scope}::${method}`, receiver: scope };
}

function newExpressionTarget(node: AstNode, language: string, source: string): CallTarget {
	const ctorNode = node.childForFieldName('constructor');
	if (ctorNode) {
		if (ctorNode.type === 'identifier') return { callee: nodeText(source, ctorNode), receiver: null };
		if (ctorNode.type === 'member_expression') {
			const propNode = ctorNode.childForFieldName('property');
			return {
				callee: propNode ? nodeText(source, propNode) : null,
				receiver: heuristicReceiver(ctorNode, language, source),
			};
		}
		return NO_TARGET;
	}
	const typeNode = node.childForFieldName('type');
	if (!typeNode) return NO_TARGET;
	if (typeNode.type === 'type_identifier') return { callee: nodeText(source, typeNode), receiver: null };
	if (typeNode.type === 'qualified_identifier') {
		const { scopeNode, nameNode } = innermostQualifiedPair(typeNode);
		return {
			callee: nameNode ? nodeText(source, nameNode) : null,
			receiver: scopeNode ? nodeText(source, scopeNode) : null,
		};
	}
	return NO_TARGET;
}

function instanceExpressionTarget(node: AstNode, source: string): CallTarget {
	const first = (node.namedChildren ?? [])[0];
	if (first && first.type === 'identifier') return { callee: nodeText(source, first), receiver: null };
	return NO_TARGET;
}

function rubyCallTarget(node: AstNode, source: string): CallTarget {
	const methodNode = node.childForFieldName('method');
	if (!methodNode) return NO_TARGET;
	const method = nodeText(source, methodNode);
	const receiverNode = node.childForFieldName('receiver');
	if (!receiverNode) return { callee: method, receiver: null };
	if (receiverNode.type === 'constant') {
		const className = nodeText(source, receiverNode);
		return { callee: method === 'new' ? className : method, receiver: className };
	}
	if (receiverNode.type === 'scope_resolution') {
		const nameNode = receiverNode.childForFieldName('name');
		if (!nameNode) return { callee: method === 'new' ? null : method, receiver: null };
		const className = nodeText(source, nameNode);
		return { callee: method === 'new' ? className : `${className}::${method}`, receiver: className };
	}
	return { callee: method === 'new' ? null : method, receiver: null };
}

function rustPathLeafName(pathNode: AstNode, source: string): string | null {
	if (pathNode.type === 'identifier' || pathNode.type === 'type_identifier') {
		return nodeText(source, pathNode);
	}
	if (pathNode.type === 'scoped_identifier' || pathNode.type === 'scoped_type_identifier') {
		const nameNode = pathNode.childForFieldName('name');
		return nameNode ? nodeText(source, nameNode) : null;
	}
	return null;
}

const RUST_RELATIVE_SCOPES = new Set(['self', 'Self', 'super', 'crate']);

function rustScopedCallTarget(funcNode: AstNode, source: string): CallTarget {
	const nameNode = funcNode.childForFieldName('name');
	if (!nameNode) return NO_TARGET;
	const method = nodeText(source, nameNode);
	const pathNode = funcNode.childForFieldName('path');
	const scope = pathNode ? rustPathLeafName(pathNode, source) : null;
	if (!scope || RUST_RELATIVE_SCOPES.has(scope)) return { callee: method, receiver: null };
	return { callee: `${scope}::${method}`, receiver: scope };
}

function kotlinCallTarget(node: AstNode, source: string): CallTarget {
	const first = (node.namedChildren ?? [])[0];
	if (!first) return NO_TARGET;
	if (first.type === 'simple_identifier') return { callee: nodeText(source, first), receiver: null };
	if (first.type !== 'navigation_expression') return NO_TARGET;
	const navChildren = first.namedChildren ?? [];
	const suffix = navChildren[navChildren.length - 1];
	if (!suffix || suffix.type !== 'navigation_suffix') return NO_TARGET;
	const memberNode = (suffix.namedChildren ?? []).find(c => c.type === 'simple_identifier');
	const callee = memberNode ? nodeText(source, memberNode) : null;
	const receiverNode = navChildren[0];
	let receiver: string | null = null;
	if (receiverNode && receiverNode.type === 'simple_identifier') {
		const name = nodeText(source, receiverNode);
		if (/^[A-Z]/.test(name)) receiver = name;
	}
	return { callee, receiver };
}

function extractCallTarget(node: AstNode, language: string, source: string): CallTarget {
	if (node.type === 'scoped_call_expression') return phpScopedCallTarget(node, source);
	if (node.type === 'object_creation_expression') return objectCreationTarget(node, source);
	if (node.type === 'new_expression') return newExpressionTarget(node, language, source);
	if (node.type === 'instance_expression') return instanceExpressionTarget(node, source);
	if (node.type === 'call' && language === 'ruby') return rubyCallTarget(node, source);

	const nameNode = node.childForFieldName('name');
	if (nameNode && (nameNode.type === 'identifier' || nameNode.type === 'simple_identifier')) {
		return { callee: nodeText(source, nameNode), receiver: heuristicReceiver(node, language, source) };
	}
	if (language === 'php' && nameNode && nameNode.type === 'name') {
		return { callee: nodeText(source, nameNode), receiver: null };
	}

	const funcNode = node.childForFieldName('function');
	if (funcNode) {
		if (funcNode.type === 'identifier') return { callee: nodeText(source, funcNode), receiver: null };
		if (language === 'php' && (funcNode.type === 'name' || funcNode.type === 'qualified_name')) {
			return { callee: nodeText(source, funcNode), receiver: null };
		}
		if (MEMBER_FUNCTION_TYPES.has(funcNode.type)) return memberFunctionTarget(funcNode, language, source);
		if (funcNode.type === 'scoped_identifier') return rustScopedCallTarget(funcNode, source);
		if (funcNode.type === 'qualified_identifier') return cppQualifiedCallTarget(funcNode, source);
		return NO_TARGET;
	}

	if (node.type === 'call_expression') return kotlinCallTarget(node, source);

	return NO_TARGET;
}

const PRIMITIVE_TYPE_NODES = new Set([
	'primitive_type', 'predefined_type',
	'integral_type', 'floating_point_type', 'boolean_type', 'void_type',
]);

const TYPE_LEAF_NODES = new Set([
	'type_identifier', 'identifier', 'simple_identifier', 'name', 'field_identifier',
]);

const TYPE_WRAPPER_FIELDS = ['type', 'element', 'inner'];

const TYPE_GENERIC_NODES = new Set(['generic_type', 'generic_name']);

const TYPE_QUALIFIED_NODES = new Set([
	'qualified_name', 'qualified_type', 'qualified_identifier',
	'scoped_type_identifier', 'nested_type_identifier', 'user_type',
]);

const TYPE_ARGUMENT_NODES = new Set(['type_arguments', 'type_argument_list']);

function genericBaseNode(node: AstNode): AstNode | null {
	const named = node.namedChildren ?? [];
	const fieldNamed = node.childForFieldName('name');
	if (fieldNamed) return fieldNamed;
	for (const child of named) {
		if (TYPE_LEAF_NODES.has(child.type) || TYPE_QUALIFIED_NODES.has(child.type)) return child;
	}
	return null;
}

function typeArgumentList(node: AstNode): AstNode | null {
	for (const child of node.namedChildren ?? []) {
		if (TYPE_ARGUMENT_NODES.has(child.type)) return child;
	}
	return null;
}

function leafTypeName(node: AstNode, source: string): string | null {
	if (TYPE_LEAF_NODES.has(node.type)) return nodeText(source, node);
	if (TYPE_GENERIC_NODES.has(node.type)) {
		const base = genericBaseNode(node);
		return base ? leafTypeName(base, source) : null;
	}
	if (TYPE_QUALIFIED_NODES.has(node.type)) {
		const named = node.namedChildren ?? [];
		for (let i = named.length - 1; i >= 0; i--) {
			const leaf = leafTypeName(named[i]!, source);
			if (leaf) return leaf;
		}
	}
	return null;
}

function emitTypeReferences(
	ctx: ExtractionContext,
	typeNode: AstNode,
	callerQualified: string,
	nameToQualified: Map<string, string>,
	seenRefPairs: Set<string>,
	source: string,
	line: number,
): void {
	if (PRIMITIVE_TYPE_NODES.has(typeNode.type)) return;

	if (TYPE_LEAF_NODES.has(typeNode.type)) {
		emitReferenceIfKnown(ctx, lastNamespaceSegment(nodeText(source, typeNode)), callerQualified, nameToQualified, seenRefPairs, line);
		return;
	}

	for (const field of TYPE_WRAPPER_FIELDS) {
		const wrapped = typeNode.childForFieldName(field);
		if (wrapped) {
			emitTypeReferences(ctx, wrapped, callerQualified, nameToQualified, seenRefPairs, source, line);
			return;
		}
	}

	if (TYPE_GENERIC_NODES.has(typeNode.type)) {
		const base = genericBaseNode(typeNode);
		if (base) emitTypeReferences(ctx, base, callerQualified, nameToQualified, seenRefPairs, source, line);
		const args = typeArgumentList(typeNode);
		if (args) {
			for (const arg of args.namedChildren ?? []) {
				emitTypeReferences(ctx, arg, callerQualified, nameToQualified, seenRefPairs, source, line);
			}
		}
		return;
	}

	if (TYPE_QUALIFIED_NODES.has(typeNode.type)) {
		const named = typeNode.namedChildren ?? [];
		const last = named[named.length - 1];
		if (last && (TYPE_GENERIC_NODES.has(last.type) || TYPE_QUALIFIED_NODES.has(last.type))) {
			emitTypeReferences(ctx, last, callerQualified, nameToQualified, seenRefPairs, source, line);
		} else {
			const leaf = leafTypeName(typeNode, source);
			if (leaf) emitReferenceIfKnown(ctx, lastNamespaceSegment(leaf), callerQualified, nameToQualified, seenRefPairs, line);
		}
		return;
	}

	for (const child of typeNode.namedChildren ?? []) {
		if (TYPE_LEAF_NODES.has(child.type) || TYPE_GENERIC_NODES.has(child.type)
			|| TYPE_QUALIFIED_NODES.has(child.type)) {
			emitTypeReferences(ctx, child, callerQualified, nameToQualified, seenRefPairs, source, line);
		}
	}
}

const TYPE_ANNOTATION_NODES = new Set([
	'simple_parameter', 'property_promotion_parameter', 'property_declaration',
	'parameter', 'parameter_declaration', 'formal_parameter', 'typed_parameter',
	'field_declaration', 'variable_declaration', 'class_parameter',
	'required_parameter', 'optional_parameter', 'val_definition', 'var_definition',
]);

const PYTHON_RETURN_TYPE_NODE = 'type';

function handleTypeAnnotationNode(
	ctx: ExtractionContext,
	node: AstNode,
	callerQualified: string,
	nameToQualified: Map<string, string>,
	seenRefPairs: Set<string>,
	source: string,
): void {
	if (node.type === 'type_annotation') {
		for (const child of node.namedChildren ?? []) {
			emitTypeReferences(ctx, child, callerQualified, nameToQualified, seenRefPairs, source, node.startPosition.row + 1);
		}
		return;
	}

	if (node.type === 'user_type') {
		emitTypeReferences(ctx, node, callerQualified, nameToQualified, seenRefPairs, source, node.startPosition.row + 1);
		return;
	}

	if (TYPE_ANNOTATION_NODES.has(node.type)) {
		const typeNode = node.childForFieldName('type');
		if (typeNode) {
			emitTypeReferences(ctx, typeNode, callerQualified, nameToQualified, seenRefPairs, source, node.startPosition.row + 1);
		}
		return;
	}

	if (node.type === PYTHON_RETURN_TYPE_NODE && ctx.language === 'python') {
		emitTypeReferences(ctx, node, callerQualified, nameToQualified, seenRefPairs, source, node.startPosition.row + 1);
	}
}

export function walkReferences(
	ctx: ExtractionContext,
	node: AstNode,
	callerQualified: string,
	nameToQualified: Map<string, string>,
	seenRefPairs: Set<string>,
	source: string,
): void {
	if (isBoundary(ctx, node)) return;

	handleTypeAnnotationNode(ctx, node, callerQualified, nameToQualified, seenRefPairs, source);

	const children = node.children;

	if (CALL_NODE_TYPES.has(node.type)) {
		const { receiver } = extractCallTarget(node, ctx.language, source);
		if (receiver) {
			emitReferenceIfKnown(ctx, receiver, callerQualified, nameToQualified, seenRefPairs, node.startPosition.row + 1);
		}
	}

	if (ctx.language === 'php' && node.type === 'class_constant_access_expression') {
		const classNode = (node.namedChildren ?? [])[0];
		if (classNode && (classNode.type === 'name' || classNode.type === 'qualified_name')) {
			const name = lastNamespaceSegment(nodeText(source, classNode));
			emitReferenceIfKnown(ctx, name, callerQualified, nameToQualified, seenRefPairs, node.startPosition.row + 1);
		}
	}

	if (ctx.language === 'rust' && node.type === 'struct_expression') {
		const typeNode = node.childForFieldName('name');
		const name = typeNode ? rustPathLeafName(typeNode, source) : null;
		if (name) {
			emitReferenceIfKnown(ctx, name, callerQualified, nameToQualified, seenRefPairs, node.startPosition.row + 1);
		}
	}

	if (ctx.language === 'go' && node.type === 'composite_literal') {
		const typeNode = node.childForFieldName('type');
		let name: string | null = null;
		if (typeNode?.type === 'type_identifier') {
			name = nodeText(source, typeNode);
		} else if (typeNode?.type === 'qualified_type') {
			const inner = typeNode.childForFieldName('name');
			if (inner) name = nodeText(source, inner);
		}
		if (name) {
			emitReferenceIfKnown(ctx, name, callerQualified, nameToQualified, seenRefPairs, node.startPosition.row + 1);
		}
	}

	if (node.type === 'pair') {
		if (children && children.length > 0) {
			let valueNode: typeof node | null = null;
			for (let i = children.length - 1; i >= 0; i--) {
				const child = children[i]!;
				if (child.type !== ':' && child.type !== ',') { valueNode = child; break; }
			}
			if (valueNode && valueNode.type === 'identifier') {
				const name = nodeText(source, valueNode as unknown as { startIndex: number; endIndex: number });
				emitReferenceIfKnown(ctx, name, callerQualified, nameToQualified, seenRefPairs, node.startPosition.row + 1);
			}
		}
	}

	if (node.type === 'shorthand_property_identifier' || node.type === 'shorthand_property_identifier_pattern') {
		const name = nodeText(source, node as unknown as { startIndex: number; endIndex: number });
		emitReferenceIfKnown(ctx, name, callerQualified, nameToQualified, seenRefPairs, node.startPosition.row + 1);
	}

	if (node.type === 'array' || node.type === 'tuple') {
		if (children) {
			for (const child of children) {
				if (child.type === 'identifier') {
					const name = nodeText(source, child as unknown as { startIndex: number; endIndex: number });
					emitReferenceIfKnown(ctx, name, callerQualified, nameToQualified, seenRefPairs, child.startPosition.row + 1);
				}
			}
		}
	}

	if (node.type === 'arguments' || node.type === 'argument_list') {
		if (children) {
			for (const child of children) {
				if (child.type === 'identifier') {
					const name = nodeText(source, child as unknown as { startIndex: number; endIndex: number });
					emitReferenceIfKnown(ctx, name, callerQualified, nameToQualified, seenRefPairs, child.startPosition.row + 1);
				}
			}
		}
	}

	if (children) {
		for (const child of children) {
			walkReferences(ctx, child, callerQualified, nameToQualified, seenRefPairs, source);
		}
	}
}

function emitReferenceIfKnown(
	ctx: ExtractionContext,
	name: string,
	callerQualified: string,
	nameToQualified: Map<string, string>,
	seenRefPairs: Set<string>,
	line: number,
): void {
	if (!isValidCrossFileName(name)) return;

	const tgtQualified = nameToQualified.get(name.toLowerCase()) ?? name;
	if (tgtQualified === callerQualified) return;

	const pair = `${callerQualified}||${tgtQualified}`;
	if (seenRefPairs.has(pair)) return;
	seenRefPairs.add(pair);
	addEdge(ctx, 'REFERENCES', callerQualified, tgtQualified, line);
}

export function walkCalls(
	ctx: ExtractionContext,
	node: AstNode,
	callerQualified: string,
	nameToQualified: Map<string, string>,
	seenCallPairs: Set<string>,
	source: string,
): void {
	if (isBoundary(ctx, node)) {
		return;
	}

	const isLanguageScopedCall = isBashCallNode(node, ctx.language);

	if (CALL_NODE_TYPES.has(node.type) || isLanguageScopedCall) {
		if (node.childForFieldName('function')?.type === 'import') {
			const argChildren = node.childForFieldName('arguments')?.namedChildren ?? [];
			for (const arg of argChildren) {
				if (arg.type !== 'string' && arg.type !== 'string_literal') continue;
				const target = nodeText(source, arg).replace(/^['"`]|['"`]$/g, '');
				if (target) {
					addEdge(ctx, 'IMPORTS_FROM', ctx.fileQualified, target, node.startPosition.row + 1);
				}
			}
		}

		const calleeName = isLanguageScopedCall
			? bashCommandName(node, source)
			: extractCallTarget(node, ctx.language, source).callee;

		if (calleeName) {
			const normalized = normalizePhpCallTarget(calleeName, ctx.language);
			if (isValidCrossFileName(normalized)) {
				const tgtQualified = nameToQualified.get(normalized.toLowerCase()) ?? normalized;
				if (tgtQualified !== callerQualified) {
					const pair = `${callerQualified}||${tgtQualified}`;
					if (!seenCallPairs.has(pair)) {
						seenCallPairs.add(pair);
						addEdge(ctx, 'CALLS', callerQualified, tgtQualified, node.startPosition.row + 1);
					}
				}
			}
		}
	}

	if (node.type === 'jsx_opening_element' || node.type === 'jsx_self_closing_element') {
		const nameNode = node.childForFieldName('name');
		if (nameNode) {
			const tagName = nodeText(source, nameNode);
			if (tagName && /^[A-Z]/.test(tagName)) {
				const baseName = tagName.includes('.') ? tagName.split('.')[0]! : tagName;
				if (isValidCrossFileName(baseName)) {
					const tgtQualified = nameToQualified.get(baseName.toLowerCase()) ?? baseName;
					if (tgtQualified !== callerQualified) {
						const pair = `${callerQualified}||${tgtQualified}`;
						if (!seenCallPairs.has(pair)) {
							seenCallPairs.add(pair);
							addEdge(ctx, 'CALLS', callerQualified, tgtQualified, node.startPosition.row + 1);
						}
					}
				}
			}
		}
	}

	const children = node.children;
	if (children) {
		for (const child of children) {
			walkCalls(ctx, child, callerQualified, nameToQualified, seenCallPairs, source);
		}
	}
}

export function buildNameMap(nodes: NodeInfo[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const n of nodes) {
		const normalised = n.name.replace(/[()]/g, '').replace(/^\./, '').toLowerCase();
		const qualified = qualifyName(n.name, n.file_path, n.parent_name);
		map.set(normalised, qualified);
	}
	return map;
}

export interface ExtractionResult {
	nodes: NodeInfo[];
	edges: EdgeInfo[];
}

const EXTERNAL_TARGET_EDGE_KINDS: Set<string> = new Set([
	'IMPORTS_FROM', 'INHERITS', 'IMPLEMENTS', 'DEPENDS_ON', 'CALLS', 'REFERENCES',
]);

export function cleanEdges(ctx: ExtractionContext): ExtractionResult {
	const validSources = ctx.seenQualified;
	const cleanedEdges = ctx.edges.filter(edge => {
		if (!validSources.has(edge.source)) return false;
		if (EXTERNAL_TARGET_EDGE_KINDS.has(edge.kind)) return true;
		return validSources.has(edge.target);
	});

	return { nodes: ctx.nodes, edges: cleanedEdges };
}

function walkTypeReferences(
	ctx: ExtractionContext,
	node: AstNode,
	ownerQualified: string,
	nameToQualified: Map<string, string>,
	seenRefPairs: Set<string>,
	source: string,
): void {
	if (isBoundary(ctx, node)) return;

	handleTypeAnnotationNode(ctx, node, ownerQualified, nameToQualified, seenRefPairs, source);

	const children = node.children;
	if (children) {
		for (const child of children) {
			walkTypeReferences(ctx, child, ownerQualified, nameToQualified, seenRefPairs, source);
		}
	}
}

export function runCallGraphPass(ctx: ExtractionContext): void {
	const nameToQualified = buildNameMap(ctx.nodes);
	const seenCallPairs = new Set<string>();
	const seenRefPairs = new Set<string>();

	for (const { ownerQualified, scopeNode, scopeKind, lineOffset } of ctx.typeScopes) {
		const savedOffset = ctx.lineOffset;
		ctx.lineOffset = lineOffset;
		const typeNode = scopeNode as AstNode;
		if (scopeKind === 'type') {
			emitTypeReferences(ctx, typeNode, ownerQualified, nameToQualified, seenRefPairs, ctx.source, typeNode.startPosition.row + 1);
		} else {
			walkTypeReferences(ctx, typeNode, ownerQualified, nameToQualified, seenRefPairs, ctx.source);
		}
		ctx.lineOffset = savedOffset;
	}

	for (const { callerQualified, bodyNode, lineOffset } of ctx.functionBodies) {
		const savedOffset = ctx.lineOffset;
		ctx.lineOffset = lineOffset;
		walkCalls(
			ctx,
			bodyNode as Parameters<typeof walkCalls>[1],
			callerQualified,
			nameToQualified,
			seenCallPairs,
			ctx.source,
		);
		walkReferences(
			ctx,
			bodyNode as Parameters<typeof walkReferences>[1],
			callerQualified,
			nameToQualified,
			seenRefPairs,
			ctx.source,
		);
		ctx.lineOffset = savedOffset;
	}

	if (ctx.rootNode) {
		const rootChildren = (ctx.rootNode as { children?: Array<Parameters<typeof walkCalls>[1]> }).children ?? [];
		for (const child of rootChildren) {
			walkCalls(
				ctx,
				child,
				ctx.fileQualified,
				nameToQualified,
				seenCallPairs,
				ctx.source,
			);
			walkReferences(
				ctx,
				child as Parameters<typeof walkReferences>[1],
				ctx.fileQualified,
				nameToQualified,
				seenRefPairs,
				ctx.source,
			);
		}
	}
}
