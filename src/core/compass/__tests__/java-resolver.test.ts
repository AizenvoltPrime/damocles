import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { JavaResolver, normalizeJavaSpec, isJavaWildcardImport } from '../java-resolver';

let mavenDir: string;
let gradleDir: string;
let unrelatedDir: string;

beforeAll(() => {
	mavenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'java-maven-'));
	gradleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'java-gradle-'));
	unrelatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'java-unrelated-'));

	fs.mkdirSync(path.join(mavenDir, 'src', 'main', 'java', 'com', 'example', 'auth'), { recursive: true });
	fs.writeFileSync(
		path.join(mavenDir, 'src', 'main', 'java', 'com', 'example', 'auth', 'User.java'),
		'package com.example.auth;\npublic class User {}',
	);
	fs.mkdirSync(path.join(mavenDir, 'src', 'test', 'java', 'com', 'example'), { recursive: true });
	fs.writeFileSync(
		path.join(mavenDir, 'src', 'test', 'java', 'com', 'example', 'UserTest.java'),
		'package com.example;\npublic class UserTest {}',
	);

	fs.mkdirSync(path.join(gradleDir, 'app', 'src', 'main', 'java', 'org', 'sample'), { recursive: true });
	fs.writeFileSync(
		path.join(gradleDir, 'app', 'src', 'main', 'java', 'org', 'sample', 'Util.java'),
		'package org.sample;\npublic class Util {}',
	);

	fs.mkdirSync(path.join(unrelatedDir, 'lib'), { recursive: true });
	fs.writeFileSync(path.join(unrelatedDir, 'lib', 'something.java'), '');
});

afterAll(() => {
	fs.rmSync(mavenDir, { recursive: true, force: true });
	fs.rmSync(gradleDir, { recursive: true, force: true });
	fs.rmSync(unrelatedDir, { recursive: true, force: true });
});

describe('JavaResolver Maven layout (src/main/java)', () => {
	it('resolves dotted import to absolute file path', () => {
		const resolver = new JavaResolver();
		const sourceFile = path.join(mavenDir, 'src', 'main', 'java', 'com', 'example', 'auth', 'User.java');
		const result = resolver.resolveImport('com.example.auth.User', sourceFile);
		expect(result).not.toBeNull();
		expect(result!.replace(/\\/g, '/')).toContain('src/main/java/com/example/auth/User.java');
	});

	it('resolves from a sibling source file in the same project', () => {
		const resolver = new JavaResolver();
		const sourceFile = path.join(mavenDir, 'src', 'main', 'java', 'com', 'example', 'auth', 'User.java');
		const result = resolver.resolveImport('com.example.UserTest', sourceFile);
		expect(result).not.toBeNull();
		expect(result!.replace(/\\/g, '/')).toContain('src/test/java/com/example/UserTest.java');
	});
});

describe('JavaResolver Gradle layout (app/src/main/java)', () => {
	it('resolves through the Gradle Android-style source root', () => {
		const resolver = new JavaResolver();
		const sourceFile = path.join(gradleDir, 'app', 'src', 'main', 'java', 'org', 'sample', 'Util.java');
		const result = resolver.resolveImport('org.sample.Util', sourceFile);
		expect(result).not.toBeNull();
		expect(result!.replace(/\\/g, '/')).toContain('app/src/main/java/org/sample/Util.java');
	});
});

describe('JavaResolver missing file', () => {
	it('returns null when the dotted spec does not map to any file', () => {
		const resolver = new JavaResolver();
		const sourceFile = path.join(mavenDir, 'src', 'main', 'java', 'com', 'example', 'auth', 'User.java');
		expect(resolver.resolveImport('com.example.missing.NotHere', sourceFile)).toBeNull();
	});

	it('returns null when no Maven/Gradle source root is discoverable', () => {
		const resolver = new JavaResolver();
		const sourceFile = path.join(unrelatedDir, 'lib', 'something.java');
		expect(resolver.resolveImport('com.example.auth.User', sourceFile)).toBeNull();
	});
});

