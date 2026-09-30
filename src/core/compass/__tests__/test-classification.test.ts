import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import { extractFile } from '../extractors/index';
import { setGrammarDir, getParser } from '../parser-manager';
import { isTestFile, isTestFunction } from '../extractors/lang-maps';
import { getAnnotations } from '../extractors/ast-helpers';
import type { TreeNode } from '../extractors/ast-helpers';

const FIXTURES = path.join(__dirname, 'fixtures');
const GRAMMARS = path.join(process.cwd(), 'resources', 'grammars');

beforeAll(() => {
	setGrammarDir(GRAMMARS);
});

describe('isTestFunction camelCase gating', () => {
	it('classifies camelCase test names inside test files', () => {
		expect(isTestFunction('testCreateTenant', 'tests/Unit/Services/Organization/FiwareTenantServiceTest.php')).toBe(true);
	});

	it('classifies digit-led camelCase test names inside test files', () => {
		expect(isTestFunction('test404Response', 'tests/Feature/HttpResponseTest.php')).toBe(true);
	});

	it('does not classify camelCase test names in production files', () => {
		expect(isTestFunction('testConnection', 'app/Services/DatabaseManager.php')).toBe(false);
	});

	it('does not classify lowercase continuations like tester inside test files', () => {
		expect(isTestFunction('tester', 'tests/Unit/FooTest.php')).toBe(false);
	});
});

describe('isTestFile new patterns', () => {
	const positives = [
		'app/Services/Organization/FiwareTenantServiceTest.php',
		'App/Services/TenantServiceTest.cs',
		'App/Services/TenantServiceTests.cs',
		'lib/models/user_spec.rb',
		'lib/models/user_test.rb',
		'spec/models/user.rb',
		'src/main/scala/TenantServiceTest.scala',
		'src/main/scala/TenantServiceSpec.scala',
	];

	for (const filePath of positives) {
		it(`matches ${filePath}`, () => {
			expect(isTestFile(filePath)).toBe(true);
		});
	}

	const negatives = [
		'app/Services/Organization/FiwareTenantService.php',
		'App/Services/TenantService.cs',
		'lib/models/user.rb',
		'src/main/scala/TenantService.scala',
	];

	for (const filePath of negatives) {
		it(`does not match ${filePath}`, () => {
			expect(isTestFile(filePath)).toBe(false);
		});
	}
});

describe('JUnit annotation classification (junit-annotations.java)', () => {
	it('classifies @Test method as Test', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'junit-annotations.java'), FIXTURES);
		const createsTenant = nodes.find(n => n.name === 'createsTenant');
		expect(createsTenant).toBeDefined();
		expect(createsTenant!.kind).toBe('Test');
		expect(createsTenant!.is_test).toBe(true);
	});

	it('classifies @ParameterizedTest and @RepeatedTest methods as Test', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'junit-annotations.java'), FIXTURES);
		const parameterized = nodes.find(n => n.name === 'handlesManyInputs');
		const repeated = nodes.find(n => n.name === 'retriesFlakyPath');
		expect(parameterized!.kind).toBe('Test');
		expect(repeated!.kind).toBe('Test');
	});

	it('leaves @Override and unannotated methods as Function', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'junit-annotations.java'), FIXTURES);
		const overridden = nodes.find(n => n.name === 'toString');
		const helper = nodes.find(n => n.name === 'helperMethod');
		expect(overridden!.kind).toBe('Function');
		expect(helper!.kind).toBe('Function');
	});
});

describe('JUnit annotation extraction (junit-annotations.kt)', () => {
	function collectByType(node: TreeNode, type: string, out: TreeNode[] = []): TreeNode[] {
		if (node.type === type) out.push(node);
		for (const child of node.namedChildren) collectByType(child, type, out);
		return out;
	}

	async function parseKotlinFunctions(): Promise<TreeNode[]> {
		const source = fs.readFileSync(path.join(FIXTURES, 'junit-annotations.kt'), 'utf8');
		const parser = await getParser('kotlin');
		const tree = parser.parse(source);
		return collectByType(tree.rootNode as unknown as TreeNode, 'function_declaration');
	}

	it('reads @Test and @ParameterizedTest from modifiers > annotation > user_type', async () => {
		const functions = await parseKotlinFunctions();
		expect(functions).toHaveLength(3);
		expect(getAnnotations(functions[0]!, 'kotlin')).toEqual(['Test']);
		expect(getAnnotations(functions[1]!, 'kotlin')).toEqual(['ParameterizedTest']);
	});

	it('returns no annotations for unannotated functions', async () => {
		const functions = await parseKotlinFunctions();
		expect(getAnnotations(functions[2]!, 'kotlin')).toEqual([]);
	});

	it('drives isTestFunction for kotlin annotations', async () => {
		const functions = await parseKotlinFunctions();
		const productionPath = 'src/main/kotlin/TenantServiceCheck.kt';
		expect(isTestFunction('createsTenant', productionPath, getAnnotations(functions[0]!, 'kotlin'))).toBe(true);
		expect(isTestFunction('helperMethod', productionPath, getAnnotations(functions[2]!, 'kotlin'))).toBe(false);
	});
});

