import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { extractFile } from '../extractors';
import type { ExtractionResult } from '../extractor-base';
import { setGrammarDir } from '../parser-manager';

const FIXTURES = path.join(__dirname, 'fixtures');
const GRAMMARS = path.join(process.cwd(), 'resources', 'grammars');

const FILE_PHP = path.join(FIXTURES, 'sample_gaps.php').replace(/\\/g, '/');
const FILE_CS = path.join(FIXTURES, 'sample_gaps.cs').replace(/\\/g, '/');
const FILE_RB = path.join(FIXTURES, 'sample_gaps.rb').replace(/\\/g, '/');
const FILE_KT = path.join(FIXTURES, 'sample_gaps.kt').replace(/\\/g, '/');
const FILE_GO = path.join(FIXTURES, 'sample_gaps.go').replace(/\\/g, '/');
const FILE_JAVA = path.join(FIXTURES, 'sample_gaps.java').replace(/\\/g, '/');
const FILE_TS = path.join(FIXTURES, 'sample_gaps.ts').replace(/\\/g, '/');
const FILE_CPP = path.join(FIXTURES, 'sample_gaps.cpp').replace(/\\/g, '/');
const FILE_RS = path.join(FIXTURES, 'sample_gaps.rs').replace(/\\/g, '/');
const FILE_SCALA = path.join(FIXTURES, 'sample_gaps.scala').replace(/\\/g, '/');
const FILE_PY = path.join(FIXTURES, 'sample_gaps.py').replace(/\\/g, '/');

beforeAll(() => {
	setGrammarDir(GRAMMARS);
});

function callTargets(result: ExtractionResult, source: string): Set<string> {
	return new Set(result.edges.filter(e => e.kind === 'CALLS' && e.source === source).map(e => e.target));
}

function refTargets(result: ExtractionResult, source: string): Set<string> {
	return new Set(result.edges.filter(e => e.kind === 'REFERENCES' && e.source === source).map(e => e.target));
}

describe('PHP scoped calls, instantiation, ::class (sample_gaps.php)', () => {
	const RESOLVE = `${FILE_PHP}::FiwareTenantService::resolveTenant`;

	it('emits scoped CALLS target Scope::method for OrganizationContext::get()', async () => {
		const result = await extractFile(FILE_PHP, FIXTURES);
		expect(callTargets(result, RESOLVE).has('OrganizationContext::get')).toBe(true);
	});

	it('emits CALLS to the class for new FiwareTenantService($ctx)', async () => {
		const result = await extractFile(FILE_PHP, FIXTURES);
		expect(callTargets(result, RESOLVE).has(`${FILE_PHP}::FiwareTenantService`)).toBe(true);
	});

	it('strips the namespace from scoped targets: Foo\\Bar::baz() -> Bar::baz', async () => {
		const result = await extractFile(FILE_PHP, FIXTURES);
		expect(callTargets(result, RESOLVE).has('Bar::baz')).toBe(true);
	});

	it('keeps self::make() as a bare method target (never self::make)', async () => {
		const result = await extractFile(FILE_PHP, FIXTURES);
		const targets = callTargets(result, RESOLVE);
		expect(targets.has(`${FILE_PHP}::FiwareTenantService::make`)).toBe(true);
		expect([...targets].some(t => t.includes('self::') || t.includes('static::') || t.includes('parent::'))).toBe(false);
	});

	it('emits nothing for dynamic instantiation new $cls()', async () => {
		const result = await extractFile(FILE_PHP, FIXTURES);
		const targets = callTargets(result, RESOLVE);
		expect(targets).toEqual(new Set([
			'OrganizationContext::get',
			`${FILE_PHP}::FiwareTenantService`,
			'Bar::baz',
			`${FILE_PHP}::FiwareTenantService::make`,
		]));
	});

	it('emits REFERENCES for the scoped-call receiver (the OrganizationContext failure case)', async () => {
		const result = await extractFile(FILE_PHP, FIXTURES);
		const refs = refTargets(result, RESOLVE);
		expect(refs.has('OrganizationContext')).toBe(true);
		expect(refs.has('Bar')).toBe(true);
	});

	it('emits REFERENCES for Foo::class constant access', async () => {
		const result = await extractFile(FILE_PHP, FIXTURES);
		expect(refTargets(result, RESOLVE).has('TenantGate')).toBe(true);
	});
});