describe('JavaResolver wildcard handling', () => {
	it('returns null for wildcard imports', () => {
		const resolver = new JavaResolver();
		const sourceFile = path.join(mavenDir, 'src', 'main', 'java', 'com', 'example', 'auth', 'User.java');
		expect(resolver.resolveImport('com.example.auth.*', sourceFile)).toBeNull();
	});

	it('isJavaWildcardImport detects trailing .*', () => {
		expect(isJavaWildcardImport('java.util.*')).toBe(true);
		expect(isJavaWildcardImport('import java.util.*;')).toBe(true);
		expect(isJavaWildcardImport('import static java.util.Map.*;')).toBe(true);
		expect(isJavaWildcardImport('java.util.List')).toBe(false);
	});
});

describe('JavaResolver static-import handling', () => {
	it('resolves static imports by stripping the trailing member', () => {
		const mapDir = path.join(mavenDir, 'src', 'main', 'java', 'java', 'util');
		fs.mkdirSync(mapDir, { recursive: true });
		const mapFile = path.join(mapDir, 'Map.java');
		fs.writeFileSync(mapFile, 'package java.util;\npublic class Map {}');
		try {
			const resolver = new JavaResolver();
			const sourceFile = path.join(mavenDir, 'src', 'main', 'java', 'com', 'example', 'auth', 'User.java');
			const result = resolver.resolveImport('static java.util.Map.entry', sourceFile);
			expect(result).not.toBeNull();
			expect(result!.replace(/\\/g, '/')).toContain('src/main/java/java/util/Map.java');
		} finally {
			fs.rmSync(mapFile, { force: true });
		}
	});

	it('returns null for static wildcard imports', () => {
		const resolver = new JavaResolver();
		const sourceFile = path.join(mavenDir, 'src', 'main', 'java', 'com', 'example', 'auth', 'User.java');
		expect(resolver.resolveImport('static java.util.Map.*', sourceFile)).toBeNull();
	});
});

describe('JavaResolver multi-module', () => {
	it('resolves cross-module imports by accumulating source roots up to workspace root', () => {
		const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-multi-'));
		try {
			fs.mkdirSync(path.join(repoRoot, 'moduleA', 'src', 'main', 'java', 'com', 'a'), { recursive: true });
			fs.mkdirSync(path.join(repoRoot, 'moduleB', 'src', 'main', 'java', 'com', 'b'), { recursive: true });
			fs.writeFileSync(
				path.join(repoRoot, 'moduleA', 'src', 'main', 'java', 'com', 'a', 'Caller.java'),
				'package com.a;\npublic class Caller {}',
			);
			fs.writeFileSync(
				path.join(repoRoot, 'moduleB', 'src', 'main', 'java', 'com', 'b', 'Helper.java'),
				'package com.b;\npublic class Helper {}',
			);

			const sourceFile = path.join(repoRoot, 'moduleA', 'src', 'main', 'java', 'com', 'a', 'Caller.java');
			const resolver = new JavaResolver(repoRoot);
			const result = resolver.resolveImport('com.b.Helper', sourceFile);

			expect(result).not.toBeNull();
			expect(result!.replace(/\\/g, '/')).toContain('moduleB/src/main/java/com/b/Helper.java');
		} finally {
			fs.rmSync(repoRoot, { recursive: true, force: true });
		}
	});
});

describe('JavaResolver normalizeJavaSpec', () => {
	it('strips import keyword and trailing semicolon', () => {
		expect(normalizeJavaSpec('import com.example.auth.User;')).toBe('com.example.auth.User');
	});

	it('strips static prefix and trailing member', () => {
		expect(normalizeJavaSpec('import static java.util.Map.entry;')).toBe('java.util.Map');
	});

	it('returns null for wildcard imports', () => {
		expect(normalizeJavaSpec('import java.util.*;')).toBeNull();
		expect(normalizeJavaSpec('import static java.util.Map.*;')).toBeNull();
	});
});

