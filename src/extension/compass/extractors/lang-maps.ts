export const JS_LANGUAGES: Set<string> = new Set(['javascript', 'typescript', 'tsx']);

export const CLASS_TYPES: Record<string, string[]> = {
	python: ['class_definition'],
	javascript: ['class_declaration', 'class'],
	typescript: ['class_declaration', 'class', 'abstract_class_declaration', 'enum_declaration'],
	tsx: ['class_declaration', 'class', 'abstract_class_declaration', 'enum_declaration'],
	go: ['type_declaration'],
	rust: ['struct_item', 'enum_item', 'impl_item'],
	java: ['class_declaration', 'enum_declaration'],
	c: ['struct_specifier'],
	cpp: ['class_specifier', 'struct_specifier'],
	csharp: ['class_declaration', 'enum_declaration', 'struct_declaration'],
	ruby: ['class', 'module'],
	kotlin: ['class_declaration', 'object_declaration'],
	php: ['class_declaration', 'enum_declaration', 'trait_declaration'],
	scala: ['class_definition', 'object_definition', 'enum_definition'],
};

export const TYPE_TYPES: Record<string, string[]> = {
	typescript: ['interface_declaration', 'type_alias_declaration'],
	tsx: ['interface_declaration', 'type_alias_declaration'],
	java: ['interface_declaration'],
	csharp: ['interface_declaration'],
	kotlin: ['interface_declaration'],
	php: ['interface_declaration'],
	scala: ['trait_definition'],
	rust: ['trait_item'],
};

export const FUNCTION_TYPES: Record<string, string[]> = {
	python: ['function_definition'],
	javascript: ['function_declaration', 'method_definition'],
	typescript: ['function_declaration', 'method_definition'],
	tsx: ['function_declaration', 'method_definition'],
	go: ['function_declaration', 'method_declaration'],
	rust: ['function_item'],
	java: ['method_declaration', 'constructor_declaration'],
	c: ['function_definition'],
	cpp: ['function_definition'],
	csharp: ['method_declaration', 'constructor_declaration'],
	ruby: ['method', 'singleton_method'],
	kotlin: ['function_declaration'],
	php: ['function_definition', 'method_declaration'],
	scala: ['function_definition', 'function_declaration'],
	bash: ['function_definition'],
};

export const IMPORT_TYPES: Record<string, string[]> = {
	python: ['import_statement', 'import_from_statement'],
	javascript: ['import_statement'],
	typescript: ['import_statement'],
	tsx: ['import_statement'],
	go: ['import_declaration'],
	rust: ['use_declaration'],
	java: ['import_declaration'],
	c: ['preproc_include'],
	cpp: ['preproc_include'],
	csharp: ['using_directive'],
	ruby: ['call'],
	kotlin: ['import_header'],
	php: ['namespace_use_declaration'],
	scala: ['import_declaration'],
};

const TEST_FILE_PATTERNS = [
	/test_.*\.py$/,
	/.*_test\.py$/,
	/.*\.test\.[jt]sx?$/,
	/.*\.spec\.[jt]sx?$/,
	/.*_test\.go$/,
	/tests?\//,
	/.*Test\.kt$/,
	/.*Test\.java$/,
	/__tests__\//,
];

const TEST_NAME_PATTERNS = [
	/^test_/,
	/^Test[A-Z]/,
	/_test$/,
];

const TEST_RUNNER_NAMES = new Set([
	'describe', 'it', 'test', 'suite',
	'beforeEach', 'afterEach', 'beforeAll', 'afterAll',
	'before', 'after', 'setup', 'teardown',
]);

const TEST_ANNOTATIONS = new Set([
	'test', 'tokio::test', 'async_std::test',
	'rstest', 'rstest::rstest', 'proptest',
]);

const BUN_TEST_IMPORT_PATTERN = /^\s*(?:import\b[^;'"`\n]*from\s+|import\s+)['"`]bun:test['"`]/m;

/**
 * Detects whether the given source contains a top-level import from `'bun:test'`.
 * Used to flag Bun-runtime test files that don't follow the path-based heuristics.
 */
export function isBunTestImport(source: string): boolean {
	return BUN_TEST_IMPORT_PATTERN.test(source);
}

export function isTestFile(filePath: string): boolean {
	return TEST_FILE_PATTERNS.some(p => p.test(filePath));
}

export function isTestFunction(name: string, filePath: string, annotations?: string[]): boolean {
	if (annotations && annotations.some(a => TEST_ANNOTATIONS.has(a))) return true;
	if (TEST_NAME_PATTERNS.some(p => p.test(name))) return true;
	if (isTestFile(filePath) && TEST_RUNNER_NAMES.has(name)) return true;
	return false;
}