describe('C# member invocations and object creation (sample_gaps.cs)', () => {
	const RUN = `${FILE_CS}::GapService::Run`;

	it('emits CALLS for object creation including generic and qualified types', async () => {
		const result = await extractFile(FILE_CS, FIXTURES);
		const targets = callTargets(result, RUN);
		expect(targets.has(`${FILE_CS}::GapWidget`)).toBe(true);
		expect(targets.has('Box')).toBe(true);
		expect(targets.has('Inner')).toBe(true);
	});

	it('emits CALLS for member and plain invocations', async () => {
		const result = await extractFile(FILE_CS, FIXTURES);
		const targets = callTargets(result, RUN);
		expect(targets.has(`${FILE_CS}::GapWidget::Render`)).toBe(true);
		expect(targets.has('Lookup')).toBe(true);
		expect(targets.has(`${FILE_CS}::GapService::LocalHelper`)).toBe(true);
	});

	it('emits REFERENCES for capitalized receivers only', async () => {
		const result = await extractFile(FILE_CS, FIXTURES);
		const refs = refTargets(result, RUN);
		expect(refs.has('Registry')).toBe(true);
		expect(refs.has('widget')).toBe(false);
	});
});

describe('Ruby method-field calls and Foo.new (sample_gaps.rb)', () => {
	const FETCH = `${FILE_RB}::GapClient::fetch`;

	it('targets the class for GapService.new', async () => {
		const result = await extractFile(FILE_RB, FIXTURES);
		expect(callTargets(result, FETCH).has(`${FILE_RB}::GapService`)).toBe(true);
	});

	it('emits CALLS for member, scoped, and bare invocations', async () => {
		const result = await extractFile(FILE_RB, FIXTURES);
		const targets = callTargets(result, FETCH);
		expect(targets.has(`${FILE_RB}::GapService::submit`)).toBe(true);
		expect(targets.has('lookup')).toBe(true);
		expect(targets.has('Portal::open')).toBe(true);
		expect(targets.has(`${FILE_RB}::GapClient::local_helper`)).toBe(true);
	});

	it('never targets `new` itself, even for variable receivers (factory.new)', async () => {
		const result = await extractFile(FILE_RB, FIXTURES);
		const targets = callTargets(result, FETCH);
		expect([...targets].some(t => t === 'new' || t.endsWith('::new'))).toBe(false);
	});

	it('emits unconditional REFERENCES for constant and scope_resolution receivers', async () => {
		const result = await extractFile(FILE_RB, FIXTURES);
		const refs = refTargets(result, FETCH);
		expect(refs.has(`${FILE_RB}::GapService`)).toBe(true);
		expect(refs.has('Registry')).toBe(true);
		expect(refs.has('Portal')).toBe(true);
	});
});

describe('Kotlin declaration names and calls (sample_gaps.kt)', () => {
	it('extracts class, object, and function names from the fwcd grammar', async () => {
		const result = await extractFile(FILE_KT, FIXTURES);
		const names = new Set(result.nodes.map(n => n.name));
		expect(names.has('GapWidget')).toBe(true);
		expect(names.has('GapService')).toBe(true);
		expect(names.has('Registry')).toBe(true);
		expect(names.has('render')).toBe(true);
		expect(names.has('transform')).toBe(true);
		expect(names.has('lookup')).toBe(true);
		expect(names.has('helperFun')).toBe(true);
	});

	it('emits CALLS for constructor, navigation, and bare invocations', async () => {
		const result = await extractFile(FILE_KT, FIXTURES);
		const targets = callTargets(result, `${FILE_KT}::GapWidget::render`);
		expect(targets.has(`${FILE_KT}::GapService`)).toBe(true);
		expect(targets.has(`${FILE_KT}::GapService::transform`)).toBe(true);
		expect(targets.has(`${FILE_KT}::Registry::lookup`)).toBe(true);
		expect(targets.has(`${FILE_KT}::helperFun`)).toBe(true);
	});

	it('emits REFERENCES for capitalized navigation receivers only', async () => {
		const result = await extractFile(FILE_KT, FIXTURES);
		const refs = refTargets(result, `${FILE_KT}::GapWidget::render`);
		expect(refs.has(`${FILE_KT}::Registry`)).toBe(true);
		expect(refs.has('service')).toBe(false);
	});
});