describe('xUnit/MSTest attribute classification (xunit-attributes.cs)', () => {
	it('classifies [Fact] method as Test', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'xunit-attributes.cs'), FIXTURES);
		const fact = nodes.find(n => n.name === 'CreatesTenant');
		expect(fact).toBeDefined();
		expect(fact!.kind).toBe('Test');
		expect(fact!.is_test).toBe(true);
	});

	it('classifies [Theory] method as Test', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'xunit-attributes.cs'), FIXTURES);
		const theory = nodes.find(n => n.name === 'HandlesManyInputs');
		expect(theory!.kind).toBe('Test');
	});

	it('classifies [TestMethod] method as Test', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'xunit-attributes.cs'), FIXTURES);
		const msTest = nodes.find(n => n.name === 'RunsUnderMsTest');
		expect(msTest!.kind).toBe('Test');
	});

	it('leaves [Obsolete] method as Function', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'xunit-attributes.cs'), FIXTURES);
		const helper = nodes.find(n => n.name === 'HelperMethod');
		expect(helper!.kind).toBe('Function');
	});
});

describe('PHPUnit attribute classification (phpunit-attributes.php)', () => {
	it('classifies #[Test] method as Test', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'phpunit-attributes.php'), FIXTURES);
		const createsTenant = nodes.find(n => n.name === 'createsTenant');
		expect(createsTenant).toBeDefined();
		expect(createsTenant!.kind).toBe('Test');
		expect(createsTenant!.is_test).toBe(true);
	});

	it('classifies fully-qualified #[\\PHPUnit\\Framework\\Attributes\\Test] method as Test', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'phpunit-attributes.php'), FIXTURES);
		const removesTenant = nodes.find(n => n.name === 'removesTenant');
		expect(removesTenant!.kind).toBe('Test');
	});

	it('classifies grouped #[DataProvider(...), Test] method as Test', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'phpunit-attributes.php'), FIXTURES);
		const updatesTenant = nodes.find(n => n.name === 'updatesTenant');
		expect(updatesTenant!.kind).toBe('Test');
	});

	it('leaves unattributed method as Function', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'phpunit-attributes.php'), FIXTURES);
		const helper = nodes.find(n => n.name === 'helperMethod');
		expect(helper!.kind).toBe('Function');
	});
});

describe('PHPUnit camelCase classification (TenantServiceTest.php)', () => {
	it('flags *Test.php as a test file', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'TenantServiceTest.php'), FIXTURES);
		const fileNode = nodes.find(n => n.kind === 'File');
		expect(fileNode!.is_test).toBe(true);
	});

	it('classifies testCreateTenant inside a *Test.php file as Test', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'TenantServiceTest.php'), FIXTURES);
		const testMethod = nodes.find(n => n.name === 'testCreateTenant');
		expect(testMethod).toBeDefined();
		expect(testMethod!.kind).toBe('Test');
		expect(testMethod!.is_test).toBe(true);
	});

	it('leaves non-test-prefixed helper as Function', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'TenantServiceTest.php'), FIXTURES);
		const helper = nodes.find(n => n.name === 'buildTenant');
		expect(helper!.kind).toBe('Function');
	});
});

describe('annotation modifiers use native per-language syntax', () => {
	it('keeps java @Test annotations native and does not append rust-style attributes', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'junit-annotations.java'), FIXTURES);
		const createsTenant = nodes.find(n => n.name === 'createsTenant');
		expect(createsTenant!.modifiers).toContain('@Test');
		expect(createsTenant!.modifiers).not.toContain('#[');
	});

	it('formats csharp attributes with bracket syntax, not rust hash-bracket', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'xunit-attributes.cs'), FIXTURES);
		const fact = nodes.find(n => n.name === 'CreatesTenant');
		expect(fact!.modifiers).toContain('[Fact]');
		expect(fact!.modifiers).not.toContain('#[');
	});

	it('keeps php attribute hash-bracket syntax', async () => {
		const { nodes } = await extractFile(path.join(FIXTURES, 'phpunit-attributes.php'), FIXTURES);
		const createsTenant = nodes.find(n => n.name === 'createsTenant');
		expect(createsTenant!.modifiers).toContain('#[Test]');
	});
});
