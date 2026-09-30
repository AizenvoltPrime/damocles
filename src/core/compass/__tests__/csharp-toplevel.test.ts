import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { extractFile } from '../extractors';
import { setGrammarDir } from '../parser-manager';

const GRAMMARS = path.join(process.cwd(), 'resources', 'grammars');

beforeAll(() => {
	setGrammarDir(GRAMMARS);
});

describe('C# using directive extraction', () => {
	it('extracts using directives from a class-based .cs file', async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-class-'));
		const file = path.join(tmp, 'Foo.cs');
		fs.writeFileSync(file, `using System;
using System.Collections.Generic;
using Microsoft.Extensions.Logging;

namespace MyApp
{
    public class Foo
    {
        public void Bar() { }
    }
}
`);
		const result = await extractFile(file, tmp);
		const imports = result.edges.filter(e => e.kind === 'IMPORTS_FROM').map(e => e.target);
		expect(imports).toContain('System');
		expect(imports).toContain('System.Collections.Generic');
		expect(imports).toContain('Microsoft.Extensions.Logging');
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	it('extracts using directives from a top-level-statements Program.cs', async () => {
		const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-tls-'));
		const file = path.join(tmp, 'Program.cs');
		fs.writeFileSync(file, `using Microsoft.Extensions.Logging;
using Serilog;

var builder = WebApplication.CreateBuilder(args);
Log.Logger = new LoggerConfiguration().CreateLogger();
builder.Host.UseSerilog();
var app = builder.Build();
app.Run();
`);
		const result = await extractFile(file, tmp);
		const imports = result.edges.filter(e => e.kind === 'IMPORTS_FROM').map(e => e.target);
		expect(imports).toContain('Microsoft.Extensions.Logging');
		expect(imports).toContain('Serilog');
		fs.rmSync(tmp, { recursive: true, force: true });
	});
});