describe('Go selector calls and composite literals (sample_gaps.go)', () => {
	const BUILD = `${FILE_GO}::buildWidget`;

	it('emits CALLS for selector_expression method calls', async () => {
		const result = await extractFile(FILE_GO, FIXTURES);
		const targets = callTargets(result, BUILD);
		expect(targets.has(`${FILE_GO}::GapWidget::Render`)).toBe(true);
		expect(targets.has(`${FILE_GO}::gapHelper`)).toBe(true);
	});

	it('emits REFERENCES (not CALLS) for composite literals including &T{} and qualified types', async () => {
		const result = await extractFile(FILE_GO, FIXTURES);
		const refs = refTargets(result, BUILD);
		expect(refs.has(`${FILE_GO}::GapWidget`)).toBe(true);
		expect(refs.has('Item')).toBe(true);
		expect(callTargets(result, BUILD).has(`${FILE_GO}::GapWidget`)).toBe(false);
	});
});

describe('Java object creation and receivers (sample_gaps.java)', () => {
	const RUN = `${FILE_JAVA}::GapService::run`;

	it('emits CALLS for new T() and new Generic<T>()', async () => {
		const result = await extractFile(FILE_JAVA, FIXTURES);
		const targets = callTargets(result, RUN);
		expect(targets.has(`${FILE_JAVA}::GapWidget`)).toBe(true);
		expect(targets.has('Box')).toBe(true);
	});

	it('keeps existing method_invocation behavior intact', async () => {
		const result = await extractFile(FILE_JAVA, FIXTURES);
		const targets = callTargets(result, RUN);
		expect(targets.has(`${FILE_JAVA}::GapWidget::render`)).toBe(true);
		expect(targets.has('lookup')).toBe(true);
		expect(targets.has(`${FILE_JAVA}::GapService::localHelper`)).toBe(true);
	});

	it('emits REFERENCES for capitalized receivers only', async () => {
		const result = await extractFile(FILE_JAVA, FIXTURES);
		const refs = refTargets(result, RUN);
		expect(refs.has('Registry')).toBe(true);
		expect(refs.has('widget')).toBe(false);
	});
});

describe('TypeScript new_expression and receivers (sample_gaps.ts)', () => {
	const BUILD = `${FILE_TS}::buildAll`;

	it('emits CALLS for new Identifier() and new ns.Member()', async () => {
		const result = await extractFile(FILE_TS, FIXTURES);
		const targets = callTargets(result, BUILD);
		expect(targets.has(`${FILE_TS}::GapWidget`)).toBe(true);
		expect(targets.has('Service')).toBe(true);
	});

	it('keeps member-call extraction intact', async () => {
		const result = await extractFile(FILE_TS, FIXTURES);
		const targets = callTargets(result, BUILD);
		expect(targets.has(`${FILE_TS}::GapWidget::render`)).toBe(true);
		expect(targets.has('lookup')).toBe(true);
	});

	it('emits REFERENCES for capitalized receivers only', async () => {
		const result = await extractFile(FILE_TS, FIXTURES);
		const refs = refTargets(result, BUILD);
		expect(refs.has('Registry')).toBe(true);
		expect(refs.has('ns')).toBe(false);
	});
});

describe('C++ qualified calls and new expressions (sample_gaps.cpp)', () => {
	const RUN = `${FILE_CPP}::runAll`;

	it('emits CALLS for new T() and new ns::T()', async () => {
		const result = await extractFile(FILE_CPP, FIXTURES);
		const targets = callTargets(result, RUN);
		expect(targets.has(`${FILE_CPP}::GapWidget`)).toBe(true);
		expect(targets.has('Tracker')).toBe(true);
	});

	it('emits scoped CALLS target for Foo::bar() and keeps field calls bare', async () => {
		const result = await extractFile(FILE_CPP, FIXTURES);
		const targets = callTargets(result, RUN);
		expect(targets.has('GapWidget::spawnCount')).toBe(true);
		expect(targets.has(`${FILE_CPP}::render`)).toBe(true);
		expect(targets.has(`${FILE_CPP}::helperFun`)).toBe(true);
	});

	it('emits unconditional REFERENCES for the :: scope', async () => {
		const result = await extractFile(FILE_CPP, FIXTURES);
		expect(refTargets(result, RUN).has(`${FILE_CPP}::GapWidget`)).toBe(true);
	});
});

