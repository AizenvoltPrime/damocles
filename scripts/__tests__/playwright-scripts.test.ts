import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..', '..');
const { program } = createRequire(import.meta.url)('playwright-core/lib/utilsBundle') as {
  program: { createCommand(name: string): PlaywrightTestCommand };
};

interface PlaywrightTestCommand {
  argument(spec: string): PlaywrightTestCommand;
  option(flags: string): PlaywrightTestCommand;
  exitOverride(): PlaywrightTestCommand;
  action(fn: () => void): PlaywrightTestCommand;
  parse(argv: readonly string[], options: { from: 'user' }): void;
  opts(): { project?: string[] };
  readonly args: string[];
}

/** `playwright test`'s project and test-filter options as Playwright's CLI declares them (playwright/lib/program.js), read by its own bundled parser. */
function parsePlaywrightTest(argv: readonly string[]): { projects: string[] | undefined; filters: string[] } {
  const command = program.createCommand('test')
    .argument('[test-filter...]')
    .option('-c, --config <file>')
    .option('--project <project-name...>')
    .exitOverride()
    .action(() => undefined);
  command.parse(argv, { from: 'user' });
  return { projects: command.opts().project, filters: command.args };
}

/** Each package.json script's `playwright test` step, split as the shell splits it. */
function playwrightScripts(): Array<[string, string[]]> {
  const { scripts } = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  return Object.entries(scripts).flatMap(([name, script]) => {
    const step = script.split(' && ').find((part) => part.startsWith('playwright test '));
    return step === undefined ? [] : [[name, step.split(' ').slice(2)] as [string, string[]]];
  });
}

describe('the package.json Playwright scripts', () => {
  it('lists the scripts it checks', () => {
    expect(playwrightScripts().map(([name]) => name)).toEqual(['test:desktop', 'test:desktop:packaged']);
  });

  // npm appends `npm run <script> -- <args>` to the script's last command, after its --project
  it.each(playwrightScripts())('%s keeps a spec given after -- a test filter, not a project', (_name, args) => {
    const parsed = parsePlaywrightTest([...args, 'e2e/desktop/loopback-core.spec.ts']);
    expect(parsed.projects).toHaveLength(1);
    expect(parsed.filters).toEqual(['e2e/desktop/loopback-core.spec.ts']);
  });
});