describe('JavaResolver workspace-root bounds', () => {
	it('admits targets that stay inside the workspace root', () => {
		const escapeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-escape-'));
		try {
			fs.mkdirSync(path.join(escapeRoot, 'workspace', 'src', 'main', 'java', 'com', 'example'), { recursive: true });
			fs.writeFileSync(
				path.join(escapeRoot, 'workspace', 'src', 'main', 'java', 'com', 'example', 'Inside.java'),
				'package com.example;\npublic class Inside {}',
			);

			const sourceFile = path.join(escapeRoot, 'workspace', 'src', 'main', 'java', 'com', 'example', 'Inside.java');

			const unconstrained = new JavaResolver();
			expect(unconstrained.resolveImport('com.example.Inside', sourceFile)).not.toBeNull();

			const constrained = new JavaResolver(path.join(escapeRoot, 'workspace'));
			expect(constrained.resolveImport('com.example.Inside', sourceFile)).not.toBeNull();
		} finally {
			fs.rmSync(escapeRoot, { recursive: true, force: true });
		}
	});

	it('blocks targets whose resolved candidate sits outside a constrained workspace', () => {
		const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-multimodule-'));
		try {
			const javaRoot = path.join(projectRoot, 'src', 'main', 'java');
			fs.mkdirSync(path.join(javaRoot, 'com', 'inner'), { recursive: true });
			fs.mkdirSync(path.join(javaRoot, 'com', 'outside'), { recursive: true });
			fs.writeFileSync(
				path.join(javaRoot, 'com', 'inner', 'A.java'),
				'package com.inner;\npublic class A {}',
			);
			fs.writeFileSync(
				path.join(javaRoot, 'com', 'outside', 'Y.java'),
				'package com.outside;\npublic class Y {}',
			);

			const sourceFile = path.join(javaRoot, 'com', 'inner', 'A.java');
			const constrainedWorkspace = path.join(javaRoot, 'com', 'inner');

			const unconstrained = new JavaResolver();
			expect(unconstrained.resolveImport('com.outside.Y', sourceFile)).not.toBeNull();

			const constrained = new JavaResolver(constrainedWorkspace);
			expect(constrained.resolveImport('com.outside.Y', sourceFile)).toBeNull();
		} finally {
			fs.rmSync(projectRoot, { recursive: true, force: true });
		}
	});

	it('blocks symlinks whose realpath escapes the workspace root', () => {
		const escapeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'java-symlink-escape-'));
		const workspace = path.join(escapeRoot, 'workspace');
		const insideDir = path.join(workspace, 'src', 'main', 'java', 'com', 'foo');
		const escapeTargetDir = path.join(escapeRoot, 'escape-target');
		const escapeTargetFile = path.join(escapeTargetDir, 'Outside.java');
		const symlinkPath = path.join(insideDir, 'Outside.java');
		const aFile = path.join(insideDir, 'A.java');

		try {
			fs.mkdirSync(insideDir, { recursive: true });
			fs.mkdirSync(escapeTargetDir, { recursive: true });
			fs.writeFileSync(aFile, 'package com.foo;\npublic class A {}');
			fs.writeFileSync(escapeTargetFile, 'package com.foo;\npublic class Outside {}');

			let symlinkSupported = true;
			try {
				fs.symlinkSync(escapeTargetFile, symlinkPath);
			} catch (err) {
				console.warn(`Skipping symlink-escape test: symlink creation failed (${(err as Error).message})`);
				symlinkSupported = false;
			}
			if (!symlinkSupported) return;

			const constrained = new JavaResolver(workspace);
			const result = constrained.resolveImport('com.foo.Outside', aFile);

			expect(result).toBeNull();
			expect(result).not.toBe(symlinkPath);
		} finally {
			fs.rmSync(escapeRoot, { recursive: true, force: true });
		}
	});
});