describe('Rust scoped paths and struct expressions (sample_gaps.rs)', () => {
	const BUILD = `${FILE_RS}::build_all`;

	it('emits scoped CALLS targets for path calls, stripped to the last path segment', async () => {
		const result = await extractFile(FILE_RS, FIXTURES);
		const targets = callTargets(result, BUILD);
		expect(targets.has('GapWidget::new')).toBe(true);
		expect(targets.has('GapWidget::fresh')).toBe(true);
		expect(targets.has('Tracker::create')).toBe(true);
		expect(targets.has(`${FILE_RS}::GapWidget::render`)).toBe(true);
	});

	it('treats Self:: as a relative scope with a bare method target', async () => {
		const result = await extractFile(FILE_RS, FIXTURES);
		const fresh = callTargets(result, `${FILE_RS}::GapWidget::fresh`);
		expect(fresh.has(`${FILE_RS}::GapWidget::new`)).toBe(true);
		const all = result.edges.filter(e => e.kind === 'CALLS').map(e => e.target);
		expect(all.some(t => t.includes('Self::'))).toBe(false);
	});

	it('emits REFERENCES (not CALLS) for struct expressions and path receivers', async () => {
		const result = await extractFile(FILE_RS, FIXTURES);
		const refs = refTargets(result, BUILD);
		expect(refs.has(`${FILE_RS}::GapWidget`)).toBe(true);
		expect(refs.has('Tracker')).toBe(true);
		expect(callTargets(result, BUILD).has(`${FILE_RS}::GapWidget`)).toBe(false);
	});
});

describe('Scala instance expressions and receivers (sample_gaps.scala)', () => {
	const RUN = `${FILE_SCALA}::GapRunner::runAll`;

	it('emits CALLS for new Foo() via the nested call expression', async () => {
		const result = await extractFile(FILE_SCALA, FIXTURES);
		const targets = callTargets(result, RUN);
		expect(targets.has(`${FILE_SCALA}::GapWidget`)).toBe(true);
		expect(targets.has(`${FILE_SCALA}::GapWidget::render`)).toBe(true);
		expect(targets.has('lookup')).toBe(true);
		expect(targets.has(`${FILE_SCALA}::GapRunner::localHelper`)).toBe(true);
	});

	it('emits CALLS for bare new Foo without parentheses', async () => {
		const result = await extractFile(FILE_SCALA, FIXTURES);
		const bare = callTargets(result, `${FILE_SCALA}::GapRunner::buildBare`);
		expect(bare.has(`${FILE_SCALA}::GapWidget`)).toBe(true);
	});

	it('emits REFERENCES for capitalized receivers only', async () => {
		const result = await extractFile(FILE_SCALA, FIXTURES);
		const refs = refTargets(result, RUN);
		expect(refs.has('Registry')).toBe(true);
		expect(refs.has('widget')).toBe(false);
	});
});

describe('Python attribute receivers (sample_gaps.py)', () => {
	const RUN = `${FILE_PY}::run_all`;

	it('keeps attribute-call extraction intact', async () => {
		const result = await extractFile(FILE_PY, FIXTURES);
		const targets = callTargets(result, RUN);
		expect(targets.has(`${FILE_PY}::GapRegistry::lookup`)).toBe(true);
		expect(targets.has(`${FILE_PY}::helper_fn`)).toBe(true);
	});

	it('emits REFERENCES for capitalized attribute receivers', async () => {
		const result = await extractFile(FILE_PY, FIXTURES);
		expect(refTargets(result, RUN).has(`${FILE_PY}::GapRegistry`)).toBe(true);
	});
});
